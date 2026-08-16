import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommissionLineStatus, Prisma, SettlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { RejectSettlementDto } from './dto/reject-settlement.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';
import { QuerySettlementDto } from './dto/query-settlement.dto';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const ZERO = new Prisma.Decimal(0);

/**
 * The commission-side mirror of Payments/Credits (version2_changes_backend.md
 * §11). Never calls PaymentsService, InvoicesService, or OrdersService — the
 * only point of contact with existing financial tables is
 * createSettlementExpense() (§12), which only ever *creates* a new Expense
 * row via the exact same tx.expense.create() ExpensesService.create() uses.
 */
@Injectable()
export class SettlementsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
  ) {}

  async findAll(query: QuerySettlementDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.RepresentativeSettlementWhereInput = {
      status: query.status,
      representativeId: query.representativeId,
      ...(query.search && {
        settlementNumber: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.representativeSettlement.findMany({
        where,
        include: {
          representative: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representativeSettlement.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const settlement = await this.prisma.representativeSettlement.findUnique({
      where: { id },
      include: {
        representative: {
          select: { id: true, name: true, email: true, phone: true },
        },
        lines: {
          include: {
            product: true,
            order: { select: { id: true, orderNumber: true } },
          },
        },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return settlement;
  }

  /**
   * Batches a representative's eligible (PENDING) ledger lines for a period
   * into a new PENDING settlement, marking those lines APPROVED
   * (pending-settlement — i.e. spoken for by this settlement, not yet paid).
   */
  async create(dto: CreateSettlementDto, adminId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { id: dto.representativeId },
    });
    if (!rep) throw new NotFoundException('Representative not found');

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    const lines = await this.prisma.commissionLedgerEntry.findMany({
      where: {
        representativeId: dto.representativeId,
        status: CommissionLineStatus.PENDING,
        settlementId: null,
        createdAt: { gte: periodStart, lte: periodEnd },
      },
    });
    if (lines.length === 0) {
      throw new BadRequestException(
        'No pending commission lines found for this representative in the given period',
      );
    }

    const totalCommission = lines.reduce(
      (sum, line) => sum.add(line.amount),
      ZERO,
    );

    return this.prisma.$transaction(async (tx) => {
      const settlementNumber = await nextSequenceNumber(
        tx,
        'settlement',
        'STL',
      );

      const settlement = await tx.representativeSettlement.create({
        data: {
          settlementNumber,
          representativeId: dto.representativeId,
          periodStart,
          periodEnd,
          totalCommission,
          status: SettlementStatus.PENDING,
        },
      });

      await tx.commissionLedgerEntry.updateMany({
        where: { id: { in: lines.map((l) => l.id) } },
        data: {
          status: CommissionLineStatus.APPROVED,
          settlementId: settlement.id,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_SETTLEMENT',
        targetId: settlement.id,
        details: `Created settlement ${settlementNumber} for ${rep.name}: ${lines.length} line(s), ${totalCommission.toString()}`,
      });

      return settlement;
    }, TRANSACTION_OPTIONS);
  }

  async approve(id: string, adminId: string) {
    const settlement = await this.findOne(id);
    if (settlement.status !== SettlementStatus.PENDING) {
      throw new BadRequestException(
        'Only a pending settlement can be approved',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.representativeSettlement.update({
        where: { id },
        data: {
          status: SettlementStatus.APPROVED,
          approvedByAdminId: adminId,
          approvedAt: new Date(),
        },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'APPROVED_SETTLEMENT',
        targetId: id,
        details: `Approved settlement ${settlement.settlementNumber}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async reject(id: string, dto: RejectSettlementDto, adminId: string) {
    const settlement = await this.findOne(id);
    if (settlement.status === SettlementStatus.PAID) {
      throw new BadRequestException('A paid settlement cannot be rejected');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.representativeSettlement.update({
        where: { id },
        data: { status: SettlementStatus.REJECTED, rejectedReason: dto.reason },
      });

      // Release the lines back to PENDING/un-batched so they can be picked
      // up by a future settlement — a rejected settlement must never strand
      // a representative's already-earned commission.
      await tx.commissionLedgerEntry.updateMany({
        where: { settlementId: id },
        data: { status: CommissionLineStatus.PENDING, settlementId: null },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REJECTED_SETTLEMENT',
        targetId: id,
        details: `Rejected settlement ${settlement.settlementNumber}: ${dto.reason}`,
      });

      return result;
    }, TRANSACTION_OPTIONS);

    await this.mailer
      .notifyRepSettlementRejected(
        settlement.representative.email,
        settlement.representative.name,
        settlement.settlementNumber,
        dto.reason,
      )
      .catch(() => undefined);

    return updated;
  }

  /**
   * Records how a settlement was paid. For CASH/BANK_TRANSFER this
   * immediately creates the Expense row (§12). For CHEQUE, the Expense is
   * deferred until the cheque clears (updateChequeStatus below) — mirroring
   * exactly how a customer cheque payment doesn't count as "collected"
   * until it clears.
   */
  async pay(id: string, dto: PaySettlementDto, adminId: string) {
    const settlement = await this.findOne(id);
    if (settlement.status !== SettlementStatus.APPROVED) {
      throw new BadRequestException('Only an approved settlement can be paid');
    }
    if (
      dto.mode === 'CHEQUE' &&
      (!dto.chequeNumber || !dto.bankName || !dto.chequeDate)
    ) {
      throw new BadRequestException(
        'chequeNumber, bankName, and chequeDate are required when mode is CHEQUE',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      let result = await tx.representativeSettlement.update({
        where: { id },
        data: {
          mode: dto.mode,
          chequeNumber: dto.chequeNumber,
          bankName: dto.bankName,
          chequeDate: dto.chequeDate ? new Date(dto.chequeDate) : undefined,
          chequeStatus: dto.mode === 'CHEQUE' ? 'PENDING' : undefined,
        },
      });

      if (dto.mode !== 'CHEQUE') {
        result = await this.createSettlementExpense(tx, result);
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'PAID_SETTLEMENT',
        targetId: id,
        details: `Recorded payment for settlement ${settlement.settlementNumber} via ${dto.mode}`,
      });

      return result;
    }, TRANSACTION_OPTIONS);

    if (updated.status === SettlementStatus.PAID) {
      await this.mailer
        .notifyRepSettlementPaid(
          settlement.representative.email,
          settlement.representative.name,
          settlement.settlementNumber,
          settlement.totalCommission.toString(),
          dto.mode,
        )
        .catch(() => undefined);
    }

    return updated;
  }

  /** Cheque-mode settlements only — mirrors PaymentsService.updateChequeStatus's own transition guard shape. */
  async updateChequeStatus(
    id: string,
    status: 'CLEARED' | 'RETURNED',
    adminId: string,
  ) {
    const settlement = await this.findOne(id);
    if (settlement.mode !== 'CHEQUE' || !settlement.chequeStatus) {
      throw new BadRequestException('This settlement was not paid by cheque');
    }
    if (settlement.chequeStatus !== 'PENDING') {
      throw new BadRequestException(
        `This cheque is already marked ${settlement.chequeStatus}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      let result = await tx.representativeSettlement.update({
        where: { id },
        data: { chequeStatus: status },
      });

      if (status === 'CLEARED') {
        result = await this.createSettlementExpense(tx, result);
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_SETTLEMENT_CHEQUE_STATUS',
        targetId: id,
        details: `Settlement ${settlement.settlementNumber}'s cheque marked ${status}`,
      });

      return result;
    }, TRANSACTION_OPTIONS);

    if (updated.status === SettlementStatus.PAID) {
      await this.mailer
        .notifyRepSettlementPaid(
          settlement.representative.email,
          settlement.representative.name,
          settlement.settlementNumber,
          settlement.totalCommission.toString(),
          'CHEQUE',
        )
        .catch(() => undefined);
    }

    return updated;
  }

  /**
   * The exact tx.expense.create() call ExpensesService.create() already
   * uses — not a copy of its logic, the identical write, so every existing
   * calculation that sums Expense (computeLiquidCash, netProfit,
   * expenseShare) picks this up automatically (§12.4).
   */
  private async createSettlementExpense(
    tx: Prisma.TransactionClient,
    settlement: {
      id: string;
      settlementNumber: string;
      totalCommission: Prisma.Decimal;
      representativeId: string;
      periodStart: Date;
      periodEnd: Date;
    },
  ) {
    const rep = await tx.representative.findUniqueOrThrow({
      where: { id: settlement.representativeId },
    });

    const expense = await tx.expense.create({
      data: {
        description: `Representative commission settlement — ${rep.name} (${settlement.settlementNumber})`,
        amount: settlement.totalCommission,
        expenseDate: new Date(),
        remarks: `Settlement period ${settlement.periodStart.toISOString().slice(0, 10)}–${settlement.periodEnd.toISOString().slice(0, 10)}`,
      },
    });

    const updated = await tx.representativeSettlement.update({
      where: { id: settlement.id },
      data: {
        expenseId: expense.id,
        status: SettlementStatus.PAID,
        paidAt: new Date(),
      },
    });

    await tx.commissionLedgerEntry.updateMany({
      where: { settlementId: settlement.id },
      data: { status: CommissionLineStatus.SETTLED },
    });

    return updated;
  }

  // -------------------------------------------------------------------
  // Dashboard / summary reads (§11.5)
  // -------------------------------------------------------------------

  async dashboard() {
    const [
      pendingAgg,
      approvedAgg,
      paidAgg,
      pendingSettlements,
      paidSettlementsThisMonth,
    ] = await Promise.all([
      this.prisma.commissionLedgerEntry.aggregate({
        where: { status: CommissionLineStatus.PENDING },
        _sum: { amount: true },
      }),
      this.prisma.commissionLedgerEntry.aggregate({
        where: { status: CommissionLineStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.commissionLedgerEntry.aggregate({
        where: { status: CommissionLineStatus.SETTLED },
        _sum: { amount: true },
      }),
      this.prisma.representativeSettlement.count({
        where: { status: SettlementStatus.PENDING },
      }),
      this.prisma.representativeSettlement.aggregate({
        where: {
          status: SettlementStatus.PAID,
          paidAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
        },
        _sum: { totalCommission: true },
        _count: true,
      }),
    ]);

    return {
      pendingCommission: pendingAgg._sum.amount ?? 0,
      approvedCommission: approvedAgg._sum.amount ?? 0,
      settledCommission: paidAgg._sum.amount ?? 0,
      pendingSettlementsCount: pendingSettlements,
      paidThisMonthCount: paidSettlementsThisMonth._count,
      paidThisMonthTotal: paidSettlementsThisMonth._sum.totalCommission ?? 0,
    };
  }

  async representativeSummary(representativeId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { id: representativeId },
    });
    if (!rep) throw new NotFoundException('Representative not found');

    const [pendingAgg, approvedAgg, settledAgg, settlements] =
      await Promise.all([
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId, status: CommissionLineStatus.PENDING },
          _sum: { amount: true },
        }),
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId, status: CommissionLineStatus.APPROVED },
          _sum: { amount: true },
        }),
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId, status: CommissionLineStatus.SETTLED },
          _sum: { amount: true },
        }),
        this.prisma.representativeSettlement.findMany({
          where: { representativeId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    return {
      representativeId,
      representativeName: rep.name,
      pendingCommission: pendingAgg._sum.amount ?? 0,
      approvedCommission: approvedAgg._sum.amount ?? 0,
      settledCommission: settledAgg._sum.amount ?? 0,
      recentSettlements: settlements,
    };
  }
}
