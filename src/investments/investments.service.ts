import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, PaymentMode, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EquityService } from '../equity/equity.service';
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
import { EFFECTIVE_INVESTMENT_FILTER } from '../common/utils/investment-filters';

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
    private equityService: EquityService,
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
   * A withdrawal can't take out more than the investor's current equity
   * (effective contributions + profit share − expense share, EquityService)
   * less withdrawal cheques already written but not yet cleared — LC-16.
   * `excludingId` leaves out the entry being edited.
   *
   * Call inside the write's transaction after lockInvestor(): the lock
   * serializes concurrent withdrawals for one investor, and EquityService
   * reads on its own connection, so it sees every withdrawal committed
   * before the lock was granted.
   */
  private async assertWithdrawalWithinEquity(
    tx: Prisma.TransactionClient,
    investorId: string,
    amount: Prisma.Decimal,
    excludingId?: string,
  ) {
    if (!amount.isNegative()) return;
    const [{ entries }, pending] = await Promise.all([
      this.equityService.getSummary(),
      tx.investment.aggregate({
        where: {
          investorId,
          mode: 'CHEQUE',
          chequeStatus: ChequeStatus.PENDING,
          amount: { lt: 0 },
          ...(excludingId && { id: { not: excludingId } }),
        },
        _sum: { amount: true },
      }),
    ]);
    const entry = entries.find((e) => e.investorId === investorId);
    let equity = (entry?.equity ?? new Prisma.Decimal(0)).add(
      pending._sum.amount ?? 0,
    );
    if (excludingId) {
      const existing = await tx.investment.findFirst({
        where: { id: excludingId, investorId, ...EFFECTIVE_INVESTMENT_FILTER },
      });
      if (existing) equity = equity.sub(existing.amount);
    }
    if (amount.abs().greaterThan(equity)) {
      throw new BadRequestException(
        `Withdrawal of ${amount.abs().toString()} exceeds this investor's available equity of ${equity.toFixed(2)}`,
      );
    }
  }

  private async lockInvestor(tx: Prisma.TransactionClient, investorId: string) {
    await tx.$queryRaw`SELECT id FROM "Investor" WHERE id = ${investorId} FOR UPDATE`;
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
      await this.lockInvestor(tx, dto.investorId);
      await this.assertWithdrawalWithinEquity(tx, dto.investorId, amount);
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
    const investorId = dto.investorId ?? existing.investorId;

    return this.prisma.$transaction(async (tx) => {
      await this.lockInvestor(tx, investorId);
      await this.assertWithdrawalWithinEquity(tx, investorId, amount, id);
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
