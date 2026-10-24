import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Client = Prisma.TransactionClient | PrismaService;

const ZERO = new Prisma.Decimal(0);

/** One invoice's figures, as the wallet sees them. */
export interface WalletInvoice {
  invoiceId: string;
  invoiceNumber: string;
  /** Grand total less returns. */
  net: Prisma.Decimal;
  /** Effective payments (bounced cheques excluded) plus wallet credit used. */
  paid: Prisma.Decimal;
  /** Same, without cheques still pending. */
  settled: Prisma.Decimal;
  credit: Prisma.Decimal;
}

export interface DealerWallet {
  /** What the dealer has paid above their invoices, less what was used or refunded. Negative = overdrawn. */
  balance: Prisma.Decimal;
  /** The part that can be spent now — excess paid by a still-pending cheque waits until it clears. */
  available: Prisma.Decimal;
  /** Excess paid by cheques that haven't cleared yet. */
  pending: Prisma.Decimal;
  /** Excess paid in, per invoice — overpayments and returns on paid invoices. */
  sources: {
    invoiceId: string;
    invoiceNumber: string;
    excess: Prisma.Decimal;
    pending: Prisma.Decimal;
  }[];
  /** Standalone credit payments (no invoice). */
  standalone: Prisma.Decimal;
  used: Prisma.Decimal;
  refunded: Prisma.Decimal;
  invoices: Map<string, WalletInvoice>;
}

const max0 = (d: Prisma.Decimal) => Prisma.Decimal.max(ZERO, d);
const dec = (v: Prisma.Decimal | string | number | null) =>
  new Prisma.Decimal(v ?? 0);

/**
 * The dealer's wallet, derived from what's already recorded — never stored,
 * so it can't drift from the payments, returns and refunds it comes from:
 *
 *   Σ per invoice max(0, paid + credit used − net total)   (excess paid in)
 *   + standalone credit payments
 *   − credit used on invoices − refunds paid back.
 *
 * A return on a paid invoice therefore lands in the wallet just like an
 * overpayment does. A RETURNED cheque never counts; a PENDING one counts
 * toward the balance but not toward what's available to spend. Two queries,
 * so it stays cheap inside the transactions that check it.
 */
export async function computeDealerWallet(
  client: Client,
  dealerId: string,
): Promise<DealerWallet> {
  // Same rules as isEffectivePayment(): only a RETURNED cheque doesn't count.
  const rows = await client.$queryRaw<
    {
      id: string;
      invoiceNumber: string;
      net: Prisma.Decimal;
      paid: Prisma.Decimal;
      settled: Prisma.Decimal;
      credit: Prisma.Decimal;
    }[]
  >`
    SELECT i.id, i."invoiceNumber",
      i."grandTotal" - COALESCE((SELECT SUM(sr."totalAmount") FROM "SalesReturn" sr
                                 WHERE sr."orderId" = i."orderId"), 0) AS net,
      COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                WHERE p."invoiceId" = i.id
                  AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" = 'RETURNED')), 0) AS paid,
      COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                WHERE p."invoiceId" = i.id
                  AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" IN ('RETURNED', 'PENDING'))), 0) AS settled,
      COALESCE((SELECT SUM(u.amount) FROM "DealerCreditUse" u
                WHERE u."invoiceId" = i.id), 0) AS credit
    FROM "Invoice" i
    WHERE i."dealerId" = ${dealerId}
    ORDER BY i."createdAt"`;
  const [totals] = await client.$queryRaw<
    {
      standalone: Prisma.Decimal;
      standaloneSettled: Prisma.Decimal;
      refunded: Prisma.Decimal;
    }[]
  >`
    SELECT
      COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                WHERE p."dealerId" = ${dealerId} AND p."invoiceId" IS NULL
                  AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" = 'RETURNED')), 0) AS standalone,
      COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                WHERE p."dealerId" = ${dealerId} AND p."invoiceId" IS NULL
                  AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" IN ('RETURNED', 'PENDING'))), 0) AS "standaloneSettled",
      COALESCE((SELECT SUM(r.amount) FROM "Refund" r
                WHERE r."dealerId" = ${dealerId} AND r.party = 'DEALER'
                  AND r."cancelledAt" IS NULL
                  AND NOT (r.mode = 'CHEQUE' AND r."chequeStatus" = 'RETURNED')), 0) AS refunded`;

  let excessAll = ZERO;
  let excessSettled = ZERO;
  let used = ZERO;
  const sources: DealerWallet['sources'] = [];
  const invoices = new Map<string, WalletInvoice>();
  for (const row of rows) {
    const net = dec(row.net);
    const credit = dec(row.credit);
    const paid = dec(row.paid).add(credit);
    const settled = dec(row.settled).add(credit);
    used = used.add(credit);
    invoices.set(row.id, {
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      net,
      paid,
      settled,
      credit,
    });
    const excess = max0(paid.sub(net));
    const settledExcess = max0(settled.sub(net));
    excessAll = excessAll.add(excess);
    excessSettled = excessSettled.add(settledExcess);
    if (excess.greaterThan(0)) {
      sources.push({
        invoiceId: row.id,
        invoiceNumber: row.invoiceNumber,
        excess,
        pending: excess.sub(settledExcess),
      });
    }
  }

  const standalone = dec(totals.standalone);
  const refunded = dec(totals.refunded);
  const balance = excessAll.add(standalone).sub(used).sub(refunded);
  const spendable = excessSettled
    .add(dec(totals.standaloneSettled))
    .sub(used)
    .sub(refunded);
  const available = max0(Prisma.Decimal.min(balance, spendable));
  return {
    balance,
    available,
    pending: max0(balance.sub(available)),
    sources,
    standalone,
    used,
    refunded,
    invoices,
  };
}

/** Serialises wallet changes per dealer. Take it after any invoice lock (invoice → dealer order everywhere). */
export async function lockDealerRow(
  tx: Prisma.TransactionClient,
  dealerId: string,
) {
  await tx.$queryRaw`SELECT id FROM "Dealer" WHERE id = ${dealerId} FOR UPDATE`;
}

/**
 * Refuses a change that takes back money the dealer already spent from the
 * wallet (e.g. deleting the overpayment that funded a later invoice). Call
 * after the change is written, inside its transaction. Not used for a bank
 * returning a cheque — that is a fact to record, and shows as an overdrawn
 * wallet instead.
 */
export async function assertWalletNotOverdrawn(
  tx: Prisma.TransactionClient,
  dealerId: string,
) {
  await lockDealerRow(tx, dealerId);
  const wallet = await computeDealerWallet(tx, dealerId);
  if (wallet.used.isZero() || !wallet.balance.isNegative()) return;
  const uses = await tx.dealerCreditUse.findMany({
    where: { dealerId },
    select: { invoice: { select: { invoiceNumber: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const invoices = [...new Set(uses.map((u) => u.invoice.invoiceNumber))].join(
    ', ',
  );
  throw new BadRequestException(
    `This would take back ${wallet.balance.neg().toFixed(2)} of wallet credit the dealer already used (on ${invoices}). Remove that wallet credit from the invoice first.`,
  );
}

/** Wallet credit used on one invoice. */
export async function computeCreditUsed(
  client: Client,
  invoiceId: string,
): Promise<Prisma.Decimal> {
  const agg = await client.dealerCreditUse.aggregate({
    where: { invoiceId },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? ZERO;
}

/**
 * What each dealer still owes on their invoices: Σ max(0, total − returns −
 * effective payments − wallet credit used). Extra paid on one invoice is not
 * netted against another (it sits in the wallet until used), and invoices of
 * orders not completed yet count too. Same figure as the dealer page's
 * Outstanding Balance (balance + wallet). Only dealers owing something.
 */
export async function invoiceDuesByDealer(
  client: Client,
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await client.$queryRaw<
    { dealerId: string; owed: Prisma.Decimal }[]
  >`
    SELECT "dealerId", SUM(due) AS owed FROM (
      SELECT i."dealerId", GREATEST(
        i."grandTotal"
        - COALESCE((SELECT SUM(sr."totalAmount") FROM "SalesReturn" sr
                    WHERE sr."orderId" = i."orderId"), 0)
        - COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                    WHERE p."invoiceId" = i.id
                      AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" = 'RETURNED')), 0)
        - COALESCE((SELECT SUM(u.amount) FROM "DealerCreditUse" u
                    WHERE u."invoiceId" = i.id), 0),
        0) AS due
      FROM "Invoice" i
    ) t
    GROUP BY "dealerId"
    HAVING SUM(due) > 0`;
  return new Map(rows.map((r) => [r.dealerId, new Prisma.Decimal(r.owed)]));
}

/**
 * Money held for customers across all dealers — Σ of each positive wallet
 * (computeDealerWallet's balance, in one query). It's owed back to them, so
 * it belongs with what the business owes. Overdrawn wallets don't reduce it:
 * that's money owed to us, not held for them.
 */
export async function totalDealerWallets(
  client: Client,
): Promise<{ total: Prisma.Decimal; dealers: number }> {
  const [row] = await client.$queryRaw<
    { total: Prisma.Decimal | null; dealers: number }[]
  >`
    WITH inv AS (
      SELECT i."dealerId",
        GREATEST(
          COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                    WHERE p."invoiceId" = i.id
                      AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" = 'RETURNED')), 0)
          + COALESCE((SELECT SUM(u.amount) FROM "DealerCreditUse" u
                      WHERE u."invoiceId" = i.id), 0)
          - (i."grandTotal" - COALESCE((SELECT SUM(sr."totalAmount") FROM "SalesReturn" sr
                                       WHERE sr."orderId" = i."orderId"), 0)),
          0) AS excess
      FROM "Invoice" i
    ),
    wallet AS (
      SELECT d.id,
        COALESCE((SELECT SUM(excess) FROM inv WHERE inv."dealerId" = d.id), 0)
        + COALESCE((SELECT SUM(p.amount) FROM "Payment" p
                    WHERE p."dealerId" = d.id AND p."invoiceId" IS NULL
                      AND NOT (p.mode = 'CHEQUE' AND p."chequeStatus" = 'RETURNED')), 0)
        - COALESCE((SELECT SUM(u.amount) FROM "DealerCreditUse" u WHERE u."dealerId" = d.id), 0)
        - COALESCE((SELECT SUM(r.amount) FROM "Refund" r
                    WHERE r."dealerId" = d.id AND r.party = 'DEALER' AND r."cancelledAt" IS NULL
                      AND NOT (r.mode = 'CHEQUE' AND r."chequeStatus" = 'RETURNED')), 0) AS balance
      FROM "Dealer" d
    )
    SELECT SUM(balance) FILTER (WHERE balance > 0) AS total,
      (COUNT(*) FILTER (WHERE balance > 0))::int AS dealers
    FROM wallet`;
  return {
    total: new Prisma.Decimal(row?.total ?? 0),
    dealers: row?.dealers ?? 0,
  };
}
