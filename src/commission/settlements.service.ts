import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashAdjustmentType,
  ChequeStatus,
  CommissionLineStatus,
  Prisma,
  SettlementStatus,
} from '@prisma/client';
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
import { assertChequeTransition } from '../common/utils/cheque-transitions';
import {
  businessDateOf,
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';

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
   * The period is whole Colombo days, both ends inclusive (LC-21).
   */
  async create(dto: CreateSettlementDto, adminId: string) {
    const rep = await this.prisma.representative.findUnique({
      where: { id: dto.representativeId },
    });
    if (!rep) throw new NotFoundException('Representative not found');

    const periodStart = startOfBusinessDay(dto.periodStart);
    const periodEnd = startOfBusinessDay(dto.periodEnd);
    if (periodEnd < periodStart) {
      throw new BadRequestException('periodEnd must not be before periodStart');
    }

    return this.prisma.$transaction(async (tx) => {
      // Serializes concurrent settlement creation for one representative, so
      // two requests can't both batch the same PENDING lines.
      await tx.$queryRaw`SELECT id FROM "Representative" WHERE id = ${dto.representativeId} FOR UPDATE`;

      const lines = await tx.commissionLedgerEntry.findMany({
        where: {
          representativeId: dto.representativeId,
          status: CommissionLineStatus.PENDING,
          settlementId: null,
          createdAt: {
            gte: periodStart,
            lt: startOfNextBusinessDay(dto.periodEnd),
          },
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

      const claimed = await tx.commissionLedgerEntry.updateMany({
        where: {
          id: { in: lines.map((l) => l.id) },
          status: CommissionLineStatus.PENDING,
          settlementId: null,
        },
        data: {
          status: CommissionLineStatus.APPROVED,
          settlementId: settlement.id,
        },
      });
      if (claimed.count !== lines.length) {
        throw new ConflictException(
          'Some of these commission lines were just settled elsewhere — refresh and try again',
        );
      }

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

    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.representativeSettlement.updateMany({
        where: { id, status: SettlementStatus.PENDING },
        data: {
          status: SettlementStatus.APPROVED,
          approvedByAdminId: adminId,
          approvedAt: new Date(),
        },
      });
      if (moved.count === 0) {
        throw new BadRequestException(
          'Only a pending settlement can be approved',
        );
      }
      await this.activityLogService.log(tx, {
        adminId,
        action: 'APPROVED_SETTLEMENT',
        targetId: id,
        details: `Approved settlement ${settlement.settlementNumber}`,
      });
      return tx.representativeSettlement.findUniqueOrThrow({ where: { id } });
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Rejects a not-yet-paid settlement and releases its lines. Refused while a
   * cheque for it is still PENDING (LC-01): that cheque could still clear and
   * pay the representative, so it must first be marked RETURNED (stopped /
   * never handed over), which records it as not paid.
   */
  async reject(id: string, dto: RejectSettlementDto, adminId: string) {
    const settlement = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockSettlement(tx, id);
      if (
        current.status !== SettlementStatus.PENDING &&
        current.status !== SettlementStatus.APPROVED
      ) {
        throw new BadRequestException(
          `A ${current.status.toLowerCase()} settlement cannot be rejected`,
        );
      }
      if (current.chequeStatus === ChequeStatus.PENDING) {
        throw new BadRequestException(
          'A cheque for this settlement is still pending. Mark it RETURNED (cancelled) before rejecting the settlement.',
        );
      }

      const result = await tx.representativeSettlement.update({
        where: { id },
        data: { status: SettlementStatus.REJECTED, rejectedReason: dto.reason },
      });

      // Release the lines back to PENDING/un-batched so they can be picked
      // up by a future settlement — a rejected settlement must never strand
      // a representative's already-earned commission. Lines reversed since
      // batching stay REVERSED; they're only detached.
      await tx.commissionLedgerEntry.updateMany({
        where: { settlementId: id, status: CommissionLineStatus.APPROVED },
        data: { status: CommissionLineStatus.PENDING, settlementId: null },
      });
      await tx.commissionLedgerEntry.updateMany({
        where: { settlementId: id },
        data: { settlementId: null },
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
   *
   * Runs under a row lock on the settlement and re-checks its state there,
   * so two concurrent pay requests can't both create an Expense (LC-02).
   */
  async pay(id: string, dto: PaySettlementDto, adminId: string) {
    const settlement = await this.findOne(id);
    if (
      dto.mode === 'CHEQUE' &&
      (!dto.chequeNumber || !dto.bankName || !dto.chequeDate)
    ) {
      throw new BadRequestException(
        'chequeNumber, bankName, and chequeDate are required when mode is CHEQUE',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockSettlement(tx, id);
      if (current.status !== SettlementStatus.APPROVED) {
        throw new BadRequestException(
          'Only an approved settlement can be paid',
        );
      }
      if (current.chequeStatus === ChequeStatus.PENDING) {
        throw new BadRequestException(
          'This settlement already has a pending cheque — mark it CLEARED or RETURNED first',
        );
      }
      await this.assertLinesUnchanged(tx, current);

      const isCheque = dto.mode === 'CHEQUE';
      let result = await tx.representativeSettlement.update({
        where: { id },
        data: {
          mode: dto.mode,
          // A re-payment after a returned cheque must not keep the old
          // cheque's details on a cash/bank-transfer payment.
          reference: isCheque ? null : (dto.reference ?? null),
          chequeNumber: isCheque ? dto.chequeNumber : null,
          bankName: isCheque ? dto.bankName : null,
          chequeDate:
            isCheque && dto.chequeDate ? new Date(dto.chequeDate) : null,
          chequeStatus: isCheque ? ChequeStatus.PENDING : null,
        },
      });

      if (!isCheque) {
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

  /**
   * Cheque-mode settlements only. Only an APPROVED settlement's PENDING
   * cheque can change, and only forward (cheque-transitions.ts SETTLEMENT):
   * a rejected settlement's cheque can never clear and pay it (LC-01).
   */
  async updateChequeStatus(
    id: string,
    status: 'CLEARED' | 'RETURNED',
    adminId: string,
  ) {
    const settlement = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockSettlement(tx, id);
      if (current.mode !== 'CHEQUE' || !current.chequeStatus) {
        throw new BadRequestException('This settlement was not paid by cheque');
      }
      if (current.status !== SettlementStatus.APPROVED) {
        throw new BadRequestException(
          `The cheque of a ${current.status.toLowerCase()} settlement cannot change status`,
        );
      }
      assertChequeTransition('SETTLEMENT', current.chequeStatus, status, null);
      if (status === ChequeStatus.CLEARED) {
        await this.assertLinesUnchanged(tx, current);
      }

      let result = await tx.representativeSettlement.update({
        where: { id },
        data: { chequeStatus: status },
      });

      if (status === ChequeStatus.CLEARED) {
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
   * Controlled correction of a PAID settlement (LC-07): the payout's Expense
   * stays exactly as recorded, and a SETTLEMENT_REVERSAL cash adjustment of
   * the same amount is posted today, so Liquid Cash history shows both the
   * payout and its reversal on their own dates. The lines return to PENDING
   * so the still-earned commission can be settled again.
   */
  async reversePayment(id: string, reason: string, adminId: string) {
    const settlement = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockSettlement(tx, id);
      if (current.status !== SettlementStatus.PAID || !current.expenseId) {
        throw new BadRequestException(
          'Only a paid settlement can have its payment reversed',
        );
      }

      const adjustmentNumber = await nextSequenceNumber(
        tx,
        'cashAdjustment',
        'ADJ',
      );
      await tx.cashAdjustment.create({
        data: {
          adjustmentNumber,
          type: CashAdjustmentType.SETTLEMENT_REVERSAL,
          amount: current.totalCommission,
          adjustmentDate: new Date(),
          reason: `Reversal of settlement ${current.settlementNumber} payout: ${reason}`,
          adminId,
          settlementId: id,
        },
      });

      const result = await tx.representativeSettlement.update({
        where: { id },
        data: {
          status: SettlementStatus.REVERSED,
          reversedAt: new Date(),
          reversalReason: reason,
        },
      });

      await tx.commissionLedgerEntry.updateMany({
        where: { settlementId: id, status: CommissionLineStatus.SETTLED },
        data: { status: CommissionLineStatus.PENDING, settlementId: null },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REVERSED_SETTLEMENT_PAYMENT',
        targetId: id,
        details: `Reversed payout of settlement ${settlement.settlementNumber} (${current.totalCommission.toString()}) as ${adjustmentNumber}: ${reason}`,
      });

      return result;
    }, TRANSACTION_OPTIONS);
  }

  private async lockSettlement(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM "RepresentativeSettlement" WHERE id = ${id} FOR UPDATE`;
    return tx.representativeSettlement.findUniqueOrThrow({ where: { id } });
  }

  /**
   * A line reversed after batching (order returned — see
   * CommissionReconciliationService) must not be paid (LC-22). Paying the
   * stored total would overpay, so the settlement has to be redone.
   */
  private async assertLinesUnchanged(
    tx: Prisma.TransactionClient,
    settlement: { id: string; totalCommission: Prisma.Decimal },
  ) {
    const lines = await tx.commissionLedgerEntry.findMany({
      where: { settlementId: settlement.id },
    });
    const payable = lines.filter(
      (l) => l.status === CommissionLineStatus.APPROVED,
    );
    const payableTotal = payable.reduce((sum, l) => sum.add(l.amount), ZERO);
    if (
      payable.length !== lines.length ||
      !payableTotal.equals(settlement.totalCommission)
    ) {
      throw new BadRequestException(
        `${lines.length - payable.length} commission line(s) in this settlement were reversed after it was created. Reject it and create a new settlement.`,
      );
    }
  }

  /**
   * The exact tx.expense.create() call ExpensesService.create() already
   * uses — not a copy of its logic, the identical write, so every existing
   * calculation that sums Expense (computeLiquidCash, netProfit,
   * expenseShare) picks this up automatically (§12.4). The conditional
   * APPROVED → PAID update makes a second payout in the same state
   * impossible even without the caller's lock.
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
        remarks: `Settlement period ${businessDateOf(settlement.periodStart)}–${businessDateOf(settlement.periodEnd)}`,
      },
    });

    const paid = await tx.representativeSettlement.updateMany({
      where: {
        id: settlement.id,
        status: SettlementStatus.APPROVED,
        expenseId: null,
      },
      data: {
        expenseId: expense.id,
        status: SettlementStatus.PAID,
        paidAt: new Date(),
      },
    });
    if (paid.count === 0) {
      throw new ConflictException('This settlement has already been paid');
    }

    await tx.commissionLedgerEntry.updateMany({
      where: {
        settlementId: settlement.id,
        status: CommissionLineStatus.APPROVED,
      },
      data: { status: CommissionLineStatus.SETTLED },
    });

    return tx.representativeSettlement.findUniqueOrThrow({
      where: { id: settlement.id },
    });
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
