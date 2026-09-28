import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { QueryCreditBalanceHistoryDto } from './dto/query-credit-balance-history.dto';
import {
  EFFECTIVE_PAYMENT_FILTER,
  supplierBalance,
} from '../common/utils/supplier-balance';

const DAY_MS = 24 * 60 * 60 * 1000;

// Settlement cheques count as paid unless RETURNED (EFFECTIVE_PAYMENT_FILTER)
// — the opposite timing rule from Liquid Cash, where a cheque only moves
// real cash once CLEARED; here the payable is settled unless proven otherwise.

function toNumber(value: Prisma.Decimal | null | undefined): number {
  return value ? Number(value) : 0;
}

export interface CreditBalanceHistoryRow {
  id: string;
  type:
    | 'PURCHASE'
    | 'TRANSPORT_CHARGE'
    | 'PURCHASE_RETURN'
    | 'RETURN_REPLACEMENT'
    | 'SETTLEMENT';
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
   * The aggregates that make up the company-wide Credit Balance (total
   * owed to suppliers) — the same supplierBalance() formula CreditsService
   * uses per supplier, summed globally instead of grouped by supplier.
   */
  private async computeBalanceBreakdown() {
    const [purchaseAgg, transportAgg, returnAgg, replacementAgg, paymentAgg] =
      await Promise.all([
        this.prisma.purchase.aggregate({ _sum: { totalValue: true } }),
        this.prisma.purchase.aggregate({ _sum: { transportCharges: true } }),
        this.prisma.purchaseReturn.aggregate({ _sum: { totalAmount: true } }),
        this.prisma.purchaseReturnReplacement.aggregate({
          _sum: { totalAmount: true },
        }),
        this.prisma.supplierPayment.aggregate({
          where: EFFECTIVE_PAYMENT_FILTER,
          _sum: { amount: true },
        }),
      ]);

    const ZERO = new Prisma.Decimal(0);
    const balance = supplierBalance({
      purchases: purchaseAgg._sum.totalValue ?? ZERO,
      transportCharges: transportAgg._sum.transportCharges ?? ZERO,
      returns: returnAgg._sum.totalAmount ?? ZERO,
      replacements: replacementAgg._sum.totalAmount ?? ZERO,
      settled: paymentAgg._sum.amount ?? ZERO,
    });

    return {
      balance: toNumber(balance),
      totalPurchases: toNumber(purchaseAgg._sum.totalValue),
      totalTransportCharges: toNumber(transportAgg._sum.transportCharges),
      totalReturns: toNumber(returnAgg._sum.totalAmount),
      totalReplacements: toNumber(replacementAgg._sum.totalAmount),
      totalSettled: toNumber(paymentAgg._sum.amount),
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
   * Every purchase, transport charge, purchase return, return replacement
   * receipt, and settlement that
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

        -- Mirrors supplierBalance(): replacements add back what returns took off.
        SELECT
          rr.id AS id,
          'RETURN_REPLACEMENT'::text AS type,
          NULL::text AS status,
          rr."receivedDate" AS date,
          (s.name || ' — Replacement #' || rr."replacementNumber" || ' for Return #' || pr."returnNumber") AS description,
          NULL::text AS mode,
          rr."replacementNumber" AS reference,
          rr."totalAmount" AS "faceAmount",
          rr."totalAmount" AS amount,
          rr."createdAt" AS "createdAt"
        FROM "PurchaseReturnReplacement" rr
        JOIN "Supplier" s ON s.id = rr."supplierId"
        JOIN "PurchaseReturn" pr ON pr.id = rr."purchaseReturnId"

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
