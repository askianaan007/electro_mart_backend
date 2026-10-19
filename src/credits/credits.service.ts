import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChequeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { QueryCreditsDto } from './dto/query-credits.dto';
import { QuerySettlementsDto } from './dto/query-settlements.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  computeSupplierBalance,
  EFFECTIVE_PAYMENT_FILTER,
  EFFECTIVE_SUPPLIER_REFUND_FILTER,
  supplierBalance,
} from '../common/utils/supplier-balance';
import { assertChequeTransition } from '../common/utils/cheque-transitions';
import {
  assertNotFutureBusinessDate,
  businessDateRange,
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';
import {
  duplicateWindowStart,
  PossibleDuplicateException,
} from '../common/utils/duplicate-guard';
import { recordLedgerRevision } from '../common/utils/ledger-revision';

const ZERO = new Prisma.Decimal(0);
const DAY_MS = 24 * 60 * 60 * 1000;

// Colombo calendar days, whatever the server's own time zone (Vercel: UTC).
function startOfDay(date: Date): Date {
  return startOfBusinessDay(date);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// How far into the future the dashboard's "upcoming cheques" list looks.
const UPCOMING_CHEQUE_WINDOW_DAYS = 14;

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);

  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
  ) {}

  private async computeCreditBalance(
    supplierId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const c = await computeSupplierBalance(client, supplierId);
    return {
      totalPurchases: c.purchases,
      totalTransportCharges: c.transportCharges,
      totalReturns: c.returns,
      totalReplacements: c.replacements,
      totalSettled: c.settled,
      totalRefundsReceived: c.refundsReceived,
      creditBalance: c.balance,
    };
  }

  async getSummary(query: QueryCreditsDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const suppliers = await this.prisma.supplier.findMany({
      where: query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {},
      orderBy: { name: 'asc' },
    });
    const supplierIds = suppliers.map((s) => s.id);

    const [
      purchaseTotals,
      transportTotals,
      returnTotals,
      paymentTotals,
      replacementTotals,
      refundTotals,
    ] = await Promise.all([
      this.prisma.purchase.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { totalValue: true },
      }),
      this.prisma.purchase.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { transportCharges: true },
      }),
      this.prisma.purchaseReturn.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { totalAmount: true },
      }),
      this.prisma.supplierPayment.groupBy({
        by: ['supplierId'],
        where: {
          supplierId: { in: supplierIds },
          ...EFFECTIVE_PAYMENT_FILTER,
        },
        _sum: { amount: true },
      }),
      this.prisma.purchaseReturnReplacement.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { totalAmount: true },
      }),
      this.prisma.refund.groupBy({
        by: ['supplierId'],
        where: {
          supplierId: { in: supplierIds },
          ...EFFECTIVE_SUPPLIER_REFUND_FILTER,
        },
        _sum: { amount: true },
      }),
    ]);

    const replacementMap = new Map(
      replacementTotals.map((r) => [r.supplierId, r._sum.totalAmount ?? ZERO]),
    );
    const refundMap = new Map(
      refundTotals.map((r) => [r.supplierId as string, r._sum.amount ?? ZERO]),
    );
    const purchaseMap = new Map(
      purchaseTotals.map((r) => [r.supplierId, r._sum.totalValue ?? ZERO]),
    );
    const transportMap = new Map(
      transportTotals.map((r) => [
        r.supplierId,
        r._sum.transportCharges ?? ZERO,
      ]),
    );
    const returnMap = new Map(
      returnTotals.map((r) => [r.supplierId, r._sum.totalAmount ?? ZERO]),
    );
    const paymentMap = new Map(
      paymentTotals.map((r) => [r.supplierId, r._sum.amount ?? ZERO]),
    );

    let entries = suppliers.map((supplier) => {
      const totalPurchases = purchaseMap.get(supplier.id) ?? ZERO;
      const totalTransportCharges = transportMap.get(supplier.id) ?? ZERO;
      const totalReturns = returnMap.get(supplier.id) ?? ZERO;
      const totalSettled = paymentMap.get(supplier.id) ?? ZERO;
      const totalReplacements = replacementMap.get(supplier.id) ?? ZERO;
      const totalRefundsReceived = refundMap.get(supplier.id) ?? ZERO;
      const creditBalance = supplierBalance({
        purchases: totalPurchases,
        transportCharges: totalTransportCharges,
        returns: totalReturns,
        replacements: totalReplacements,
        settled: totalSettled,
        refundsReceived: totalRefundsReceived,
      });
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        totalPurchases,
        totalTransportCharges,
        totalReturns,
        totalReplacements,
        totalSettled,
        totalRefundsReceived,
        creditBalance,
      };
    });

    if (query.onlyOutstanding === 'true') {
      entries = entries.filter((e) => e.creditBalance.greaterThan(ZERO));
    }

    const totals = entries.reduce(
      (acc, e) => ({
        totalPurchases: acc.totalPurchases.add(e.totalPurchases),
        totalTransportCharges: acc.totalTransportCharges.add(
          e.totalTransportCharges,
        ),
        totalReturns: acc.totalReturns.add(e.totalReturns),
        totalReplacements: acc.totalReplacements.add(e.totalReplacements),
        totalSettled: acc.totalSettled.add(e.totalSettled),
        totalRefundsReceived: acc.totalRefundsReceived.add(
          e.totalRefundsReceived,
        ),
        totalCreditBalance: acc.totalCreditBalance.add(e.creditBalance),
      }),
      {
        totalPurchases: ZERO,
        totalTransportCharges: ZERO,
        totalReturns: ZERO,
        totalReplacements: ZERO,
        totalSettled: ZERO,
        totalRefundsReceived: ZERO,
        totalCreditBalance: ZERO,
      },
    );

    const start = (page - 1) * limit;
    const { data, meta } = paginate(
      entries.slice(start, start + limit),
      entries.length,
      page,
      limit,
    );

    return { entries: data, meta, totals };
  }

  async getSupplierDetail(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const balances = await this.computeCreditBalance(supplierId);

    return {
      supplier,
      ...balances,
    };
  }

  async getSettlements(supplierId: string, query: QuerySettlementsDto) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SupplierPaymentWhereInput = {
      supplierId,
      ...(query.mode && { mode: query.mode }),
      ...(query.chequeStatus && { chequeStatus: query.chequeStatus }),
      ...(query.search && {
        reference: { contains: query.search, mode: 'insensitive' },
      }),
      ...((query.dateFrom || query.dateTo) && {
        paymentDate: businessDateRange(query.dateFrom, query.dateTo),
      }),
    };

    const sortOrder = query.sortOrder ?? 'desc';
    const orderBy: Prisma.SupplierPaymentOrderByWithRelationInput[] =
      query.sortBy === 'chequeDepositDate'
        ? [
            { chequeDepositDate: { sort: sortOrder, nulls: 'last' } },
            { paymentDate: 'desc' },
          ]
        : [{ paymentDate: sortOrder }, { createdAt: 'desc' }];

    const [data, total] = await this.prisma.$transaction([
      this.prisma.supplierPayment.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async createSettlement(
    supplierId: string,
    dto: CreateSettlementDto,
    adminId: string,
  ) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    if (dto.mode === 'CHEQUE' && !dto.chequeDepositDate) {
      throw new BadRequestException(
        'Cheque deposit date is required for cheque settlements',
      );
    }
    assertNotFutureBusinessDate(dto.paymentDate, 'Payment date');

    const amount = new Prisma.Decimal(dto.amount);

    return this.prisma.$transaction(async (tx) => {
      // Lock the supplier row so a second concurrent settlement against the
      // same supplier can't read the same pre-write credit balance and also
      // pass the guard below — jointly over-settling beyond what's owed.
      await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${supplierId} FOR UPDATE`;

      if (!dto.confirmDuplicate) {
        const duplicate = await tx.supplierPayment.findFirst({
          where: {
            supplierId,
            amount,
            mode: dto.mode,
            reference: dto.reference ?? null,
            paymentDate: {
              gte: startOfBusinessDay(dto.paymentDate),
              lt: startOfNextBusinessDay(dto.paymentDate),
            },
            createdAt: { gte: duplicateWindowStart() },
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new PossibleDuplicateException('settlement', duplicate.id);
        }
      }

      const { creditBalance } = await this.computeCreditBalance(supplierId, tx);
      if (amount.greaterThan(creditBalance)) {
        throw new BadRequestException(
          'Settlement amount exceeds the outstanding credit balance',
        );
      }

      const payment = await tx.supplierPayment.create({
        data: {
          supplierId,
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus:
            dto.mode === 'CHEQUE' ? ChequeStatus.PENDING : undefined,
          chequeStatusUpdatedAt: dto.mode === 'CHEQUE' ? new Date() : undefined,
          chequeDepositDate:
            dto.mode === 'CHEQUE' && dto.chequeDepositDate
              ? new Date(dto.chequeDepositDate)
              : undefined,
          remarks: dto.remarks,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_SUPPLIER_SETTLEMENT',
        targetId: payment.id,
        details: `${dto.mode} settlement of ${amount.toString()} to ${supplier.name}`,
      });

      return payment;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Legal changes are listed in cheque-transitions.ts (SUPPLIER). Reverting
   * a RETURNED cheque to PENDING counts it as paid again, so it is refused if
   * the supplier no longer has that much outstanding — e.g. a replacement
   * payment already settled the debt the bounced cheque was for (LC-03).
   * Runs under the supplier's row lock, the same lock new settlements take.
   */
  async updateChequeStatus(
    paymentId: string,
    status: 'CLEARED' | 'RETURNED' | 'PENDING',
    adminId: string,
  ) {
    const existing = await this.prisma.supplierPayment.findUnique({
      where: { id: paymentId },
    });
    if (!existing) throw new NotFoundException('Settlement not found');
    if (existing.mode !== 'CHEQUE') {
      throw new BadRequestException(
        'Only cheque settlements have a cheque status',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${existing.supplierId} FOR UPDATE`;
      const payment = await tx.supplierPayment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      assertChequeTransition(
        'SUPPLIER',
        payment.chequeStatus,
        status,
        payment.chequeStatusUpdatedAt,
      );

      if (payment.chequeStatus === ChequeStatus.RETURNED) {
        const { creditBalance } = await this.computeCreditBalance(
          payment.supplierId,
          tx,
        );
        if (payment.amount.greaterThan(creditBalance)) {
          throw new BadRequestException(
            `This returned cheque can't be reinstated: the supplier's outstanding balance is ${creditBalance.toString()}, ` +
              `less than the cheque's ${payment.amount.toString()} — it has already been settled another way.`,
          );
        }
      }

      await recordLedgerRevision(
        tx,
        'SUPPLIER_PAYMENT',
        payment,
        'CHEQUE_STATUS',
        adminId,
      );
      const moved = await tx.supplierPayment.updateMany({
        where: { id: paymentId, chequeStatus: payment.chequeStatus },
        data: { chequeStatus: status, chequeStatusUpdatedAt: new Date() },
      });
      if (moved.count === 0) {
        throw new ConflictException(
          'This cheque was changed in the meantime — refresh and try again',
        );
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_CHEQUE_STATUS',
        targetId: paymentId,
        details: `Cheque ${payment.reference ?? paymentId} changed from ${payment.chequeStatus} to ${status}`,
      });

      return tx.supplierPayment.findUniqueOrThrow({ where: { id: paymentId } });
    }, TRANSACTION_OPTIONS);
  }

  async deleteSettlement(paymentId: string, adminId: string) {
    const payment = await this.prisma.supplierPayment.findUnique({
      where: { id: paymentId },
      include: { supplier: true },
    });
    if (!payment) throw new NotFoundException('Settlement not found');
    if (Date.now() - payment.createdAt.getTime() > DAY_MS) {
      throw new BadRequestException(
        'This settlement can only be deleted within 1 day of being recorded',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { supplier, ...row } = payment;
      await recordLedgerRevision(
        tx,
        'SUPPLIER_PAYMENT',
        row,
        'DELETED',
        adminId,
      );
      await tx.supplierPayment.delete({ where: { id: paymentId } });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_SUPPLIER_SETTLEMENT',
        targetId: paymentId,
        details: `Deleted ${payment.mode} settlement of ${payment.amount.toString()} to ${supplier.name}`,
      });

      return { message: 'Settlement deleted' };
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Cheques still PENDING whose deposit date has already passed (overdue) or
   * falls within the next UPCOMING_CHEQUE_WINDOW_DAYS days — feeds the
   * dashboard's "upcoming cheques" widget. Overdue cheques are always
   * included regardless of how long ago they fell due, so nothing silently
   * drops off the list until it's actually cleared or returned.
   */
  async getUpcomingCheques() {
    const today = startOfDay(new Date());
    const windowEnd = addDays(today, UPCOMING_CHEQUE_WINDOW_DAYS + 1);

    const cheques = await this.prisma.supplierPayment.findMany({
      where: {
        mode: 'CHEQUE',
        chequeStatus: 'PENDING',
        chequeDepositDate: { lt: windowEnd },
      },
      include: { supplier: true },
      orderBy: { chequeDepositDate: 'asc' },
    });

    const rows = cheques.map((cheque) => {
      const depositDate = cheque.chequeDepositDate as Date;
      const daysUntilDue = Math.round(
        (startOfDay(depositDate).getTime() - today.getTime()) / DAY_MS,
      );
      return {
        id: cheque.id,
        supplierId: cheque.supplierId,
        supplierName: cheque.supplier.name,
        amount: cheque.amount,
        reference: cheque.reference,
        chequeDepositDate: depositDate,
        daysUntilDue,
        isDue: daysUntilDue <= 0,
      };
    });

    const due = rows.filter((row) => row.isDue);

    return {
      cheques: rows,
      dueCount: due.length,
      dueTotal: due.reduce((sum, row) => sum.add(row.amount), ZERO).toNumber(),
      upcomingCount: rows.length - due.length,
    };
  }

  /**
   * Emails every admin a reminder for cheques due for bank deposit tomorrow.
   * Runs daily; chequeReminderSentAt guards against double-sending if the
   * job is ever triggered twice in the same day (e.g. a manual re-run).
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendChequeDepositReminders() {
    const tomorrow = startOfDay(addDays(new Date(), 1));
    const dayAfterTomorrow = addDays(tomorrow, 1);

    const dueTomorrow = await this.prisma.supplierPayment.findMany({
      where: {
        mode: 'CHEQUE',
        chequeStatus: 'PENDING',
        chequeDepositDate: { gte: tomorrow, lt: dayAfterTomorrow },
        chequeReminderSentAt: null,
      },
      include: { supplier: true },
    });

    if (dueTomorrow.length === 0) {
      return { remindersSent: 0, chequeCount: 0 };
    }

    const admins = await this.prisma.admin.findMany({
      select: { email: true },
    });
    const cheques = dueTomorrow.map((cheque) => ({
      supplierName: cheque.supplier.name,
      amount: cheque.amount.toString(),
      chequeDepositDate: cheque.chequeDepositDate as Date,
      reference: cheque.reference,
    }));

    const results = await Promise.allSettled(
      admins.map((admin) =>
        this.mailer.notifyAdminChequeDepositReminder(admin.email, cheques),
      ),
    );
    const sent = results.filter((r) => r.status === 'fulfilled').length;

    await this.prisma.supplierPayment.updateMany({
      where: { id: { in: dueTomorrow.map((cheque) => cheque.id) } },
      data: { chequeReminderSentAt: new Date() },
    });

    this.logger.log(
      `Sent cheque deposit reminders for ${dueTomorrow.length} cheque(s) to ${sent}/${admins.length} admin(s)`,
    );

    return { remindersSent: sent, chequeCount: dueTomorrow.length };
  }
}
