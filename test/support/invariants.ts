/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read untyped JSON response bodies (supertest) */
import { Prisma } from '@prisma/client';
import { TestContext } from './test-app';

/** Every Liquid Cash history row, oldest first, read through the API. */
export async function fullHistory(ctx: TestContext, query = '') {
  const rows: Array<Record<string, any>> = [];
  for (let page = 1; ; page++) {
    const res = await ctx
      .get(`/liquid-cash/history?limit=100&page=${page}${query}`)
      .expect(200);
    rows.push(...res.body.data);
    if (res.body.data.length < 100) break;
  }
  return rows.reverse();
}

const num = (v: unknown) => Number(v ?? 0);
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The accounting contract's cross-checks (docs/LIQUID_CASH_ACCOUNTING_CONTRACT.md §6):
 *  I1 summary.balance = Σ history.amount (non-future rows)
 *  I2 the newest non-future row's balanceAfter = summary.balance
 *  I3 every row's balanceAfter = previous balanceAfter + amount
 *  I4 each dealer's outstandingBalance = Σ invoices − Σ counted payments
 *     + Σ counted dealer refunds − Σ sales returns (recomputed from rows)
 * Returns the summary for further, test-specific assertions.
 */
export async function assertCashInvariants(ctx: TestContext) {
  const summary = (await ctx.get('/liquid-cash/summary').expect(200)).body;
  const history = await fullHistory(ctx);
  const current = history.filter((r) => !r.isFuture);

  const sum = round(current.reduce((s, r) => s + num(r.amount), 0));
  expect(round(summary.balance)).toBe(sum);
  if (current.length > 0) {
    expect(round(num(current[current.length - 1].balanceAfter))).toBe(
      round(summary.balance),
    );
  }
  let running = 0;
  for (const row of history) {
    running = round(running + num(row.amount));
    expect(round(num(row.balanceAfter))).toBe(running);
  }

  const dealers = await ctx.prisma.dealer.findMany({
    include: {
      invoices: true,
      payments: true,
      refunds: true,
      salesReturns: true,
    },
  });
  for (const dealer of dealers) {
    const invoiced = dealer.invoices.reduce(
      (s, i) => s.add(i.grandTotal),
      new Prisma.Decimal(0),
    );
    const paid = dealer.payments
      .filter((p) => !(p.mode === 'CHEQUE' && p.chequeStatus === 'RETURNED'))
      .reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0));
    const refunded = dealer.refunds
      .filter(
        (r) =>
          !r.cancelledAt &&
          !(r.mode === 'CHEQUE' && r.chequeStatus === 'RETURNED'),
      )
      .reduce((s, r) => s.add(r.amount), new Prisma.Decimal(0));
    const expected = invoiced
      .sub(paid)
      .add(refunded)
      .sub(
        dealer.salesReturns.reduce(
          (s, r) => s.add(r.totalAmount),
          new Prisma.Decimal(0),
        ),
      );
    expect(dealer.outstandingBalance.toNumber()).toBe(expected.toNumber());
  }
  return summary;
}
