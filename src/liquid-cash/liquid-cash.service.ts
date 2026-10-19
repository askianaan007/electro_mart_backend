import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { likeContains } from '../common/utils/like-pattern';
import {
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';
import { QueryLiquidCashHistoryDto } from './dto/query-liquid-cash-history.dto';
import { CASH_LEDGER_CTE } from './cash-ledger.sql';
import { sqlUtc } from '../common/utils/sql-time';

function toNumber(value: Prisma.Decimal | string | null | undefined): number {
  return value ? Number(value) : 0;
}

export interface LiquidCashHistoryRow {
  // Unique per row: the source record's id for its first row, and
  // `<sourceId>:<revisionId>` for each later correction of it.
  id: string;
  sourceId: string;
  type:
    | 'INVESTMENT'
    | 'DEALER_PAYMENT'
    | 'SUPPLIER_PAYMENT'
    | 'EXPENSE'
    | 'REFUND'
    | 'ADJUSTMENT';
  // RECORDED for an entry's own row; for corrections what changed it —
  // CHEQUE_CLEARED / CHEQUE_RETURNED / CHEQUE_PENDING, EDITED, DELETED,
  // UNDONE, RESTORED, CANCELLED. For ADJUSTMENT rows: OPENING_BALANCE,
  // ADJUSTMENT or SETTLEMENT_REVERSAL, with a _REVERSAL suffix on the row
  // that reverses one.
  event: string;
  status: 'PENDING' | 'CLEARED' | 'RETURNED' | null;
  date: Date;
  description: string;
  mode: string | null;
  reference: string | null;
  // The real transaction value — always the full amount, even for a
  // pending/returned cheque that hasn't (or never will) move cash. For a
  // correction row it is the correction itself.
  faceAmount: Prisma.Decimal;
  // What actually hit the running balance: 0 for an uncleared cheque.
  amount: Prisma.Decimal;
  createdAt: Date;
  balanceAfter: Prisma.Decimal;
  balanceBefore: Prisma.Decimal;
  // Dated after now (legacy data — new entries can't be future-dated). Shown,
  // but not part of the current balance.
  isFuture: boolean;
}

type Totals = {
  balance: Prisma.Decimal | null;
  scheduled: Prisma.Decimal | null;
  investmentsIn: Prisma.Decimal | null;
  investmentsOut: Prisma.Decimal | null;
  collected: Prisma.Decimal | null;
  paidToSuppliers: Prisma.Decimal | null;
  expenses: Prisma.Decimal | null;
  refundsPaid: Prisma.Decimal | null;
  refundsReceived: Prisma.Decimal | null;
  adjustments: Prisma.Decimal | null;
  openingBalance: Prisma.Decimal | null;
};

@Injectable()
export class LiquidCashService {
  constructor(private prisma: PrismaService) {}

  /**
   * Every Liquid Cash figure is a sum over the one ledger (cash-ledger.sql.ts)
   * — the same rows the history shows — so summary, history, dashboard and
   * balance sheet can't drift apart. Rows dated after `asOf` are excluded
   * from the balance and reported as `scheduled`.
   */
  private async computeTotals(asOf: Date = new Date()) {
    const at = sqlUtc(asOf);
    const [row] = await this.prisma.$queryRaw<Totals[]>`
      ${CASH_LEDGER_CTE}
      SELECT
        SUM(amount) FILTER (WHERE date <= ${at}) AS balance,
        SUM(amount) FILTER (WHERE date > ${at}) AS scheduled,
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'INVESTMENT' AND amount > 0) AS "investmentsIn",
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'INVESTMENT' AND amount < 0) AS "investmentsOut",
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'DEALER_PAYMENT') AS collected,
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'SUPPLIER_PAYMENT') AS "paidToSuppliers",
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'EXPENSE') AS expenses,
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'REFUND' AND amount < 0) AS "refundsPaid",
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'REFUND' AND amount > 0) AS "refundsReceived",
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'ADJUSTMENT' AND event NOT LIKE 'OPENING_BALANCE%') AS adjustments,
        SUM(amount) FILTER (WHERE date <= ${at} AND type = 'ADJUSTMENT' AND event LIKE 'OPENING_BALANCE%') AS "openingBalance"
      FROM combined
    `;
    return row;
  }

  /**
   * Single source of truth for the dashboard's "Cash Position" figure — also
   * consumed by DashboardService so the two can never drift apart.
   */
  async getCurrentBalance(): Promise<number> {
    const totals = await this.computeTotals();
    return toNumber(totals.balance);
  }

  /**
   * Liquid Cash movement over [from, to), by source — the dashboard's
   * monthly cash flow. `netCashFlow` is the change in Liquid Cash itself
   * (everything); `operatingCashFlow` leaves out capital (investments,
   * withdrawals) and evidence-only adjustments.
   */
  async getPeriodTotals(from: Date, to: Date) {
    const [row] = await this.prisma.$queryRaw<
      {
        net: Prisma.Decimal | null;
        capital: Prisma.Decimal | null;
        collected: Prisma.Decimal | null;
        paidToSuppliers: Prisma.Decimal | null;
        expenses: Prisma.Decimal | null;
      }[]
    >`
      ${CASH_LEDGER_CTE}
      SELECT
        SUM(amount) AS net,
        SUM(amount) FILTER (WHERE type IN ('INVESTMENT', 'ADJUSTMENT')) AS capital,
        SUM(amount) FILTER (WHERE type = 'DEALER_PAYMENT') AS collected,
        SUM(amount) FILTER (WHERE type = 'SUPPLIER_PAYMENT') AS "paidToSuppliers",
        SUM(amount) FILTER (WHERE type = 'EXPENSE') AS expenses
      FROM combined
      WHERE date >= ${sqlUtc(from)} AND date < ${sqlUtc(to)} AND date <= ${sqlUtc(new Date())}
    `;
    const net = toNumber(row?.net);
    return {
      netCashFlow: net,
      operatingCashFlow: net - toNumber(row?.capital),
      collected: toNumber(row?.collected),
      paidToSuppliers: -toNumber(row?.paidToSuppliers),
      expenses: -toNumber(row?.expenses),
    };
  }

  async getSummary() {
    const [totals, pending] = await Promise.all([
      this.computeTotals(),
      this.computePending(),
    ]);

    const investmentsIn = toNumber(totals.investmentsIn);
    const investmentsOut = -toNumber(totals.investmentsOut);
    return {
      balance: toNumber(totals.balance),
      // Net capital (deposits − withdrawals); see the split below.
      totalInvestments: investmentsIn - investmentsOut,
      totalDeposits: investmentsIn,
      totalWithdrawals: investmentsOut,
      totalCollected: toNumber(totals.collected),
      totalPaidToSuppliers: -toNumber(totals.paidToSuppliers),
      totalExpensesPaid: -toNumber(totals.expenses),
      totalRefundsPaid: -toNumber(totals.refundsPaid),
      totalRefundsReceived: toNumber(totals.refundsReceived),
      totalAdjustments: toNumber(totals.adjustments),
      openingBalance: toNumber(totals.openingBalance),
      // Legacy rows dated in the future — not in `balance` yet.
      scheduled: toNumber(totals.scheduled),
      // Informational only — not reflected in `balance` above, since the
      // cheques haven't cleared the bank. Money in and money out are kept
      // separate: they must never be netted into one "pending" figure.
      ...pending,
    };
  }

  private async computePending() {
    const [dealer, supplier, investIn, investOut, refundOut, refundIn] =
      await Promise.all([
        this.prisma.payment.aggregate({
          where: { mode: 'CHEQUE', chequeStatus: 'PENDING' },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.supplierPayment.aggregate({
          where: { mode: 'CHEQUE', chequeStatus: 'PENDING' },
          _sum: { amount: true },
          _count: true,
        }),
        this.prisma.investment.aggregate({
          where: { mode: 'CHEQUE', chequeStatus: 'PENDING', amount: { gt: 0 } },
          _sum: { amount: true },
        }),
        this.prisma.investment.aggregate({
          where: { mode: 'CHEQUE', chequeStatus: 'PENDING', amount: { lt: 0 } },
          _sum: { amount: true },
        }),
        this.prisma.refund.aggregate({
          where: {
            party: 'DEALER',
            mode: 'CHEQUE',
            chequeStatus: 'PENDING',
            cancelledAt: null,
          },
          _sum: { amount: true },
        }),
        this.prisma.refund.aggregate({
          where: {
            party: 'SUPPLIER',
            mode: 'CHEQUE',
            chequeStatus: 'PENDING',
            cancelledAt: null,
          },
          _sum: { amount: true },
        }),
      ]);

    const pendingDealerCheques = toNumber(dealer._sum.amount);
    const pendingSupplierCheques = toNumber(supplier._sum.amount);
    const pendingIn =
      pendingDealerCheques +
      toNumber(investIn._sum.amount) +
      toNumber(refundIn._sum.amount);
    const pendingOut =
      pendingSupplierCheques -
      toNumber(investOut._sum.amount) +
      toNumber(refundOut._sum.amount);
    return {
      pendingDealerCheques,
      pendingDealerChequeCount: dealer._count,
      pendingSupplierCheques,
      pendingSupplierChequeCount: supplier._count,
      pendingInvestmentCheques: toNumber(investIn._sum.amount),
      pendingWithdrawalCheques: -toNumber(investOut._sum.amount),
      pendingRefundChequesOut: toNumber(refundOut._sum.amount),
      pendingRefundChequesIn: toNumber(refundIn._sum.amount),
      // Every uncleared cheque coming in / going out, for the two separate
      // "expected" figures on the Liquid Cash page.
      pendingIn,
      pendingOut,
    };
  }

  /**
   * The ledger with a running balance computed via a SQL window function
   * over the *entire* unfiltered history, so the balance is always correct
   * regardless of which page/filters are being viewed. Pending/returned
   * cheques appear as rows (for visibility) but contribute 0 until they
   * clear; corrections appear as their own rows on the day they were made.
   */
  async getHistory(query: QueryLiquidCashHistoryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [];
    if (query.type) {
      conditions.push(Prisma.sql`type = ${query.type}`);
    }
    if (query.dateFrom) {
      conditions.push(
        Prisma.sql`date >= ${sqlUtc(startOfBusinessDay(query.dateFrom))}`,
      );
    }
    if (query.dateTo) {
      conditions.push(
        Prisma.sql`date < ${sqlUtc(startOfNextBusinessDay(query.dateTo))}`,
      );
    }
    if (query.search) {
      conditions.push(
        Prisma.sql`description ILIKE ${likeContains(query.search)} ESCAPE '\\'`,
      );
    }

    const whereClause =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const now = new Date();
    const [data, countResult] = await Promise.all([
      this.prisma.$queryRaw<LiquidCashHistoryRow[]>`
        ${CASH_LEDGER_CTE}
        SELECT *, "balanceAfter" - amount AS "balanceBefore", date > ${sqlUtc(now)} AS "isFuture"
        FROM ledger
        ${whereClause}
        ORDER BY date DESC, "createdAt" DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ count: bigint }[]>`
        ${CASH_LEDGER_CTE}
        SELECT COUNT(*) AS count FROM combined
        ${whereClause}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    return paginate(data, total, page, limit);
  }
}
