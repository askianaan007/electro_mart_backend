import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { QueryLiquidCashHistoryDto } from './dto/query-liquid-cash-history.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors DashboardService's cleared-cheque rule: cash/bank-transfer moves
// money immediately, a cheque doesn't until it actually CLEARS. Kept in sync
// with the same filter shape used there for the monthly KPIs.
const DEALER_CLEARED_FILTER: Prisma.PaymentWhereInput = {
  OR: [
    { mode: { not: 'CHEQUE' } },
    { mode: 'CHEQUE', chequeStatus: 'CLEARED' },
  ],
};
const SUPPLIER_CLEARED_FILTER: Prisma.SupplierPaymentWhereInput = {
  OR: [
    { mode: { not: 'CHEQUE' } },
    { mode: 'CHEQUE', chequeStatus: 'CLEARED' },
  ],
};

function toNumber(value: Prisma.Decimal | null | undefined): number {
  return value ? Number(value) : 0;
}

export interface LiquidCashHistoryRow {
  id: string;
  type: 'INVESTMENT' | 'DEALER_PAYMENT' | 'SUPPLIER_PAYMENT' | 'EXPENSE';
  status: 'PENDING' | 'CLEARED' | 'RETURNED' | null;
  date: Date;
  description: string;
  mode: string | null;
  reference: string | null;
  // The real transaction value — always the full amount, even for a
  // pending/returned cheque that hasn't (or never will) move cash.
  faceAmount: Prisma.Decimal;
  // What actually hit the running balance: 0 for an uncleared cheque, equal
  // to faceAmount otherwise. balanceBefore === balanceAfter on a row exactly
  // when this was 0 — the visual cue that nothing moved yet.
  amount: Prisma.Decimal;
  createdAt: Date;
  balanceAfter: Prisma.Decimal;
  balanceBefore: Prisma.Decimal;
}

@Injectable()
export class LiquidCashService {
  constructor(private prisma: PrismaService) {}

  /**
   * The four aggregates that make up Liquid Cash. Investments/expenses count
   * unconditionally; dealer/supplier payments only once cleared (see the
   * *_CLEARED_FILTER constants above) — a pending or returned cheque hasn't
   * actually moved through the bank.
   */
  private async computeBalanceBreakdown() {
    const [investmentAgg, paymentAgg, supplierPaymentAgg, expenseAgg] =
      await Promise.all([
        this.prisma.investment.aggregate({ _sum: { amount: true } }),
        this.prisma.payment.aggregate({
          where: DEALER_CLEARED_FILTER,
          _sum: { amount: true },
        }),
        this.prisma.supplierPayment.aggregate({
          where: SUPPLIER_CLEARED_FILTER,
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({ _sum: { amount: true } }),
      ]);

    const totalInvestments = toNumber(investmentAgg._sum.amount);
    const totalCollected = toNumber(paymentAgg._sum.amount);
    const totalPaidToSuppliers = toNumber(supplierPaymentAgg._sum.amount);
    const totalExpensesPaid = toNumber(expenseAgg._sum.amount);
    const balance =
      totalInvestments + totalCollected - totalPaidToSuppliers - totalExpensesPaid;

    return {
      balance,
      totalInvestments,
      totalCollected,
      totalPaidToSuppliers,
      totalExpensesPaid,
    };
  }

  /**
   * Single source of truth for the dashboard's "Cash Position" figure — also
   * consumed by DashboardService so the two can never drift apart.
   */
  async getCurrentBalance(): Promise<number> {
    const { balance } = await this.computeBalanceBreakdown();
    return balance;
  }

  async getSummary() {
    const [breakdown, pendingDealerAgg, pendingSupplierAgg] = await Promise.all([
      this.computeBalanceBreakdown(),
      this.prisma.payment.aggregate({
        where: { mode: 'CHEQUE', chequeStatus: 'PENDING' },
        _sum: { amount: true },
      }),
      this.prisma.supplierPayment.aggregate({
        where: { mode: 'CHEQUE', chequeStatus: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);

    return {
      ...breakdown,
      // Informational only — not yet reflected in `balance` above, since the
      // cheques haven't cleared the bank.
      pendingDealerCheques: toNumber(pendingDealerAgg._sum.amount),
      pendingSupplierCheques: toNumber(pendingSupplierAgg._sum.amount),
    };
  }

  /**
   * Every event that has ever (or will, once cleared) moved Liquid Cash,
   * merged into one chronological ledger with a running balance — computed
   * via a SQL window function over the *entire* unfiltered history so the
   * balance is always correct regardless of which page/filters are being
   * viewed. Pending/returned cheques still appear as rows (for visibility)
   * but contribute 0 to the running balance until they clear, which is why
   * inserting them anywhere in the ordering can't corrupt other rows' totals.
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
      conditions.push(Prisma.sql`date >= ${new Date(query.dateFrom)}`);
    }
    if (query.dateTo) {
      conditions.push(
        Prisma.sql`date < ${new Date(new Date(query.dateTo).getTime() + DAY_MS)}`,
      );
    }
    if (query.search) {
      const term = `%${query.search}%`;
      conditions.push(Prisma.sql`description ILIKE ${term}`);
    }

    const whereClause =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const ledgerCte = Prisma.sql`
      WITH combined AS (
        SELECT
          i.id AS id,
          'INVESTMENT'::text AS type,
          NULL::text AS status,
          i."investmentDate" AS date,
          (inv.name || ' — ' || i.reason) AS description,
          i.mode::text AS mode,
          NULL::text AS reference,
          i.amount AS "faceAmount",
          i.amount AS amount,
          i."createdAt" AS "createdAt"
        FROM "Investment" i
        JOIN "Investor" inv ON inv.id = i."investorId"

        UNION ALL

        SELECT
          p.id AS id,
          'DEALER_PAYMENT'::text AS type,
          CASE WHEN p.mode = 'CHEQUE' THEN p."chequeStatus"::text ELSE NULL END AS status,
          CASE
            WHEN p.mode = 'CHEQUE' AND p."chequeStatus" = 'CLEARED'
              THEN COALESCE(p."chequeStatusUpdatedAt", p."paymentDate")
            ELSE p."paymentDate"
          END AS date,
          (d."businessName" || CASE WHEN p.reference IS NOT NULL AND p.reference <> '' THEN ' — ' || p.reference ELSE '' END) AS description,
          p.mode::text AS mode,
          p.reference AS reference,
          p.amount AS "faceAmount",
          CASE
            WHEN p.mode = 'CHEQUE' AND p."chequeStatus" IS DISTINCT FROM 'CLEARED' THEN 0::numeric
            ELSE p.amount
          END AS amount,
          p."createdAt" AS "createdAt"
        FROM "Payment" p
        JOIN "Dealer" d ON d.id = p."dealerId"

        UNION ALL

        SELECT
          sp.id AS id,
          'SUPPLIER_PAYMENT'::text AS type,
          CASE WHEN sp.mode = 'CHEQUE' THEN sp."chequeStatus"::text ELSE NULL END AS status,
          CASE
            WHEN sp.mode = 'CHEQUE' AND sp."chequeStatus" = 'CLEARED'
              THEN COALESCE(sp."chequeStatusUpdatedAt", sp."paymentDate")
            ELSE sp."paymentDate"
          END AS date,
          (s.name || CASE WHEN sp.reference IS NOT NULL AND sp.reference <> '' THEN ' — ' || sp.reference ELSE '' END) AS description,
          sp.mode::text AS mode,
          sp.reference AS reference,
          (sp.amount * -1) AS "faceAmount",
          CASE
            WHEN sp.mode = 'CHEQUE' AND sp."chequeStatus" IS DISTINCT FROM 'CLEARED' THEN 0::numeric
            ELSE (sp.amount * -1)
          END AS amount,
          sp."createdAt" AS "createdAt"
        FROM "SupplierPayment" sp
        JOIN "Supplier" s ON s.id = sp."supplierId"

        UNION ALL

        SELECT
          e.id AS id,
          'EXPENSE'::text AS type,
          NULL::text AS status,
          e."expenseDate" AS date,
          e.description AS description,
          NULL::text AS mode,
          NULL::text AS reference,
          (e.amount * -1) AS "faceAmount",
          (e.amount * -1) AS amount,
          e."createdAt" AS "createdAt"
        FROM "Expense" e
      ),
      ledger AS (
        SELECT *,
          SUM(amount) OVER (
            ORDER BY date ASC, "createdAt" ASC, id ASC
            ROWS UNBOUNDED PRECEDING
          ) AS "balanceAfter"
        FROM combined
      )
    `;

    const [data, countResult] = await Promise.all([
      this.prisma.$queryRaw<LiquidCashHistoryRow[]>`
        ${ledgerCte}
        SELECT *, "balanceAfter" - amount AS "balanceBefore"
        FROM ledger
        ${whereClause}
        ORDER BY date DESC, "createdAt" DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ count: bigint }[]>`
        ${ledgerCte}
        SELECT COUNT(*) AS count FROM combined
        ${whereClause}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    return paginate(data, total, page, limit);
  }
}
