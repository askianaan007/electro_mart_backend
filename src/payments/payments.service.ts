import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChequeStatus,
  Invoice,
  Payment,
  PaymentMode,
  Prisma,
  Role,
} from '@prisma/client';
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
  isEffectivePayment,
  recomputeInvoicePaymentStatus,
} from '../common/utils/invoice-financials';

const ZERO = new Prisma.Decimal(0);

/** The parts of a payment that decide whether, and how much, it counts. */
type PaymentEffect = {
  amount: Prisma.Decimal;
  mode: string;
  chequeStatus: ChequeStatus | null;
};

/**
 * A payment row as stored in PaymentRevision.snapshot — the same fields as
 * Payment, JSON-safe (Decimal and dates as strings), plus the rep-portal
 * collection it came from so a restore can re-link it.
 */
type PaymentSnapshot = {
  id: string;
  invoiceId: string | null;
  dealerId: string;
  amount: string;
  mode: PaymentMode;
  reference: string | null;
  paymentDate: string;
  createdAt: string;
  chequeStatus: ChequeStatus | null;
  chequeStatusUpdatedAt: string | null;
  bankName: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  collectedDate: string | null;
  remarks: string | null;
  collectionSubmissionId: string | null;
};

const toIso = (d: Date | null) => (d ? d.toISOString() : null);
const fromIso = (s: string | null) => (s ? new Date(s) : null);

function toSnapshot(
  p: Payment & { collectionSubmission: { id: string } | null },
): PaymentSnapshot {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    dealerId: p.dealerId,
    amount: p.amount.toString(),
    mode: p.mode,
    reference: p.reference,
    paymentDate: p.paymentDate.toISOString(),
    createdAt: p.createdAt.toISOString(),
    chequeStatus: p.chequeStatus,
    chequeStatusUpdatedAt: toIso(p.chequeStatusUpdatedAt),
    bankName: p.bankName,
    chequeNumber: p.chequeNumber,
    chequeDate: toIso(p.chequeDate),
    collectedDate: toIso(p.collectedDate),
    remarks: p.remarks,
    collectionSubmissionId: p.collectionSubmission?.id ?? null,
  };
}

function fromSnapshot(s: PaymentSnapshot) {
  return {
    id: s.id,
    invoiceId: s.invoiceId,
    dealerId: s.dealerId,
    amount: new Prisma.Decimal(s.amount),
    mode: s.mode,
    reference: s.reference,
    paymentDate: new Date(s.paymentDate),
    createdAt: new Date(s.createdAt),
    chequeStatus: s.chequeStatus,
    chequeStatusUpdatedAt: fromIso(s.chequeStatusUpdatedAt),
    bankName: s.bankName,
    chequeNumber: s.chequeNumber,
    chequeDate: fromIso(s.chequeDate),
    collectedDate: fromIso(s.collectedDate),
    remarks: s.remarks,
  };
}

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
    if (
      !dto.bankName ||
      !dto.chequeNumber ||
      !dto.chequeDate ||
      !dto.collectedDate
    ) {
      throw new BadRequestException(
        'Bank name, cheque number, cheque date, and collected date are all required for cheque payments',
      );
    }
    if (new Date(dto.collectedDate) > new Date()) {
      throw new BadRequestException('Collected date cannot be in the future');
    }
  }

  async create(dto: CreatePaymentDto, adminId: string) {
    this.validateChequeFields(dto);

    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(async (tx) => {
      // Lock the invoice row for the duration of this transaction so a
      // second concurrent payment against the same invoice can't read the
      // same pre-write "amount remaining" snapshot and also pass the
      // overpayment guard below — it blocks here until this transaction
      // commits, then sees this payment already counted.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${dto.invoiceId} FOR UPDATE`;

      const invoice = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: { payments: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');

      const alreadyEffectivePaid = computeEffectivePaid(invoice.payments);
      const returnedAmount = await computeReturnedAmount(tx, invoice.orderId);
      const netGrandTotal = invoice.grandTotal.sub(returnedAmount);
      if (alreadyEffectivePaid.add(amount).greaterThan(netGrandTotal)) {
        throw new BadRequestException(
          'Payment amount exceeds the outstanding invoice balance',
        );
      }

      const payment = await tx.payment.create({
        data: {
          invoiceId: dto.invoiceId,
          dealerId: invoice.dealerId,
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus:
            dto.mode === 'CHEQUE' ? ChequeStatus.PENDING : undefined,
          chequeStatusUpdatedAt: dto.mode === 'CHEQUE' ? new Date() : undefined,
          bankName: dto.mode === 'CHEQUE' ? dto.bankName : undefined,
          chequeNumber: dto.mode === 'CHEQUE' ? dto.chequeNumber : undefined,
          chequeDate:
            dto.mode === 'CHEQUE' && dto.chequeDate
              ? new Date(dto.chequeDate)
              : undefined,
          collectedDate:
            dto.mode === 'CHEQUE' && dto.collectedDate
              ? new Date(dto.collectedDate)
              : undefined,
          remarks: dto.remarks,
        },
      });

      await recomputeInvoicePaymentStatus(tx, invoice.id);

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
   * Edits a payment's details — at any time and in any cheque state. The
   * row as it was before the edit is saved to PaymentRevision first, so the
   * change can be undone exactly. A cheque that stays a cheque keeps its
   * current status; switching a payment to CHEQUE starts it at PENDING.
   */
  async update(id: string, dto: UpdatePaymentDto, adminId: string) {
    this.validateChequeFields(dto);

    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Payment not found');

    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(async (tx) => {
      // Same row-lock pattern as create() — see comment there.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${existing.invoiceId} FOR UPDATE`;

      const payment = await tx.payment.findUnique({
        where: { id },
        include: { invoice: true, collectionSubmission: true },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      this.assertHasInvoice(payment);

      const isCheque = dto.mode === 'CHEQUE';
      const keepsChequeStatus = isCheque && payment.mode === 'CHEQUE';
      const chequeStatus = isCheque
        ? keepsChequeStatus
          ? payment.chequeStatus
          : ChequeStatus.PENDING
        : null;

      await this.assertFitsInvoice(tx, payment.invoice, id, {
        amount,
        mode: dto.mode,
        chequeStatus,
      });

      await this.recordRevision(tx, payment, 'UPDATED', adminId);

      const updated = await tx.payment.update({
        where: { id },
        data: {
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus,
          chequeStatusUpdatedAt: keepsChequeStatus
            ? payment.chequeStatusUpdatedAt
            : isCheque
              ? new Date()
              : null,
          bankName: isCheque ? dto.bankName : null,
          chequeNumber: isCheque ? dto.chequeNumber : null,
          chequeDate:
            isCheque && dto.chequeDate ? new Date(dto.chequeDate) : null,
          collectedDate:
            isCheque && dto.collectedDate ? new Date(dto.collectedDate) : null,
          remarks: dto.remarks,
        },
      });

      await this.settleFinancials(tx, payment.invoiceId, payment.dealerId, {
        before: payment,
        after: updated,
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
   * Deletes a payment, restoring the dealer's outstanding balance and the
   * invoice's payment status as if it had never been entered. Nothing is
   * lost: the full row is kept in PaymentRevision and can be restored with
   * undo() (same id, same createdAt, same collection-submission link).
   */
  async remove(id: string, adminId: string) {
    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Payment not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${existing.invoiceId} FOR UPDATE`;

      const payment = await tx.payment.findUnique({
        where: { id },
        include: { invoice: true, collectionSubmission: true },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      this.assertHasInvoice(payment);

      await this.recordRevision(tx, payment, 'DELETED', adminId);
      await tx.payment.delete({ where: { id } });

      await this.settleFinancials(tx, payment.invoiceId, payment.dealerId, {
        before: payment,
        after: null,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RETURNED_PAYMENT',
        targetId: id,
        details: `Deleted payment of ${payment.amount.toString()} against invoice ${payment.invoice.invoiceNumber} (restorable)`,
      });

      return { message: 'Payment deleted' };
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Changes a cheque's status to any other status — PENDING, CLEARED or
   * RETURNED — at any time. RETURNED means the money was never received, so
   * moving into or out of RETURNED adjusts the dealer's balance and the
   * invoice's payment status. The previous status is kept for undo().
   */
  async updateChequeStatus(
    paymentId: string,
    status: 'CLEARED' | 'RETURNED' | 'PENDING',
    adminId: string,
  ) {
    const existing = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!existing) throw new NotFoundException('Payment not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${existing.invoiceId} FOR UPDATE`;

      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { invoice: true, collectionSubmission: true },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.mode !== 'CHEQUE') {
        throw new BadRequestException(
          'Only cheque payments have a cheque status',
        );
      }
      this.assertHasInvoice(payment);
      if (payment.chequeStatus === status) {
        throw new BadRequestException(
          `This cheque is already marked ${status}`,
        );
      }

      await this.assertFitsInvoice(tx, payment.invoice, paymentId, {
        amount: payment.amount,
        mode: payment.mode,
        chequeStatus: status,
      });

      await this.recordRevision(tx, payment, 'CHEQUE_STATUS', adminId);

      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: { chequeStatus: status, chequeStatusUpdatedAt: new Date() },
      });

      await this.settleFinancials(tx, payment.invoiceId, payment.dealerId, {
        before: payment,
        after: updated,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PAYMENT_CHEQUE_STATUS',
        targetId: paymentId,
        details: `Cheque ${payment.chequeNumber ?? payment.reference ?? paymentId} changed from ${payment.chequeStatus} to ${status}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Undoes the most recent not-yet-undone change to a payment — an edit, a
   * cheque-status change, or a delete — putting the row back exactly as it
   * was and re-applying its balance/invoice-status effects. Calling it
   * repeatedly walks further back through the payment's history.
   */
  async undo(paymentId: string, adminId: string) {
    const latest = await this.prisma.paymentRevision.findFirst({
      where: { paymentId, undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw new BadRequestException(
        'There is nothing to undo for this payment',
      );
    }
    const snapshot = latest.snapshot as unknown as PaymentSnapshot;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${snapshot.invoiceId} FOR UPDATE`;

      // Re-read under the lock so two concurrent undos can't both apply the
      // same revision.
      const revision = await tx.paymentRevision.findFirst({
        where: { paymentId, undoneAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!revision || revision.id !== latest.id) {
        throw new BadRequestException(
          'This payment was changed in the meantime — refresh and try again',
        );
      }

      const invoice = snapshot.invoiceId
        ? await tx.invoice.findUnique({ where: { id: snapshot.invoiceId } })
        : null;
      if (!invoice) {
        throw new BadRequestException(
          'The invoice this payment belonged to no longer exists, so it cannot be restored',
        );
      }

      const restored = fromSnapshot(snapshot);
      const current = await tx.payment.findUnique({ where: { id: paymentId } });

      if (revision.action === 'DELETED' && current) {
        throw new BadRequestException('This payment already exists');
      }
      if (revision.action !== 'DELETED' && !current) {
        throw new BadRequestException(
          'This payment is deleted — restore it first',
        );
      }

      await this.assertFitsInvoice(tx, invoice, paymentId, restored);

      let result: Payment;
      if (current) {
        // id/createdAt/invoiceId/dealerId never change after creation.
        result = await tx.payment.update({
          where: { id: paymentId },
          data: {
            amount: restored.amount,
            mode: restored.mode,
            reference: restored.reference,
            paymentDate: restored.paymentDate,
            chequeStatus: restored.chequeStatus,
            chequeStatusUpdatedAt: restored.chequeStatusUpdatedAt,
            bankName: restored.bankName,
            chequeNumber: restored.chequeNumber,
            chequeDate: restored.chequeDate,
            collectedDate: restored.collectedDate,
            remarks: restored.remarks,
          },
        });
      } else {
        result = await tx.payment.create({ data: restored });
        // Re-link the rep-portal collection that produced this payment, if
        // that link was cut by the delete (ON DELETE SET NULL) and nothing
        // else has claimed it since.
        if (snapshot.collectionSubmissionId) {
          await tx.collectionSubmission.updateMany({
            where: {
              id: snapshot.collectionSubmissionId,
              resultingPaymentId: null,
            },
            data: { resultingPaymentId: paymentId },
          });
        }
      }

      await this.settleFinancials(tx, invoice.id, restored.dealerId, {
        before: current,
        after: result,
      });

      await tx.paymentRevision.update({
        where: { id: revision.id },
        data: { undoneAt: new Date() },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UNDID_PAYMENT_CHANGE',
        targetId: paymentId,
        details:
          revision.action === 'DELETED'
            ? `Restored deleted payment of ${restored.amount.toString()} against invoice ${invoice.invoiceNumber}`
            : `Undid ${revision.action === 'UPDATED' ? 'edit' : 'cheque status change'} on payment against invoice ${invoice.invoiceNumber}`,
      });

      return result;
    }, TRANSACTION_OPTIONS);
  }

  /** Deleted payments that can still be restored, most recently deleted first. */
  async findDeleted(query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.PaymentRevisionWhereInput = {
      action: 'DELETED',
      undoneAt: null,
    };

    const [revisions, total] = await this.prisma.$transaction([
      this.prisma.paymentRevision.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.paymentRevision.count({ where }),
    ]);

    const snapshots = revisions.map(
      (r) => r.snapshot as unknown as PaymentSnapshot,
    );
    const [dealers, invoices] = await Promise.all([
      this.prisma.dealer.findMany({
        where: { id: { in: snapshots.map((s) => s.dealerId) } },
        select: { id: true, businessName: true },
      }),
      this.prisma.invoice.findMany({
        where: {
          id: {
            in: snapshots
              .map((s) => s.invoiceId)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true, invoiceNumber: true, orderId: true },
      }),
    ]);

    const data = revisions.map((revision, i) => {
      const s = snapshots[i];
      return {
        ...s,
        deletedAt: revision.createdAt,
        dealer: dealers.find((d) => d.id === s.dealerId) ?? null,
        invoice: invoices.find((inv) => inv.id === s.invoiceId) ?? null,
      };
    });

    return paginate(data, total, page, limit);
  }

  /**
   * Rejects a payment state that, if it counts towards the invoice, would
   * take the invoice's effective paid total past its net (post-returns)
   * grand total. A RETURNED cheque doesn't count, so it always fits.
   */
  private async assertFitsInvoice(
    tx: Prisma.TransactionClient,
    invoice: Invoice,
    paymentId: string,
    state: PaymentEffect,
  ) {
    if (!isEffectivePayment(state)) return;
    const others = await tx.payment.findMany({
      where: { invoiceId: invoice.id, id: { not: paymentId } },
    });
    const returnedAmount = await computeReturnedAmount(tx, invoice.orderId);
    const netGrandTotal = invoice.grandTotal.sub(returnedAmount);
    if (
      computeEffectivePaid(others).add(state.amount).greaterThan(netGrandTotal)
    ) {
      throw new BadRequestException(
        'Payment amount exceeds the outstanding invoice balance',
      );
    }
  }

  /**
   * Applies the balance/status consequences of a payment going from
   * `before` to `after` (either may be null — not existing). Must run after
   * the payment row itself has been written.
   */
  private async settleFinancials(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    dealerId: string,
    change: { before: PaymentEffect | null; after: PaymentEffect | null },
  ) {
    await recomputeInvoicePaymentStatus(tx, invoiceId);

    const effectiveAmount = (p: PaymentEffect | null) =>
      p && isEffectivePayment(p) ? p.amount : ZERO;
    // Money the dealer was credited for before, minus what they're credited
    // for now — positive means their outstanding balance goes back up.
    const delta = effectiveAmount(change.before).sub(
      effectiveAmount(change.after),
    );
    if (delta.isZero()) return;

    const dealer = await tx.dealer.findUniqueOrThrow({
      where: { id: dealerId },
    });
    await tx.dealer.update({
      where: { id: dealerId },
      data: { outstandingBalance: dealer.outstandingBalance.add(delta) },
    });
  }

  private recordRevision(
    tx: Prisma.TransactionClient,
    payment: Payment & { collectionSubmission: { id: string } | null },
    action: 'UPDATED' | 'CHEQUE_STATUS' | 'DELETED',
    adminId: string,
  ) {
    return tx.paymentRevision.create({
      data: {
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        action,
        adminId,
        snapshot: toSnapshot(payment),
      },
    });
  }

  /**
   * invoiceId/invoice are nullable in the schema for a not-yet-exposed
   * standalone-credit case (see the Payment model's own comment) — every
   * payment CreatePaymentDto can actually produce today always has one,
   * since invoiceId is a required field there. This just makes that
   * existing guarantee explicit for the type checker rather than assuming it.
   */
  private assertHasInvoice<
    T extends { invoiceId: string | null; invoice: Invoice | null },
  >(
    payment: T,
  ): asserts payment is T & { invoiceId: string; invoice: Invoice } {
    if (!payment.invoice || !payment.invoiceId) {
      throw new BadRequestException(
        'This payment is not associated with an invoice',
      );
    }
  }

  async findAllForAdmin(query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = {
      mode: query.mode,
      chequeStatus: query.chequeStatus,
      dealerId: query.dealerId,
      invoiceId: query.invoiceId,
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
        include: {
          invoice: { include: { payments: true } },
          dealer: { omit: { password: true } },
        },
        // 'chequeDate' surfaces the soonest-to-deposit cheque first (upcoming
        // deposit views); default stays most-recently-recorded first.
        orderBy:
          query.sortBy === 'chequeDate'
            ? { chequeDate: 'asc' }
            : { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    // The newest undoable change per payment, so the screen can offer
    // "Undo" on exactly the rows that have one.
    const revisions = await this.prisma.paymentRevision.findMany({
      where: { paymentId: { in: data.map((p) => p.id) }, undoneAt: null },
      orderBy: { createdAt: 'desc' },
      distinct: ['paymentId'],
      select: { paymentId: true, action: true, createdAt: true },
    });
    const withLastChange = data.map((payment) => {
      const last = revisions.find((r) => r.paymentId === payment.id);
      return {
        ...payment,
        lastChange: last
          ? { action: last.action, createdAt: last.createdAt }
          : null,
      };
    });

    return paginate(withLastChange, total, page, limit);
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

  async findOne(id: string, requester: { role: Role; id: string }) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        invoice: { include: { payments: true } },
        dealer: { omit: { password: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (requester.role === 'DEALER' && payment.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this payment');
    }
    return payment;
  }
}
