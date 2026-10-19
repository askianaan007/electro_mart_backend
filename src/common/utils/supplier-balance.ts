import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/**
 * Single source of truth for what the business owes a supplier (positive) or
 * is owed by them (negative). CreditsService (per supplier) and
 * CreditBalanceService (company-wide, and through it the dashboard and
 * balance sheet) both use it; the SQL running-balance ledger in
 * CreditBalanceService.getHistory mirrors the same signs.
 */

// A settlement cheque reduces what's owed as soon as it's recorded (PENDING
// or CLEARED) — writing the cheque is the commitment to pay. Only if it
// actually bounces (RETURNED) does the debt come back.
export const EFFECTIVE_PAYMENT_FILTER: Prisma.SupplierPaymentWhereInput = {
  NOT: { mode: 'CHEQUE', chequeStatus: 'RETURNED' },
};

// Same rule for money a supplier refunds us, plus a cancelled refund never
// counts.
export const EFFECTIVE_SUPPLIER_REFUND_FILTER: Prisma.RefundWhereInput = {
  party: 'SUPPLIER',
  cancelledAt: null,
  NOT: { mode: 'CHEQUE', chequeStatus: 'RETURNED' },
};

export interface SupplierBalanceComponents {
  purchases: Prisma.Decimal;
  transportCharges: Prisma.Decimal;
  returns: Prisma.Decimal;
  // Goods the supplier sent in place of returned ones — reverses the credit
  // those returns took off (PurchaseReturnReplacement, LC-25).
  replacements: Prisma.Decimal;
  settled: Prisma.Decimal;
  // Cash the supplier paid back to clear a credit they owed us (LC-12).
  refundsReceived: Prisma.Decimal;
}

export function supplierBalance(c: SupplierBalanceComponents): Prisma.Decimal {
  return c.purchases
    .sub(c.returns)
    .add(c.replacements)
    .sub(c.settled)
    .sub(c.transportCharges)
    .add(c.refundsReceived);
}

/** Every component of one supplier's balance (or all suppliers' when supplierId is omitted). */
export async function computeSupplierBalance(
  client: Prisma.TransactionClient,
  supplierId?: string,
) {
  const bySupplier = supplierId ? { supplierId } : {};
  const [purchaseAgg, returnAgg, replacementAgg, paymentAgg, refundAgg] =
    await Promise.all([
      client.purchase.aggregate({
        where: bySupplier,
        _sum: { totalValue: true, transportCharges: true },
      }),
      client.purchaseReturn.aggregate({
        where: bySupplier,
        _sum: { totalAmount: true },
      }),
      client.purchaseReturnReplacement.aggregate({
        where: bySupplier,
        _sum: { totalAmount: true },
      }),
      client.supplierPayment.aggregate({
        where: { ...bySupplier, ...EFFECTIVE_PAYMENT_FILTER },
        _sum: { amount: true },
      }),
      client.refund.aggregate({
        where: { ...bySupplier, ...EFFECTIVE_SUPPLIER_REFUND_FILTER },
        _sum: { amount: true },
      }),
    ]);

  const components: SupplierBalanceComponents = {
    purchases: purchaseAgg._sum.totalValue ?? ZERO,
    transportCharges: purchaseAgg._sum.transportCharges ?? ZERO,
    returns: returnAgg._sum.totalAmount ?? ZERO,
    replacements: replacementAgg._sum.totalAmount ?? ZERO,
    settled: paymentAgg._sum.amount ?? ZERO,
    refundsReceived: refundAgg._sum.amount ?? ZERO,
  };
  return { ...components, balance: supplierBalance(components) };
}
