import { ChequeStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type TransactionClient = Prisma.TransactionClient;

const ZERO = new Prisma.Decimal(0);

// A cheque marked RETURNED (bounced) never actually paid the invoice — every
// other state (PENDING, CLEARED, or a non-cheque payment) counts as money
// the dealer has actually handed over.
export function isEffectivePayment(payment: {
  mode: string;
  chequeStatus: ChequeStatus | null;
}): boolean {
  return !(payment.mode === 'CHEQUE' && payment.chequeStatus === 'RETURNED');
}

export function computeEffectivePaid(
  payments: {
    amount: Prisma.Decimal;
    mode: string;
    chequeStatus: ChequeStatus | null;
  }[],
): Prisma.Decimal {
  return payments.reduce(
    (sum, p) => (isEffectivePayment(p) ? sum.add(p.amount) : sum),
    ZERO,
  );
}

/**
 * Total value of goods returned against an order — an invoice's true
 * remaining liability is its grandTotal minus this, not the raw grandTotal.
 */
export async function computeReturnedAmount(
  client: TransactionClient | PrismaService,
  orderId: string,
): Promise<Prisma.Decimal> {
  const agg = await client.salesReturn.aggregate({
    where: { orderId },
    _sum: { totalAmount: true },
  });
  return agg._sum.totalAmount ?? ZERO;
}

export function derivePaymentStatus(
  effectivePaid: Prisma.Decimal,
  netGrandTotal: Prisma.Decimal,
): PaymentStatus {
  return effectivePaid.greaterThanOrEqualTo(netGrandTotal)
    ? PaymentStatus.PAID
    : effectivePaid.greaterThan(0)
      ? PaymentStatus.PARTIAL
      : PaymentStatus.PENDING;
}

/**
 * Recomputes an invoice's paymentStatus from its current payment/return
 * rows — safe to call after any create/edit/delete affecting either, since
 * it re-derives from the post-change state (read fresh via `tx`) rather
 * than applying a delta. Shared by payments and sales-returns so the two
 * never drift into slightly different logic for the same computation.
 */
export async function recomputeInvoicePaymentStatus(
  tx: TransactionClient,
  invoiceId: string,
): Promise<PaymentStatus> {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
  });
  const payments = await tx.payment.findMany({ where: { invoiceId } });
  const effectivePaid = computeEffectivePaid(payments);
  const returnedAmount = await computeReturnedAmount(tx, invoice.orderId);
  const netGrandTotal = invoice.grandTotal.sub(returnedAmount);

  const paymentStatus = derivePaymentStatus(effectivePaid, netGrandTotal);

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { paymentStatus },
  });
  return paymentStatus;
}
