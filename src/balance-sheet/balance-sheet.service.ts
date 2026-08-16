import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LiquidCashService } from '../liquid-cash/liquid-cash.service';
import { CreditBalanceService } from '../credit-balance/credit-balance.service';
import { EquityService } from '../equity/equity.service';
import { BalanceSheetResponse, ReconciliationStatus } from './dto/balance-sheet-response.dto';

const ZERO = new Prisma.Decimal(0);
const TOLERANCE = new Prisma.Decimal('0.01');

function money(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

/**
 * Read-only reporting service. Every query below is a SELECT/aggregate —
 * this service never calls `.create`/`.update`/`.delete`/`.upsert` on any
 * Prisma model, and never mutates `Product`, `Dealer`, `Order`, `Payment`,
 * `SupplierPayment`, `Investment`, `Expense`, or `CommissionLedgerEntry` in
 * any way. See balance_sheet.md for the full accounting specification this
 * implements — every formula below cites the section it comes from.
 *
 * Composes three existing, unmodified services (LiquidCashService,
 * CreditBalanceService, EquityService) rather than re-deriving their
 * formulas, so this module can never drift from the Liquid Cash / Credit
 * Balance / Equity pages that already show these same underlying numbers.
 */
@Injectable()
export class BalanceSheetService {
  constructor(
    private prisma: PrismaService,
    private liquidCashService: LiquidCashService,
    private creditBalanceService: CreditBalanceService,
    private equityService: EquityService,
  ) {}

  async getSummary(): Promise<BalanceSheetResponse> {
    const [
      liquidCash,
      creditBalance,
      equity,
      arAgg,
      contributionsAgg,
      withdrawalsAgg,
      inventoryRows,
      commissionAgg,
      timingRows,
    ] = await Promise.all([
      // §6.1, §6.3 — Cash & Bank, Cheques in Hand. Unchanged existing service.
      this.liquidCashService.getSummary(),
      // §7.1, §7.2 — Accounts Payable, Supplier Cheques Issued. Unchanged existing service.
      this.creditBalanceService.getSummary(),
      // §8 — Equity totals (capital, gross profit, expenses, per-investor-share equity). Unchanged existing service.
      this.equityService.getSummary(),
      // §6.2 — Accounts Receivable: read-only aggregate over the existing Dealer.outstandingBalance column.
      this.prisma.dealer.aggregate({ _sum: { outstandingBalance: true } }),
      // §8.1 — Capital Contributions: Σ Investment.amount where amount > 0 (same sign rule EquityService.getHistory() already uses).
      this.prisma.investment.aggregate({
        where: { amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      // §8.2 — Owner Withdrawals: Σ Investment.amount where amount < 0 (a negative number).
      this.prisma.investment.aggregate({
        where: { amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      // §6.4, §11 — Inventory value: SUM(currentStock × costPrice), read-only raw aggregate.
      this.prisma.$queryRaw<{ value: Prisma.Decimal | null }[]>`
        SELECT SUM("currentStock" * "costPrice") AS value FROM "Product"
      `,
      // §7.3, §10 — Commission Payable (memorandum only, never summed into liabilities below).
      this.prisma.commissionLedgerEntry.aggregate({
        where: { status: { in: ['PENDING', 'APPROVED'] } },
        _sum: { amount: true },
        _count: true,
      }),
      // §12, §13.2 — in-flight order reserved-cost value: orders that have reserved stock
      // (APPROVED/PACKED/DELIVERED) but not yet booked AR/profit (which only happens at COMPLETED).
      this.prisma.$queryRaw<{ value: Prisma.Decimal | null; count: bigint }[]>`
        SELECT SUM(oi.quantity * p."costPrice") AS value, COUNT(DISTINCT o.id) AS count
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Product" p ON p.id = oi."productId"
        WHERE o.status IN ('APPROVED', 'PACKED', 'DELIVERED')
      `,
    ]);

    // ---- Assets (§6) ----
    // LiquidCashService already reduces its figures to JS numbers internally (existing,
    // unmodified behavior) — wrapped in Decimal here so every further sum in *this* module
    // is Decimal-safe, without changing what LiquidCashService itself returns.
    const cashAndBank = new Prisma.Decimal(liquidCash.balance);
    const chequesInHand = new Prisma.Decimal(liquidCash.pendingDealerCheques);
    const accountsReceivable = arAgg._sum.outstandingBalance ?? ZERO;
    const inventory = inventoryRows[0]?.value ?? ZERO;
    const totalCurrentAssets = cashAndBank
      .add(accountsReceivable)
      .add(chequesInHand)
      .add(inventory);
    const totalNonCurrentAssets = ZERO; // §14 — Fixed Assets unsupported, not summed in as 0-with-data
    const totalAssets = totalCurrentAssets.add(totalNonCurrentAssets);

    // ---- Liabilities (§7) — commissionPayable deliberately excluded, see memorandum below ----
    const accountsPayable = new Prisma.Decimal(creditBalance.balance);
    const supplierChequesIssued = new Prisma.Decimal(creditBalance.pendingChequeSettlements);
    const totalCurrentLiabilities = accountsPayable.add(supplierChequesIssued);
    const totalNonCurrentLiabilities = ZERO; // §14 — Business Loans unsupported
    const totalLiabilities = totalCurrentLiabilities.add(totalNonCurrentLiabilities);

    // ---- Equity (§8) — independently sourced from EquityService; never derived from Assets/Liabilities ----
    const capitalContributions = contributionsAgg._sum.amount ?? ZERO;
    const ownerWithdrawals = withdrawalsAgg._sum.amount ?? ZERO; // already negative
    // Gross, all-time accumulated earnings of the business (totalProfit − totalExpenses) —
    // NOT the same as (totalEquity − totalInvestment) whenever investor profit-share
    // percentages don't sum to 100% (see reconciliation.knownUnallocatedEquityDifference below).
    const accumulatedEarningsGross = equity.totals.totalProfit.sub(equity.totals.totalExpenses);
    // The authoritative bottom-line equity figure used in the balance equation — read only
    // from EquityService, never recomputed, never used as a plug (§16.4/§19 no-plug rule).
    const totalEquity = equity.totals.totalEquity;

    // ---- Reconciliation (§13, extended per §13.6 addendum) ----
    const liabilitiesAndEquity = totalLiabilities.add(totalEquity);
    const rawDifference = totalAssets.sub(liabilitiesAndEquity);

    // Known difference #1 — order-timing gap (§12/§13.2): inventory already reduced for
    // in-flight orders, but neither AR nor accumulated earnings reflects them yet.
    const inFlightReservedCost = timingRows[0]?.value ?? ZERO;
    const knownOrderTimingDifference = inFlightReservedCost.neg();
    const inFlightOrderCount = Number(timingRows[0]?.count ?? 0);

    // Known difference #2 — unallocated investor profit share (§13.6 addendum, discovered
    // during implementation): assertProfitShareWithinLimit (investors.service.ts) only
    // caps the total at <= 100%, it never requires exactly 100%. EquityService.totalEquity
    // therefore only attributes `percentageTotal`% of net earnings to named investors — any
    // remainder is real value sitting in Assets (backed by real profit) with no corresponding
    // entry in totalEquity. Computed purely from EquityService's own already-returned totals;
    // EquityService itself is not touched or re-derived.
    const investorPercentageTotal = equity.totals.percentageTotal;
    const knownUnallocatedEquityDifference = accumulatedEarningsGross.sub(
      totalEquity.sub(equity.totals.totalInvestment),
    );

    const knownDifference = knownOrderTimingDifference.add(knownUnallocatedEquityDifference);
    const unexplainedDifference = rawDifference.sub(knownDifference);

    let status: ReconciliationStatus;
    if (rawDifference.abs().lessThan(TOLERANCE)) {
      status = 'BALANCED';
    } else if (unexplainedDifference.abs().lessThan(TOLERANCE)) {
      status = 'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE';
    } else {
      status = 'UNBALANCED';
    }

    // ---- Commission Payable — memorandum only, §10 Option B. Never added to any total above. ----
    const commissionPayableValue = commissionAgg._sum.amount ?? ZERO;
    const commissionPayableCount = commissionAgg._count ?? 0;

    const accountingWarnings: string[] = [
      'commissionPayable (see memorandum) is excluded from totalLiabilities and the balance-sheet equation — the system currently recognizes commission expense only when the settlement is paid (cash basis), so there is no corresponding reduction to accumulatedEarnings while commission is PENDING/APPROVED. See balance_sheet.md §10 for the full analysis and the accrual-basis alternative this specification did not choose.',
      'Inventory is valued at Product.costPrice (current cost), not a per-lot historical cost basis — if costPrice has changed between purchases, this valuation does not reflect FIFO/weighted-average cost. See balance_sheet.md §11.3.',
    ];
    if (investorPercentageTotal.lessThan(100)) {
      accountingWarnings.push(
        `Investor profit-share percentages total ${investorPercentageTotal.toString()}%, not 100% — ` +
          `${money(knownUnallocatedEquityDifference)} of accumulated earnings is not attributed to any ` +
          'investor\'s equity (see reconciliation.knownUnallocatedEquityDifference). This is disclosed, not corrected — EquityService is unchanged.',
      );
    }

    return {
      asOf: new Date().toISOString(),
      assets: {
        current: {
          cashAndBank: money(cashAndBank),
          accountsReceivable: money(accountsReceivable),
          chequesInHand: money(chequesInHand),
          inventory: money(inventory),
          supplierAdvances: null,
          prepaidExpenses: null,
          otherCurrentAssets: null,
          totalCurrentAssets: money(totalCurrentAssets),
        },
        nonCurrent: {
          fixedAssets: null,
          accumulatedDepreciation: null,
          totalNonCurrentAssets: money(totalNonCurrentAssets),
        },
        totalAssets: money(totalAssets),
      },
      liabilities: {
        current: {
          accountsPayable: money(accountsPayable),
          supplierChequesIssued: money(supplierChequesIssued),
          taxPayable: null,
          accruedExpenses: null,
          customerAdvances: null,
          totalCurrentLiabilities: money(totalCurrentLiabilities),
        },
        nonCurrent: {
          loans: null,
          totalNonCurrentLiabilities: money(totalNonCurrentLiabilities),
        },
        totalLiabilities: money(totalLiabilities),
      },
      equity: {
        capitalContributions: money(capitalContributions),
        ownerWithdrawals: money(ownerWithdrawals),
        accumulatedEarnings: money(accumulatedEarningsGross),
        totalEquity: money(totalEquity),
      },
      summary: {
        totalAssets: money(totalAssets),
        totalLiabilities: money(totalLiabilities),
        totalEquity: money(totalEquity),
        liabilitiesAndEquity: money(liabilitiesAndEquity),
        rawDifference: money(rawDifference),
      },
      reconciliation: {
        knownOrderTimingDifference: money(knownOrderTimingDifference),
        knownUnallocatedEquityDifference: money(knownUnallocatedEquityDifference),
        knownDifference: money(knownDifference),
        unexplainedDifference: money(unexplainedDifference),
        inFlightOrderCount,
        investorPercentageTotal: investorPercentageTotal.toString(),
        status,
      },
      memorandum: {
        commissionPayable: {
          value: money(commissionPayableValue),
          includedInTotals: false,
          pendingOrApprovedLineCount: commissionPayableCount,
        },
      },
      accountingWarnings,
      unsupported: [
        'assets.current.supplierAdvances',
        'assets.current.prepaidExpenses',
        'assets.current.otherCurrentAssets',
        'assets.nonCurrent.fixedAssets',
        'assets.nonCurrent.accumulatedDepreciation',
        'liabilities.current.taxPayable',
        'liabilities.current.accruedExpenses',
        'liabilities.current.customerAdvances',
        'liabilities.nonCurrent.loans',
      ],
    };
  }
}
