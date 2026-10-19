import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, Prisma, Refund } from '@prisma/client';
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

/** A refund still moves (or will move) money: not cancelled, not a bounced cheque. */
function isEffectiveRefund(
  refund: Pick<Refund, 'cancelledAt' | 'mode' | 'chequeStatus'>,
) {
  return (
    !refund.cancelledAt &&
    !(refund.mode === 'CHEQUE' && refund.chequeStatus === ChequeStatus.RETURNED)
  );
}

/**
 * Money returned to a party that holds a credit (LC-12):
 *
 * - DEALER: the dealer's outstanding balance is negative (they paid more than
 *   they now owe, e.g. a return on a paid invoice). Paying it back is cash
 *   out and brings the balance back toward zero.
 * - SUPPLIER: the supplier balance is negative (we paid more than we now owe,
 *   e.g. a purchase return after full settlement). Their repayment is cash in.
 *
 * A refund can never exceed the credit held, so the same credit can't be
 * refunded twice. Like payments, a cheque refund changes the party's balance
 * when written and moves Liquid Cash only once CLEARED; a RETURNED cheque or
 * a cancellation undoes the balance effect, and Liquid Cash history shows the
 * change on its own date (LedgerRevision). Refunds are never edited or deleted.
 */
@Injectable()
export class RefundsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreateRefundDto, adminId: string) {
    assertNotFutureBusinessDate(dto.refundDate, 'Refund date');
    const isCheque = dto.mode === 'CHEQUE';
    if (isCheque && (!dto.chequeNumber || !dto.bankName || !dto.chequeDate)) {
      throw new BadRequestException(
        'Cheque number, bank name and cheque date are required for cheque refunds',
      );
    }
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

      const credit = isDealer
        ? await this.dealerCredit(tx, counterpartyId)
        : await this.supplierCredit(tx, counterpartyId);
      if (amount.greaterThan(credit)) {
        throw new BadRequestException(
          credit.isZero()
            ? `${name} holds no credit to refund`
            : `Refund of ${amount.toString()} exceeds the ${credit.toString()} credit ${name} holds`,
        );
      }

      const refundNumber = await nextSequenceNumber(tx, 'refund', 'RFD');
      const refund = await tx.refund.create({
        data: {
          refundNumber,
          party: dto.party,
          dealerId: isDealer ? counterpartyId : null,
          supplierId: isDealer ? null : counterpartyId,
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
        details: `${refundNumber}: ${dto.mode} refund of ${amount.toString()} ${isDealer ? 'paid to' : 'received from'} ${name} (${dto.reason})`,
      });

      return refund;
    }, TRANSACTION_OPTIONS);
  }

  async updateChequeStatus(
    id: string,
    status: 'CLEARED' | 'RETURNED',
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
      assertChequeTransition('REFUND', refund.chequeStatus, status, null);

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
      // comes back. (A supplier refund's effect is derived — nothing to undo.)
      if (status === 'RETURNED' && refund.dealerId) {
        await tx.dealer.update({
          where: { id: refund.dealerId },
          data: { outstandingBalance: { decrement: refund.amount } },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_REFUND_CHEQUE_STATUS',
        targetId: id,
        details: `${refund.refundNumber}: cheque ${refund.chequeNumber ?? ''} marked ${status}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /** Corrects a refund recorded in error. Its row stays; history shows the cancellation dated today. */
  async cancel(id: string, reason: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const refund = await this.lockRefund(tx, id);
      if (refund.cancelledAt) {
        throw new BadRequestException('This refund is already cancelled');
      }
      if (refund.mode === 'CHEQUE' && refund.chequeStatus === 'CLEARED') {
        throw new BadRequestException(
          'This refund cheque has cleared — the money has moved. Record a new refund in the other direction if it was returned.',
        );
      }

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

  async findAll(query: QueryRefundsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.RefundWhereInput = {
      party: query.party,
      dealerId: query.dealerId,
      supplierId: query.supplierId,
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

  private async dealerCredit(
    client: Prisma.TransactionClient,
    dealerId: string,
  ): Promise<Prisma.Decimal> {
    const dealer = await client.dealer.findUnique({ where: { id: dealerId } });
    if (!dealer) throw new NotFoundException('Dealer not found');
    return Prisma.Decimal.max(0, dealer.outstandingBalance.neg());
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
