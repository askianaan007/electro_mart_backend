import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { likeContains } from '../common/utils/like-pattern';
import { QueryCreditBalanceHistoryDto } from './dto/query-credit-balance-history.dto';
import { computeSupplierBalance } from '../common/utils/supplier-balance';
import {
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';
import { sqlUtc } from '../common/utils/sql-time';

// Supplier balance rules live in common/utils/supplier-balance.ts. Note the
// timing differs from Liquid Cash on purpose: a settlement cheque reduces
// what's owed as soon as it's written (PENDING), but only moves cash once
// CLEARED.

function toNumber(value: Prisma.Decimal | null | undefined): number {
  return value ? Number(value) : 0;
}

export interface CreditBalanceHistoryRow {
  id: string;
  type:
    | 'PURCHASE'
    | 'TRANSPORT_CHARGE'
    | 'PURCHASE_RETURN'
    | 'REPLACEMENT'
    | 'SETTLEMENT'
    | 'REFUND';
  status: 'PENDING' | 'CLEARED' | 'RETURNED' | null;
  date: Date;
  description: string;
  mode: string | null;
  reference: string | null;
  // The real transaction value — even for a settlement cheque that later
  // bounces (RETURNED), whose effect on the balance is then reversed to 0.
  faceAmount: Prisma.Decimal;
  // What actually hit the running balance: 0 for a returned cheque, else
  // equal to faceAmount. Positive = balance owed goes up, negative = down.
  amount: Prisma.Decimal;
  createdAt: Date;
  balanceAfter: Prisma.Decimal;
  balanceBefore: Prisma.Decimal;
}

@Injectable()
export class CreditBalanceService {
  constructor(private prisma: PrismaService) {}

  /**
   * The aggregates that make up the company-wide Credit Balance (total owed
   * to suppliers) — the same supplierBalance() formula CreditsService uses
   * per supplier, summed globally.
   */
  private async computeBalanceBreakdown() {
    const c = await computeSupplierBalance(this.prisma);
    return {
      balance: toNumber(c.balance),
      totalPurchases: toNumber(c.purchases),
      totalTransportCharges: toNumber(c.transportCharges),
      totalReturns: toNumber(c.returns),
      totalReplacements: toNumber(c.replacements),
      totalSettled: toNumber(c.settled),
      totalRefundsReceived: toNumber(c.refundsReceived),
    };
  }

  /**
   * Single source of truth for the dashboard's "Credit Balance" figure —
   * also consumed by DashboardService so the two can never drift apart.
   */
  async getCurrentBalance(): Promise<number> {
    const { balance } = await this.computeBalanceBreakdown();
    return balance;
  }

  async getSummary() {
    const [breakdown, pendingChequeAgg] = await Promise.all([
      this.computeBalanceBreakdown(),
      this.prisma.supplierPayment.aggregate({
        where: { mode: 'CHEQUE', chequeStatus: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);

    return {
      ...breakdown,
      // Already included in `balance` above (pending cheques reduce what's
      // owed immediately) — informational only, flagging what would bounce
      // back onto the balance if any of these cheques are later returned.
      pendingChequeSettlements: toNumber(pendingChequeAgg._sum.amount),
    };
  }

  /**
   * Every purchase, transport charge, purchase return, and settlement that
   * has affected the Credit Balance, merged into one chronological ledger
   * with a running balance — computed via a SQL window function over the
   * *entire* unfiltered history so the balance is always correct regardless
   * of which page/filters are being viewed. A returned settlement cheque
   * still appears as a row (for visibility) but contributes 0 to the running
   * balance, which is why inserting it anywhere in the ordering can't
   * corrupt other rows' totals.
   */
  async getHistory(query: QueryCreditBalanceHistoryDto) {
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

    const ledgerCte = Prisma.sql`
      WITH combined AS (
        SELECT
          p.id AS id,
          'PURCHASE'::text AS type,
          NULL::text AS status,
          p."purchaseDate" AS date,
          (s.name || ' — Invoice #' || p."invoiceNumber") AS description,
          NULL::text AS mode,
          p."invoiceNumber" AS reference,
          p."totalValue" AS "faceAmount",
          p."totalValue" AS amount,
          p."createdAt" AS "createdAt"
        FROM "Purchase" p
        JOIN "Supplier" s ON s.id = p."supplierId"

        UNION ALL

        SELECT
          (p.id || '-transport') AS id,
          'TRANSPORT_CHARGE'::text AS type,
          NULL::text AS status,
          p."purchaseDate" AS date,
          (s.name || ' — Transport for Invoice #' || p."invoiceNumber") AS description,
          NULL::text AS mode,
          p."invoiceNumber" AS reference,
          (p."transportCharges" * -1) AS "faceAmount",
          (p."transportCharges" * -1) AS amount,
          p."createdAt" AS "createdAt"
        FROM "Purchase" p
        JOIN "Supplier" s ON s.id = p."supplierId"
        WHERE p."transportCharges" > 0

        UNION ALL

        SELECT
          pr.id AS id,
          'PURCHASE_RETURN'::text AS type,
          NULL::text AS status,
          pr."returnDate" AS date,
          (s.name || ' — Return #' || pr."returnNumber" || ' (' || pr.reason || ')') AS description,
          NULL::text AS mode,
          pr."returnNumber" AS reference,
          (pr."totalAmount" * -1) AS "faceAmount",
          (pr."totalAmount" * -1) AS amount,
          pr."createdAt" AS "createdAt"
        FROM "PurchaseReturn" pr
        JOIN "Supplier" s ON s.id = pr."supplierId"

        UNION ALL

        SELECT
          rr.id AS id,
          'REPLACEMENT'::text AS type,
          NULL::text AS status,
          rr."receivedDate" AS date,
          (s.name || ' — Replacement #' || rr."replacementNumber") AS description,
          NULL::text AS mode,
          rr."replacementNumber" AS reference,
          rr."totalAmount" AS "faceAmount",
          rr."totalAmount" AS amount,
          rr."createdAt" AS "createdAt"
        FROM "PurchaseReturnReplacement" rr
        JOIN "Supplier" s ON s.id = rr."supplierId"

        UNION ALL

        SELECT
          rf.id AS id,
          'REFUND'::text AS type,
          CASE WHEN rf.mode = 'CHEQUE' THEN rf."chequeStatus"::text ELSE NULL END AS status,
          rf."refundDate" AS date,
          (s.name || ' — Refund received #' || rf."refundNumber") AS description,
          rf.mode::text AS mode,
          rf.reference AS reference,
          rf.amount AS "faceAmount",
          CASE
            WHEN rf."cancelledAt" IS NOT NULL THEN 0::numeric
            WHEN rf.mode = 'CHEQUE' AND rf."chequeStatus" = 'RETURNED' THEN 0::numeric
            ELSE rf.amount
          END AS amount,
          rf."createdAt" AS "createdAt"
        FROM "Refund" rf
        JOIN "Supplier" s ON s.id = rf."supplierId"
        WHERE rf.party = 'SUPPLIER'

        UNION ALL

        SELECT
          sp.id AS id,
          'SETTLEMENT'::text AS type,
          CASE WHEN sp.mode = 'CHEQUE' THEN sp."chequeStatus"::text ELSE NULL END AS status,
          sp."paymentDate" AS date,
          (s.name || CASE WHEN sp.reference IS NOT NULL AND sp.reference <> '' THEN ' — ' || sp.reference ELSE '' END) AS description,
          sp.mode::text AS mode,
          sp.reference AS reference,
          (sp.amount * -1) AS "faceAmount",
          CASE
            WHEN sp.mode = 'CHEQUE' AND sp."chequeStatus" = 'RETURNED' THEN 0::numeric
            ELSE (sp.amount * -1)
          END AS amount,
          sp."createdAt" AS "createdAt"
        FROM "SupplierPayment" sp
        JOIN "Supplier" s ON s.id = sp."supplierId"
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
      this.prisma.$queryRaw<CreditBalanceHistoryRow[]>`
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
