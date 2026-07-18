import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, Payment, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  computeEffectivePaid,
  computeReturnedAmount,
  derivePaymentStatus,
  isEffectivePayment,
} from '../common/utils/invoice-financials';

type TransactionClient = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  private validateChequeFields(dto: {
    mode: string;
    bankName?: string;
    chequeNumber?: string;
    chequeDate?: string;
    collectedDate?: string;
  }) {
    if (dto.mode !== 'CHEQUE') return;
    if (!dto.bankName || !dto.chequeNumber || !dto.chequeDate || !dto.collectedDate) {
      throw new BadRequestException(
        'Bank name, cheque number, cheque date, and collected date are all required for cheque payments',
      );
    }
    if (new Date(dto.collectedDate) > new Date()) {
      throw new BadRequestException('Collected date cannot be in the future');
    }
  }

  /**
   * Recomputes an invoice's paymentStatus from its current payment rows —
   * safe to call after any create/edit/delete/status-change since it reads
   * the post-change state directly rather than applying a delta. Compares
   * against grandTotal minus any returned goods, not the raw grandTotal —
   * a return lowers what's actually still owed on this invoice.
   */
  private async recomputeInvoicePaymentStatus(
    tx: TransactionClient,
    invoiceId: string,
  ) {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    });
    const payments = await tx.payment.findMany({ where: { invoiceId } });
    const effectivePaid = computeEffectivePaid(payments);
    const returnedAmount = await computeReturnedAmount(tx, invoice.orderId);
    const netGrandTotal = invoice.grandTotal.sub(returnedAmount);

    const paymentStatus = derivePaymentStatus(effectivePaid, netGrandTotal);

    await tx.invoice.update({ where: { id: invoiceId }, data: { paymentStatus } });
    return paymentStatus;
  }

  async create(dto: CreatePaymentDto, adminId: string) {
    this.validateChequeFields(dto);

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: dto.invoiceId },
      include: { payments: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const amount = new Prisma.Decimal(dto.amount);
    const alreadyEffectivePaid = computeEffectivePaid(invoice.payments);
    const returnedAmount = await computeReturnedAmount(this.prisma, invoice.orderId);
    const netGrandTotal = invoice.grandTotal.sub(returnedAmount);
    if (alreadyEffectivePaid.add(amount).greaterThan(netGrandTotal)) {
      throw new BadRequestException(
        'Payment amount exceeds the outstanding invoice balance',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          invoiceId: dto.invoiceId,
          dealerId: invoice.dealerId,
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus: dto.mode === 'CHEQUE' ? ChequeStatus.PENDING : undefined,
          chequeStatusUpdatedAt: dto.mode === 'CHEQUE' ? new Date() : undefined,
          bankName: dto.mode === 'CHEQUE' ? dto.bankName : undefined,
          chequeNumber: dto.mode === 'CHEQUE' ? dto.chequeNumber : undefined,
          chequeDate: dto.mode === 'CHEQUE' && dto.chequeDate ? new Date(dto.chequeDate) : undefined,
          collectedDate:
            dto.mode === 'CHEQUE' && dto.collectedDate ? new Date(dto.collectedDate) : undefined,
          remarks: dto.remarks,
        },
      });

      await this.recomputeInvoicePaymentStatus(tx, invoice.id);

      // Not clamped to zero — a payment recorded while the dealer already
      // has a return credit correctly pushes their balance further negative
      // rather than discarding part of that credit.
      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: invoice.dealerId },
      });
      await tx.dealer.update({
        where: { id: invoice.dealerId },
        data: { outstandingBalance: dealer.outstandingBalance.sub(amount) },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PAYMENT',
        targetId: payment.id,
        details:
          dto.mode === 'CHEQUE'
            ? `Cheque payment of ${amount.toString()} against invoice ${invoice.invoiceNumber} (${dto.bankName}, #${dto.chequeNumber})`
            : `Payment of ${amount.toString()} against invoice ${invoice.invoiceNumber}`,
      });

      return payment;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Edits a payment's details. Only available while it's still fully
   * correctable — within 1 day of being recorded, and (for cheques) still
   * PENDING, since CLEARED/RETURNED already had further real-world
   * consequences that a plain edit shouldn't silently override.
   */
  async update(id: string, dto: UpdatePaymentDto, adminId: string) {
    this.validateChequeFields(dto);

    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: { include: { payments: true } } },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.assertEditable(payment);

    const amount = new Prisma.Decimal(dto.amount);
    const otherEffectivePaid = computeEffectivePaid(
      payment.invoice.payments.filter((p) => p.id !== id),
    );
    const returnedAmount = await computeReturnedAmount(this.prisma, payment.invoice.orderId);
    const netGrandTotal = payment.invoice.grandTotal.sub(returnedAmount);
    if (otherEffectivePaid.add(amount).greaterThan(netGrandTotal)) {
      throw new BadRequestException(
        'Payment amount exceeds the outstanding invoice balance',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id },
        data: {
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus: dto.mode === 'CHEQUE' ? ChequeStatus.PENDING : null,
          chequeStatusUpdatedAt: dto.mode === 'CHEQUE' ? new Date() : null,
          bankName: dto.mode === 'CHEQUE' ? dto.bankName : null,
          chequeNumber: dto.mode === 'CHEQUE' ? dto.chequeNumber : null,
          chequeDate: dto.mode === 'CHEQUE' && dto.chequeDate ? new Date(dto.chequeDate) : null,
          collectedDate:
            dto.mode === 'CHEQUE' && dto.collectedDate ? new Date(dto.collectedDate) : null,
          remarks: dto.remarks,
        },
      });

      await this.recomputeInvoicePaymentStatus(tx, payment.invoiceId);

      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: payment.dealerId },
      });
      // The old amount was fully effective (edits are blocked once a cheque
      // moves past PENDING), so reverse it and apply the new one.
      const rebalanced = dealer.outstandingBalance.add(payment.amount).sub(amount);
      await tx.dealer.update({
        where: { id: payment.dealerId },
        data: { outstandingBalance: rebalanced },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PAYMENT',
        targetId: id,
        details: `Updated payment against invoice ${payment.invoice.invoiceNumber}: ${payment.amount.toString()} -> ${amount.toString()}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Reverses a payment entirely — the "return the cash" correction — within
   * 1 day of it being recorded, restoring the dealer's outstanding balance
   * and the invoice's payment status as if it had never been entered.
   */
  async remove(id: string, adminId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: true, dealer: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.assertEditable(payment);

    return this.prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id } });

      await this.recomputeInvoicePaymentStatus(tx, payment.invoiceId);

      if (isEffectivePayment(payment)) {
        const dealer = await tx.dealer.findUniqueOrThrow({
          where: { id: payment.dealerId },
        });
        await tx.dealer.update({
          where: { id: payment.dealerId },
          data: { outstandingBalance: dealer.outstandingBalance.add(payment.amount) },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RETURNED_PAYMENT',
        targetId: id,
        details: `Returned/reversed payment of ${payment.amount.toString()} against invoice ${payment.invoice.invoiceNumber}`,
      });

      return { message: 'Payment returned' };
    }, TRANSACTION_OPTIONS);
  }

  private assertEditable(payment: Payment) {
    if (Date.now() - payment.createdAt.getTime() > DAY_MS) {
      throw new BadRequestException(
        'This payment can only be edited or returned within 1 day of being recorded',
      );
    }
    if (payment.mode === 'CHEQUE' && payment.chequeStatus !== 'PENDING') {
      throw new BadRequestException(
        `This cheque has already been marked ${payment.chequeStatus} — revert it to pending first if it needs correcting`,
      );
    }
  }

  /**
   * Moves a cheque payment through PENDING -> CLEARED/RETURNED (or reverts
   * within 1 day). Marking RETURNED means the money was never actually
   * received, so the dealer's outstanding balance and the invoice's payment
   * status are restored as if this payment didn't count; reverting back to
   * PENDING re-applies it.
   */
  async updateChequeStatus(
    paymentId: string,
    status: 'CLEARED' | 'RETURNED' | 'PENDING',
    adminId: string,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.mode !== 'CHEQUE') {
      throw new BadRequestException('Only cheque payments have a cheque status');
    }

    let details: string;

    if (status === ChequeStatus.PENDING) {
      if (payment.chequeStatus === ChequeStatus.PENDING) {
        throw new BadRequestException('This cheque is already pending');
      }
      const changedAt = payment.chequeStatusUpdatedAt;
      if (!changedAt || Date.now() - changedAt.getTime() > DAY_MS) {
        throw new BadRequestException(
          'This cheque can only be reverted to pending within 1 day of being marked ' +
            `${payment.chequeStatus}`,
        );
      }
      details = `Cheque ${payment.reference ?? paymentId} reverted from ${payment.chequeStatus} to PENDING`;
    } else {
      if (payment.chequeStatus !== ChequeStatus.PENDING) {
        throw new BadRequestException(
          `This cheque is already marked ${payment.chequeStatus}`,
        );
      }
      details = `Cheque ${payment.reference ?? paymentId} marked ${status}`;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { chequeStatus: status, chequeStatusUpdatedAt: new Date() },
      });

      await this.recomputeInvoicePaymentStatus(tx, payment.invoiceId);

      // Only the RETURNED <-> (PENDING/CLEARED) boundary changes whether
      // this payment counts against the dealer's balance.
      const wasEffective = isEffectivePayment(payment);
      const nowEffective = isEffectivePayment(updated);
      if (wasEffective !== nowEffective) {
        const dealer = await tx.dealer.findUniqueOrThrow({
          where: { id: payment.dealerId },
        });
        const delta = nowEffective ? payment.amount.neg() : payment.amount;
        await tx.dealer.update({
          where: { id: payment.dealerId },
          data: { outstandingBalance: dealer.outstandingBalance.add(delta) },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PAYMENT_CHEQUE_STATUS',
        targetId: paymentId,
        details,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async findAllForAdmin(query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = {
      mode: query.mode,
      chequeStatus: query.chequeStatus,
      dealerId: query.dealerId,
      ...((query.dateFrom || query.dateTo) && {
        paymentDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
      ...(query.search && {
        OR: [
          { reference: { contains: query.search, mode: 'insensitive' } },
          { chequeNumber: { contains: query.search, mode: 'insensitive' } },
          { bankName: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: { invoice: { include: { payments: true } }, dealer: { omit: { password: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForDealer(dealerId: string, query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = {
      dealerId,
      mode: query.mode,
      chequeStatus: query.chequeStatus,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: { invoice: { include: { payments: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(
    id: string,
    requester: { role: 'ADMIN' | 'DEALER'; id: string },
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: { include: { payments: true } }, dealer: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (requester.role === 'DEALER' && payment.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this payment');
    }
    return payment;
  }
}
