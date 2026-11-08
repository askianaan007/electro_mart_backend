import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, PaymentMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { LiquidCashService } from '../liquid-cash/liquid-cash.service';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { QueryInvestmentDto } from './dto/query-investment.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  assertNotFutureBusinessDate,
  businessDateRange,
} from '../common/utils/business-date';
import { assertChequeTransition } from '../common/utils/cheque-transitions';
import { recordLedgerRevision } from '../common/utils/ledger-revision';

// Serializes withdrawals across all investors: they draw on one shared
// Liquid Cash pool, so two concurrent ones must not both pass the check.
const WITHDRAWAL_LOCK = 482_017_016;

type ChequeFields = {
  mode?: PaymentMode;
  chequeNumber?: string;
  bankName?: string;
  chequeDate?: string;
};

@Injectable()
export class InvestmentsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private liquidCashService: LiquidCashService,
  ) {}

  private assertChequeFields(dto: ChequeFields) {
    if (dto.mode !== 'CHEQUE') return;
    if (!dto.chequeNumber || !dto.bankName || !dto.chequeDate) {
      throw new BadRequestException(
        'Cheque number, bank name and cheque date are required for cheque investments and withdrawals',
      );
    }
  }

  /**
   * Cash an entry takes out of the business (positive) or puts in
   * (negative) while it stands: a cleared/non-cheque entry has moved its
   * amount, and a PENDING withdrawal cheque has the money committed. A
   * pending deposit cheque or a returned cheque moves nothing yet.
   */
  private cashOutOf(entry: {
    amount: Prisma.Decimal;
    mode: PaymentMode;
    chequeStatus: ChequeStatus | null;
  }): Prisma.Decimal {
    const effective =
      entry.mode !== 'CHEQUE' ||
      entry.chequeStatus === null ||
      entry.chequeStatus === ChequeStatus.CLEARED;
    const committed =
      entry.chequeStatus === ChequeStatus.PENDING && entry.amount.isNegative();
    return effective || committed ? entry.amount.neg() : new Prisma.Decimal(0);
  }

  /**
   * A withdrawal is paid out of the business's Liquid Cash, so it can't take
   * more than is spendable now: the Liquid Cash balance less outgoing cheques
   * already written (LiquidCashService.getSpendableCash). The investor's own
   * equity doesn't limit it — an investor may withdraw past their share and
   * go negative. `previous` is the entry being edited: only the extra cash
   * the edit takes out is checked, so correcting a reason or date never fails.
   *
   * Call inside the write's transaction after lockWithdrawals(): the lock
   * serializes every withdrawal, and LiquidCashService reads on its own
   * connection, so it sees every write committed before the lock was granted.
   */
  private async assertWithdrawalWithinLiquidCash(
    next: {
      amount: Prisma.Decimal;
      mode: PaymentMode;
      chequeStatus: ChequeStatus | null;
    },
    previous?: {
      amount: Prisma.Decimal;
      mode: PaymentMode;
      chequeStatus: ChequeStatus | null;
    },
  ) {
    if (!next.amount.isNegative()) return;
    const extraOut = this.cashOutOf(next).sub(
      previous ? this.cashOutOf(previous) : 0,
    );
    if (!extraOut.greaterThan(0)) return;
    const { balance, pendingOut, spendable } =
      await this.liquidCashService.getSpendableCash();
    if (extraOut.greaterThan(spendable)) {
      const committed = pendingOut.greaterThan(0)
        ? ` (Liquid Cash ${balance.toFixed(2)} less ${pendingOut.toFixed(2)} in uncleared outgoing cheques)`
        : '';
      throw new BadRequestException(
        `Withdrawal of ${extraOut.toFixed(2)} exceeds the available Liquid Cash of ${spendable.toFixed(2)}${committed}`,
      );
    }
  }

  private async lockWithdrawals(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WITHDRAWAL_LOCK})`;
  }

  async create(dto: CreateInvestmentDto, adminId: string) {
    const investor = await this.prisma.investor.findUnique({
      where: { id: dto.investorId },
    });
    if (!investor) throw new NotFoundException('Investor not found');
    assertNotFutureBusinessDate(dto.investmentDate, 'Investment date');
    this.assertChequeFields(dto);

    const amount = new Prisma.Decimal(dto.amount);
    const isCheque = dto.mode === 'CHEQUE';

    return this.prisma.$transaction(async (tx) => {
      if (amount.isNegative()) {
        await this.lockWithdrawals(tx);
        await this.assertWithdrawalWithinLiquidCash({
          amount,
          mode: dto.mode,
          chequeStatus: isCheque ? ChequeStatus.PENDING : null,
        });
      }
      const investment = await tx.investment.create({
        data: {
          investorId: dto.investorId,
          amount,
          mode: dto.mode,
          investmentDate: new Date(dto.investmentDate),
          reason: dto.reason,
          remarks: dto.remarks,
          // A cheque only adds to (or, for a withdrawal, leaves) the bank
          // once it clears — until then it doesn't count anywhere (LC-09).
          chequeStatus: isCheque ? ChequeStatus.PENDING : null,
          chequeStatusUpdatedAt: isCheque ? new Date() : null,
          chequeNumber: isCheque ? dto.chequeNumber : null,
          bankName: isCheque ? dto.bankName : null,
          chequeDate:
            isCheque && dto.chequeDate ? new Date(dto.chequeDate) : null,
        },
        include: { investor: true },
      });

      const isWithdrawal = investment.amount.isNegative();
      await this.activityLogService.log(tx, {
        adminId,
        action: isWithdrawal ? 'RECORDED_WITHDRAWAL' : 'RECORDED_INVESTMENT',
        targetId: investment.id,
        details: `${isWithdrawal ? 'Withdrawal' : 'Investment'} of ${investment.amount.abs().toString()} for ${investment.investor.name} (${investment.reason})${isCheque ? ' by cheque, pending clearance' : ''}`,
      });

      return investment;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: QueryInvestmentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvestmentWhereInput = {
      investorId: query.investorId,
      ...(query.type === 'DEPOSIT' && { amount: { gt: 0 } }),
      ...(query.type === 'WITHDRAWAL' && { amount: { lt: 0 } }),
      ...(query.search && {
        reason: { contains: query.search, mode: 'insensitive' },
      }),
      ...((query.dateFrom || query.dateTo) && {
        investmentDate: businessDateRange(query.dateFrom, query.dateTo),
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.investment.findMany({
        where,
        include: { investor: true },
        orderBy: [{ investmentDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.investment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const investment = await this.prisma.investment.findUnique({
      where: { id },
      include: { investor: true },
    });
    if (!investment) throw new NotFoundException('Investment not found');
    return investment;
  }

  /**
   * Edits an entry. The previous version is kept as a LedgerRevision, so
   * Liquid Cash history shows the original on its date and the edit as a
   * correction on the day it was made (LC-06). Switching to CHEQUE starts a
   * new PENDING cheque; a cheque that stays a cheque keeps its status.
   */
  async update(id: string, dto: UpdateInvestmentDto, adminId: string) {
    const existing = await this.findOne(id);

    if (dto.investorId) {
      const investor = await this.prisma.investor.findUnique({
        where: { id: dto.investorId },
      });
      if (!investor) throw new NotFoundException('Investor not found');
    }
    if (dto.investmentDate) {
      assertNotFutureBusinessDate(dto.investmentDate, 'Investment date');
    }

    const mode = dto.mode ?? existing.mode;
    const isCheque = mode === 'CHEQUE';
    const keepsCheque = isCheque && existing.mode === 'CHEQUE';
    this.assertChequeFields({
      mode,
      chequeNumber: dto.chequeNumber ?? existing.chequeNumber ?? undefined,
      bankName: dto.bankName ?? existing.bankName ?? undefined,
      chequeDate:
        dto.chequeDate ?? existing.chequeDate?.toISOString() ?? undefined,
    });

    const amount =
      dto.amount !== undefined
        ? new Prisma.Decimal(dto.amount)
        : existing.amount;
    return this.prisma.$transaction(async (tx) => {
      if (amount.isNegative()) {
        await this.lockWithdrawals(tx);
        // Re-read under the lock: the entry may have changed since findOne.
        const current = await tx.investment.findUnique({ where: { id } });
        if (!current) throw new NotFoundException('Investment not found');
        const stillCheque = isCheque && current.mode === 'CHEQUE';
        await this.assertWithdrawalWithinLiquidCash(
          {
            amount,
            mode,
            chequeStatus: stillCheque
              ? current.chequeStatus
              : isCheque
                ? ChequeStatus.PENDING
                : null,
          },
          current,
        );
      }
      await recordLedgerRevision(
        tx,
        'INVESTMENT',
        existing,
        'UPDATED',
        adminId,
      );

      const investment = await tx.investment.update({
        where: { id },
        data: {
          investorId: dto.investorId,
          amount,
          mode,
          investmentDate: dto.investmentDate
            ? new Date(dto.investmentDate)
            : undefined,
          reason: dto.reason,
          remarks: dto.remarks,
          chequeStatus: keepsCheque
            ? existing.chequeStatus
            : isCheque
              ? ChequeStatus.PENDING
              : null,
          chequeStatusUpdatedAt: keepsCheque
            ? existing.chequeStatusUpdatedAt
            : isCheque
              ? new Date()
              : null,
          chequeNumber: isCheque
            ? (dto.chequeNumber ?? existing.chequeNumber)
            : null,
          bankName: isCheque ? (dto.bankName ?? existing.bankName) : null,
          chequeDate: isCheque
            ? dto.chequeDate
              ? new Date(dto.chequeDate)
              : existing.chequeDate
            : null,
        },
        include: { investor: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_INVESTMENT',
        targetId: investment.id,
        details: `Updated ${investment.amount.isNegative() ? 'withdrawal' : 'investment'} entry for ${investment.investor.name}: ${existing.amount.toString()} -> ${investment.amount.toString()}`,
      });

      return investment;
    }, TRANSACTION_OPTIONS);
  }

  /** Cheque investments/withdrawals only — see cheque-transitions.ts INVESTMENT. */
  async updateChequeStatus(
    id: string,
    status: 'CLEARED' | 'RETURNED' | 'PENDING',
    adminId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Investment" WHERE id = ${id} FOR UPDATE`;
      const investment = await tx.investment.findUnique({
        where: { id },
        include: { investor: true },
      });
      if (!investment) throw new NotFoundException('Investment not found');
      if (investment.mode !== 'CHEQUE') {
        throw new BadRequestException('This entry was not made by cheque');
      }
      if (!investment.chequeStatus) {
        throw new BadRequestException(
          'This cheque was recorded before cheque tracking existed and already counts as cleared',
        );
      }
      assertChequeTransition(
        'INVESTMENT',
        investment.chequeStatus,
        status,
        investment.chequeStatusUpdatedAt,
      );

      const { investor, ...row } = investment;
      await recordLedgerRevision(
        tx,
        'INVESTMENT',
        row,
        'CHEQUE_STATUS',
        adminId,
      );
      const updated = await tx.investment.update({
        where: { id },
        data: { chequeStatus: status, chequeStatusUpdatedAt: new Date() },
        include: { investor: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_INVESTMENT_CHEQUE_STATUS',
        targetId: id,
        details: `${investor.name}'s ${investment.amount.isNegative() ? 'withdrawal' : 'investment'} cheque ${investment.chequeNumber ?? ''} changed from ${investment.chequeStatus} to ${status}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const investment = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const { investor, ...row } = investment;
      await recordLedgerRevision(tx, 'INVESTMENT', row, 'DELETED', adminId);
      const deleted = await tx.investment.deleteMany({ where: { id } });
      if (deleted.count === 0) {
        throw new ConflictException('This entry was already deleted');
      }

      const isWithdrawal = investment.amount.isNegative();
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_INVESTMENT',
        targetId: id,
        details: `Deleted ${isWithdrawal ? 'withdrawal' : 'investment'} of ${investment.amount.abs().toString()} for ${investor.name}`,
      });

      return { message: 'Investment deleted' };
    }, TRANSACTION_OPTIONS);
  }
}
