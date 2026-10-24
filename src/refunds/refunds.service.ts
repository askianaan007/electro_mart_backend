import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, PaymentMode, Prisma, Refund } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  assertNotFutureBusinessDate,
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';
import { assertChequeTransition } from '../common/utils/cheque-transitions';
import {
  duplicateWindowStart,
  PossibleDuplicateException,
} from '../common/utils/duplicate-guard';
import { recordLedgerRevision } from '../common/utils/ledger-revision';
import { computeSupplierBalance } from '../common/utils/supplier-balance';
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';
import { UpdateRefundDto } from './dto/update-refund.dto';

const ZERO = new Prisma.Decimal(0);

type RefundEffectFields = Pick<
  Refund,
  'cancelledAt' | 'mode' | 'chequeStatus' | 'amount'
>;

/** A refund still moves (or will move) money: not cancelled, not a bounced cheque. */
function isEffectiveRefund(
  refund: Pick<Refund, 'cancelledAt' | 'mode' | 'chequeStatus'>,
) {
  return (
    !refund.cancelledAt &&
    !(refund.mode === 'CHEQUE' && refund.chequeStatus === ChequeStatus.RETURNED)
  );
}

/** What the refund currently takes off the party's credit. */
function effectiveAmount(refund: RefundEffectFields) {
  return isEffectiveRefund(refund) ? refund.amount : ZERO;
}

function requireChequeDetails(dto: {
  mode: PaymentMode;
  chequeNumber?: string;
  bankName?: string;
  chequeDate?: string;
}) {
  if (
    dto.mode === 'CHEQUE' &&
    (!dto.chequeNumber || !dto.bankName || !dto.chequeDate)
  ) {
    throw new BadRequestException(
      'Cheque number, bank name and cheque date are required for cheque refunds',
    );
  }
}

import { computeDealerWallet } from '../common/utils/dealer-wallet';
/**
 * Money returned to a party that holds a credit (LC-12):
 *
 * - DEALER: the dealer's outstanding balance is negative (they paid more than
 *   they now owe, e.g. a return on a paid invoice). Paying it back is cash
 *   out and brings the balance back toward zero.
 * - SUPPLIER: the supplier balance is negative (we paid more than we now owe,
 *   e.g. a purchase return after full settlement, or the advance on a
 *   cancelled order). Their repayment is cash in, optionally linked to the
 *   order it was paid toward.
 *
 * A refund can never exceed the credit held, so the same credit can't be
 * refunded twice — every change that makes a refund count for more (edit,
 * restore, a bounced cheque re-presented) re-checks that. Like payments, a
 * cheque refund changes the party's balance when written and moves Liquid
 * Cash only once CLEARED; a RETURNED cheque or a cancellation undoes the
 * balance effect. Refunds are never deleted: every edit, status change,
 * cancellation and restore stores a before-image (LedgerRevision), so Liquid
 * Cash history shows it as a dated correction instead of rewriting the past.
 */
@Injectable()
export class RefundsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreateRefundDto, adminId: string) {
    assertNotFutureBusinessDate(dto.refundDate, 'Refund date');
    requireChequeDetails(dto);
    const isCheque = dto.mode === 'CHEQUE';
    const amount = new Prisma.Decimal(dto.amount);
    const isDealer = dto.party === 'DEALER';
    const counterpartyId = isDealer ? dto.dealerId : dto.supplierId;
    if (!counterpartyId) {
      throw new BadRequestException(
        isDealer ? 'dealerId is required' : 'supplierId is required',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // The same row lock payments/settlements take for this party, so a
      // concurrent payment can't change the credit between check and write.
      const name = isDealer
        ? await this.lockDealer(tx, counterpartyId)
        : await this.lockSupplier(tx, counterpartyId);
      const purchase = await this.resolvePurchase(
        tx,
        dto.purchaseId,
        isDealer ? null : counterpartyId,
      );

      if (!dto.confirmDuplicate) {
        const duplicate = await tx.refund.findFirst({
          where: {
            party: dto.party,
            dealerId: isDealer ? counterpartyId : null,
            supplierId: isDealer ? null : counterpartyId,
            amount,
            mode: dto.mode,
            cancelledAt: null,
            refundDate: {
              gte: startOfBusinessDay(dto.refundDate),
              lt: startOfNextBusinessDay(dto.refundDate),
            },
            createdAt: { gte: duplicateWindowStart() },
          },
          select: { id: true },
        });
        if (duplicate)
          throw new PossibleDuplicateException('refund', duplicate.id);
      }

      await this.assertCreditCovers(
        tx,
        {
          dealerId: isDealer ? counterpartyId : null,
          supplierId: isDealer ? null : counterpartyId,
        },
        amount,
        name,
      );

      const refundNumber = await nextSequenceNumber(tx, 'refund', 'RFD');
      const refund = await tx.refund.create({
        data: {
          refundNumber,
          party: dto.party,
          dealerId: isDealer ? counterpartyId : null,
          supplierId: isDealer ? null : counterpartyId,
          purchaseId: purchase?.id ?? null,
          amount,
          mode: dto.mode,
          refundDate: new Date(dto.refundDate),
          reason: dto.reason,
          reference: dto.reference,
          chequeStatus: isCheque ? ChequeStatus.PENDING : null,
          chequeStatusUpdatedAt: isCheque ? new Date() : null,
          chequeNumber: isCheque ? dto.chequeNumber : null,
          bankName: isCheque ? dto.bankName : null,
          chequeDate:
            isCheque && dto.chequeDate ? new Date(dto.chequeDate) : null,
          adminId,
        },
      });

      if (isDealer) {
        await tx.dealer.update({
          where: { id: counterpartyId },
          data: { outstandingBalance: { increment: amount } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: isDealer
          ? 'RECORDED_DEALER_REFUND'
          : 'RECORDED_SUPPLIER_REFUND',
        targetId: refund.id,
        details:
          `${refundNumber}: ${dto.mode} refund of ${amount.toString()} ${isDealer ? 'paid to' : 'received from'} ${name} (${dto.reason})` +
          (purchase ? ` for purchase ${purchase.invoiceNumber}` : ''),
      });

      return refund;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Corrects a refund recorded with the wrong amount, date, mode or cheque
   * details. A refund that switches to cheque starts PENDING (out of Liquid
   * Cash until cleared); one that stays a cheque keeps its status. Cancelled
   * refunds must be restored first.
   */
  async update(id: string, dto: UpdateRefundDto, adminId: string) {
    assertNotFutureBusinessDate(dto.refundDate, 'Refund date');
    requireChequeDetails(dto);
    const isCheque = dto.mode === 'CHEQUE';
    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(async (tx) => {
      const refund = await this.lockRefund(tx, id);
      if (refund.cancelledAt) {
        throw new BadRequestException(
          'This refund is cancelled — restore it before editing',
        );
      }
      const name = await this.lockParty(tx, refund);
      if (dto.purchaseId && refund.party !== 'SUPPLIER') {
        throw new BadRequestException(
          'Only supplier refunds can be linked to a purchase',
        );
      }
      const purchase = await this.resolvePurchase(
        tx,
        dto.purchaseId,
        refund.supplierId,
      );

      const keepsChequeStatus = isCheque && refund.mode === 'CHEQUE';
      const chequeStatus = isCheque
        ? keepsChequeStatus
          ? refund.chequeStatus
          : ChequeStatus.PENDING
        : null;
      const delta = effectiveAmount({
        cancelledAt: null,
        mode: dto.mode,
        chequeStatus,
        amount,
      }).sub(effectiveAmount(refund));
      if (delta.greaterThan(0)) {
        await this.assertCreditCovers(tx, refund, delta, name);
      }

      await recordLedgerRevision(tx, 'REFUND', refund, 'UPDATED', adminId);
      const updated = await tx.refund.update({
        where: { id },
        data: {
          amount,
          mode: dto.mode,
          refundDate: new Date(dto.refundDate),
          reason: dto.reason,
          reference: dto.reference ?? null,
          purchaseId: purchase?.id ?? null,
          chequeStatus,
          chequeStatusUpdatedAt: keepsChequeStatus
            ? refund.chequeStatusUpdatedAt
            : isCheque
              ? new Date()
              : null,
          chequeNumber: isCheque ? dto.chequeNumber : null,
          bankName: isCheque ? dto.bankName : null,
          chequeDate:
            isCheque && dto.chequeDate ? new Date(dto.chequeDate) : null,
        },
      });
      if (refund.dealerId && !delta.isZero()) {
        await tx.dealer.update({
          where: { id: refund.dealerId },
          data: { outstandingBalance: { increment: delta } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_REFUND',
        targetId: id,
        details: `${refund.refundNumber} edited: ${refund.mode} ${refund.amount.toString()} -> ${dto.mode} ${amount.toString()}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Legal changes are listed in cheque-transitions.ts: a supplier's refund
   * cheque (REFUND_RECEIVED) can move freely, a dealer refund cheque we
   * wrote (REFUND_PAID) only forward or back to PENDING within a day.
   * Leaving RETURNED counts the refund again, so the party must still hold
   * that much credit — it may have been settled another way meanwhile.
   */
  async updateChequeStatus(
    id: string,
    status: 'PENDING' | 'CLEARED' | 'RETURNED',
    adminId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.lockRefund(tx, id);
      if (refund.mode !== 'CHEQUE') {
        throw new BadRequestException('This refund was not made by cheque');
      }
      if (refund.cancelledAt) {
        throw new BadRequestException('This refund has been cancelled');
      }
      assertChequeTransition(
        refund.party === 'SUPPLIER' ? 'REFUND_RECEIVED' : 'REFUND_PAID',
        refund.chequeStatus,
        status,
        refund.chequeStatusUpdatedAt,
      );

      const name = await this.lockParty(tx, refund);
      const delta = effectiveAmount({ ...refund, chequeStatus: status }).sub(
        effectiveAmount(refund),
      );
      if (delta.greaterThan(0)) {
        await this.assertCreditCovers(tx, refund, delta, name);
      }

      await recordLedgerRevision(
        tx,
        'REFUND',
        refund,
        'CHEQUE_STATUS',
        adminId,
      );
      const updated = await tx.refund.update({
        where: { id },
        data: { chequeStatus: status, chequeStatusUpdatedAt: new Date() },
      });
      // A returned dealer-refund cheque never paid the dealer: their credit
      // comes back (and goes again if it's re-presented). A supplier
      // refund's effect is derived — nothing to update.
      if (refund.dealerId && !delta.isZero()) {
        await tx.dealer.update({
          where: { id: refund.dealerId },
          data: { outstandingBalance: { increment: delta } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_REFUND_CHEQUE_STATUS',
        targetId: id,
        details: `${refund.refundNumber}: cheque ${refund.chequeNumber ?? ''} changed from ${refund.chequeStatus} to ${status}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Voids a refund recorded in error (or a promised refund that never came).
   * Its row stays; history shows the cancellation dated today, and restore()
   * undoes it.
   */
  async cancel(id: string, reason: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.lockRefund(tx, id);
      if (refund.cancelledAt) {
        throw new BadRequestException('This refund is already cancelled');
      }
      await this.lockParty(tx, refund);

      await recordLedgerRevision(tx, 'REFUND', refund, 'CANCELLED', adminId);
      const updated = await tx.refund.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelReason: reason },
      });
      if (refund.dealerId && isEffectiveRefund(refund)) {
        await tx.dealer.update({
          where: { id: refund.dealerId },
          data: { outstandingBalance: { decrement: refund.amount } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CANCELLED_REFUND',
        targetId: id,
        details: `${refund.refundNumber} cancelled: ${reason}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /** Undoes a cancellation, provided the party still holds the credit it uses. */
  async restore(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.lockRefund(tx, id);
      if (!refund.cancelledAt) {
        throw new BadRequestException('This refund is not cancelled');
      }
      const name = await this.lockParty(tx, refund);
      const delta = effectiveAmount({ ...refund, cancelledAt: null });
      if (delta.greaterThan(0)) {
        await this.assertCreditCovers(tx, refund, delta, name);
      }

      await recordLedgerRevision(tx, 'REFUND', refund, 'RESTORED', adminId);
      const updated = await tx.refund.update({
        where: { id },
        data: { cancelledAt: null, cancelReason: null },
      });
      if (refund.dealerId && !delta.isZero()) {
        await tx.dealer.update({
          where: { id: refund.dealerId },
          data: { outstandingBalance: { increment: delta } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RESTORED_REFUND',
        targetId: id,
        details: `${refund.refundNumber} restored (was cancelled: ${refund.cancelReason ?? '—'})`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: QueryRefundsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.RefundWhereInput = {
      party: query.party,
      dealerId: query.dealerId,
      supplierId: query.supplierId,
      purchaseId: query.purchaseId,
      ...(query.search && {
        OR: [
          { refundNumber: { contains: query.search, mode: 'insensitive' } },
          { reason: { contains: query.search, mode: 'insensitive' } },
          { reference: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        include: {
          dealer: { select: { id: true, businessName: true } },
          supplier: { select: { id: true, name: true } },
          purchase: { select: { id: true, invoiceNumber: true } },
        },
        orderBy: [{ refundDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  /** What a party can currently be refunded — for the refund form. */
  async availableCredit(party: 'DEALER' | 'SUPPLIER', id: string) {
    const credit =
      party === 'DEALER'
        ? await this.dealerCredit(this.prisma, id)
        : await this.supplierCredit(this.prisma, id);
    return { party, id, availableCredit: credit.toNumber() };
  }

  private async lockRefund(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${id} FOR UPDATE`;
    const refund = await tx.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException('Refund not found');
    return refund;
  }

  private lockParty(
    tx: Prisma.TransactionClient,
    refund: Pick<Refund, 'dealerId' | 'supplierId'>,
  ) {
    return refund.dealerId
      ? this.lockDealer(tx, refund.dealerId)
      : this.lockSupplier(tx, refund.supplierId as string);
  }

  private async lockDealer(tx: Prisma.TransactionClient, dealerId: string) {
    await tx.$queryRaw`SELECT id FROM "Dealer" WHERE id = ${dealerId} FOR UPDATE`;
    const dealer = await tx.dealer.findUnique({ where: { id: dealerId } });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return dealer.businessName;
  }

  private async lockSupplier(tx: Prisma.TransactionClient, supplierId: string) {
    await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${supplierId} FOR UPDATE`;
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier.name;
  }

  /** The purchase a supplier refund is for — it must be that supplier's. */
  private async resolvePurchase(
    tx: Prisma.TransactionClient,
    purchaseId: string | undefined,
    supplierId: string | null,
  ) {
    if (!purchaseId) return null;
    if (!supplierId) {
      throw new BadRequestException(
        'Only supplier refunds can be linked to a purchase',
      );
    }
    const purchase = await tx.purchase.findUnique({
      where: { id: purchaseId },
      select: { id: true, supplierId: true, invoiceNumber: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.supplierId !== supplierId) {
      throw new BadRequestException(
        'That purchase belongs to a different supplier',
      );
    }
    return purchase;
  }

  /** Refuses to let refunds take more than the credit the party currently holds. */
  private async assertCreditCovers(
    tx: Prisma.TransactionClient,
    party: Pick<Refund, 'dealerId' | 'supplierId'>,
    increase: Prisma.Decimal,
    name: string,
  ) {
    const credit = party.dealerId
      ? await this.dealerCredit(tx, party.dealerId)
      : await this.supplierCredit(tx, party.supplierId as string);
    if (increase.greaterThan(credit)) {
      throw new BadRequestException(
        credit.isZero()
          ? `${name} holds no credit to refund`
          : `Refund of ${increase.toString()} exceeds the ${credit.toString()} credit ${name} holds`,
      );
    }
  }

  private async dealerCredit(
    client: Prisma.TransactionClient,
    dealerId: string,
  ): Promise<Prisma.Decimal> {
    const dealer = await client.dealer.findUnique({ where: { id: dealerId } });
    if (!dealer) throw new NotFoundException('Dealer not found');
    // Also capped by the wallet, so credit already spent on an invoice (or
    // paid by a cheque that hasn't cleared) can't be paid out a second time.
    const wallet = await computeDealerWallet(client, dealerId);
    return Prisma.Decimal.min(
      Prisma.Decimal.max(0, dealer.outstandingBalance.neg()),
      wallet.available,
    );
  }

  private async supplierCredit(
    client: Prisma.TransactionClient,
    supplierId: string,
  ): Promise<Prisma.Decimal> {
    const supplier = await client.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const { balance } = await computeSupplierBalance(client, supplierId);
    return Prisma.Decimal.max(0, balance.neg());
  }
}
