/**
 * Response shape for GET /balance-sheet — see balance_sheet.md §17 for the
 * full accounting specification behind every field. All monetary fields are
 * fixed-2-decimal-place strings (never JS `number`) to avoid floating-point
 * error; every underlying calculation is done with `Prisma.Decimal`.
 *
 * `null` = category genuinely unsupported by the current schema (no data
 * model exists — balance_sheet.md §14). Never coerced to `0` and never
 * summed into a total.
 */

export type ReconciliationStatus =
  | 'BALANCED'
  | 'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE'
  | 'UNBALANCED';

export interface BalanceSheetResponse {
  asOf: string;

  assets: {
    current: {
      cashAndBank: string;
      accountsReceivable: string;
      chequesInHand: string;
      /** Supplier refund cheques received, not yet cleared. */
      refundChequesReceivable: string;
      inventory: string;
      supplierAdvances: null;
      prepaidExpenses: null;
      otherCurrentAssets: null;
      totalCurrentAssets: string;
    };
    nonCurrent: {
      fixedAssets: null;
      accumulatedDepreciation: null;
      totalNonCurrentAssets: string;
    };
    totalAssets: string;
  };

  liabilities: {
    current: {
      accountsPayable: string;
      supplierChequesIssued: string;
      /** Dealer refund cheques written, not yet cleared. */
      refundChequesIssued: string;
      taxPayable: null;
      accruedExpenses: null;
      customerAdvances: null;
      totalCurrentLiabilities: string;
    };
    nonCurrent: {
      loans: null;
      totalNonCurrentLiabilities: string;
    };
    totalLiabilities: string;
  };

  /** balance_sheet.md §8 — independently sourced from EquityService, never derived from Assets/Liabilities. */
  equity: {
    capitalContributions: string;
    ownerWithdrawals: string;
    accumulatedEarnings: string;
    /** EquityService's total (contributions + attributed earnings). */
    investorEquity: string;
    /** Opening balance + cash adjustments (CashAdjustment) — no other counterpart. */
    cashAdjustments: string;
    /** investorEquity + cashAdjustments. */
    totalEquity: string;
  };

  summary: {
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
    liabilitiesAndEquity: string;
    rawDifference: string;
  };

  /**
   * balance_sheet.md §13, extended (see §13.6 addendum): the equation has
   * two independent, self-explaining "known" difference sources under this
   * system's current architecture — the APPROVED→COMPLETED order-timing gap,
   * and any investor profit-share percentage total under 100% (unallocated
   * accumulated earnings that exist in Assets but aren't attributed to any
   * investor's equity). Both are broken out individually so an administrator
   * can see which one (if either) explains a nonzero rawDifference.
   */
  reconciliation: {
    knownOrderTimingDifference: string;
    knownUnallocatedEquityDifference: string;
    /** Transport charges deducted from payables with no recorded counterpart (LC-08). */
    knownTransportChargeDifference: string;
    knownDifference: string;
    unexplainedDifference: string;
    inFlightOrderCount: number;
    investorPercentageTotal: string;
    status: ReconciliationStatus;
  };

  /**
   * balance_sheet.md §10 — real, computed, but deliberately excluded from
   * every official total (Option B). Never summed into totalLiabilities.
   */
  memorandum: {
    commissionPayable: {
      value: string;
      includedInTotals: false;
      pendingOrApprovedLineCount: number;
    };
  };

  accountingWarnings: string[];
  unsupported: string[];
}
