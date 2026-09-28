import { Prisma } from '@prisma/client';

/**
 * Single source of truth for what the business owes a supplier. Every
 * backend path that reports a supplier credit balance — per supplier
 * (CreditsService) or company-wide (CreditBalanceService, and through it
 * the dashboard and balance sheet) — computes it with supplierBalance(), so
 * no two screens can drift into different formulas. The one place that
 * can't call this (the SQL running-balance ledger in
 * CreditBalanceService.getHistory) is pinned to it by a spec asserting the
 * signs match.
 */

// A settlement cheque reduces what's owed as soon as it's recorded (PENDING
// or CLEARED) — writing the cheque is the commitment to pay. Only if it
// actually bounces (RETURNED) does the debt come back.
export const EFFECTIVE_PAYMENT_FILTER: Prisma.SupplierPaymentWhereInput = {
  NOT: { mode: 'CHEQUE', chequeStatus: 'RETURNED' },
};

export interface SupplierBalanceComponents {
  purchases: Prisma.Decimal;
  transportCharges: Prisma.Decimal;
  returns: Prisma.Decimal;
  // Goods the supplier sent back in place of returned ones — reverses the
  // credit those returns took off. Zero for every supplier until the first
  // replacement receipt is recorded, so existing balances are unchanged.
  replacements: Prisma.Decimal;
  settled: Prisma.Decimal;
}

export function supplierBalance(c: SupplierBalanceComponents): Prisma.Decimal {
  return c.purchases
    .sub(c.returns)
    .add(c.replacements)
    .sub(c.settled)
    .sub(c.transportCharges);
}
