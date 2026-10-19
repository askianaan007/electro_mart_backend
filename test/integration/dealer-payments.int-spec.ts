/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import {
  createDealer,
  createInvoice,
  daysAgo,
  today,
} from '../support/fixtures';
import { assertCashInvariants, fullHistory } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

const cheque = (n: string, over: object = {}) => ({
  mode: 'CHEQUE',
  bankName: 'BOC',
  chequeNumber: n,
  chequeDate: today(),
  collectedDate: today(),
  paymentDate: today(),
  ...over,
});

describe('Dealer payments → Liquid Cash', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetWithAdmin(ctx.prisma);
  });

  async function setup(total = 10_000) {
    const dealer = await createDealer(ctx.prisma);
    const { invoice } = await createInvoice(ctx.prisma, dealer.id, total);
    return { dealer, invoice };
  }

  it('cash payment counts immediately; a cheque only once CLEARED, on the clearing date', async () => {
    const { invoice } = await setup();
    await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 1000,
        mode: 'CASH',
        paymentDate: today(),
      })
      .expect(201);
    const chq = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 2500,
        ...cheque('100001'),
      })
      .expect(201);

    let summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(1000);
    expect(summary.pendingDealerCheques).toBe(2500);
    expect(summary.pendingIn).toBe(2500);

    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(3500);
    expect(summary.pendingDealerCheques).toBe(0);
    const dealer = await ctx.prisma.dealer.findFirstOrThrow();
    expect(dealer.outstandingBalance.toNumber()).toBe(6500);
  });

  it('LC-04: an identical double submission is refused unless confirmed, also under concurrency', async () => {
    const { invoice } = await setup();
    const body = {
      invoiceId: invoice.id,
      amount: 1500,
      mode: 'CASH',
      paymentDate: today(),
    };
    const results = await Promise.all([
      ctx.post('/payments', body),
      ctx.post('/payments', body),
      ctx.post('/payments', body),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body.error).toBe('POSSIBLE_DUPLICATE');

    await ctx
      .post('/payments', { ...body, confirmDuplicate: true })
      .expect(201);
    expect(await ctx.prisma.payment.count()).toBe(2);
    const summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(3000);
  });

  it('concurrent different payments never overpay an invoice', async () => {
    const { invoice } = await setup(5000);
    const results = await Promise.all(
      [3000, 2500, 2000].map((amount) =>
        ctx.post('/payments', {
          invoiceId: invoice.id,
          amount,
          mode: 'CASH',
          paymentDate: today(),
        }),
      ),
    );
    const paid = results
      .filter((r) => r.status === 201)
      .reduce((s, r) => s + Number(r.body.amount), 0);
    expect(paid).toBeLessThanOrEqual(5000);
    expect(results.some((r) => r.status === 400)).toBe(true);
    await assertCashInvariants(ctx);
  });

  it('LC-17: concurrent payments on two invoices of one dealer keep outstandingBalance exact', async () => {
    const dealer = await createDealer(ctx.prisma);
    const a = await createInvoice(ctx.prisma, dealer.id, 4000);
    const b = await createInvoice(ctx.prisma, dealer.id, 6000);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        ctx
          .post('/payments', {
            invoiceId: (i % 2 ? a : b).invoice.id,
            amount: 500 + i,
            mode: 'CASH',
            paymentDate: today(),
          })
          .expect(201),
      ),
    );
    const d = await ctx.prisma.dealer.findUniqueOrThrow({
      where: { id: dealer.id },
    });
    expect(d.outstandingBalance.toNumber()).toBe(
      10_000 - (500 + 501 + 502 + 503),
    );
    await assertCashInvariants(ctx);
  });

  it('LC-10: a RETURNED dealer cheque can be re-presented and cleared; bank reversal of a CLEARED cheque', async () => {
    const { invoice, dealer } = await setup();
    const chq = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 4000,
        ...cheque('200001'),
      })
      .expect(201);
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
      .expect(200);
    let d = await ctx.prisma.dealer.findUniqueOrThrow({
      where: { id: dealer.id },
    });
    expect(d.outstandingBalance.toNumber()).toBe(10_000);
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    d = await ctx.prisma.dealer.findUniqueOrThrow({ where: { id: dealer.id } });
    expect(d.outstandingBalance.toNumber()).toBe(6000);
    let summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(4000);

    // The bank later reverses it.
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
      .expect(200);
    summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(0);
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
      .expect(400);
  });

  it('LC-10: re-presenting a RETURNED cheque is refused if it would overpay the invoice', async () => {
    const { invoice } = await setup(5000);
    const chq = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 4000,
        ...cheque('300001'),
      })
      .expect(201);
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
      .expect(200);
    await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 5000,
        mode: 'CASH',
        paymentDate: today(),
      })
      .expect(201);
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(400);
    await assertCashInvariants(ctx);
  });

  it('LC-05/06: editing and deleting a past payment never moves earlier balances; corrections are dated today', async () => {
    const { invoice } = await setup();
    const pay = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 2000,
        mode: 'CASH',
        paymentDate: daysAgo(5),
      })
      .expect(201);
    const before = await fullHistory(ctx);
    expect(before).toHaveLength(1);

    await ctx
      .patch(`/payments/${pay.body.id}`, {
        amount: 1200,
        mode: 'CASH',
        paymentDate: daysAgo(5),
      })
      .expect(200);
    let history = await fullHistory(ctx);
    expect(history).toHaveLength(2);
    // The original row is unchanged — same date, amount, running balance.
    expect(history[0]).toMatchObject({
      sourceId: pay.body.id,
      amount: before[0].amount,
      balanceAfter: before[0].balanceAfter,
      date: before[0].date,
    });
    expect(history[1]).toMatchObject({ event: 'EDITED' });
    expect(Number(history[1].amount)).toBe(-800);
    expect(new Date(history[1].date).getTime()).toBeGreaterThan(
      new Date(history[0].date).getTime(),
    );

    await ctx.del(`/payments/${pay.body.id}`).expect(200);
    history = await fullHistory(ctx);
    expect(history.map((r) => r.event)).toEqual([
      'RECORDED',
      'EDITED',
      'DELETED',
    ]);
    expect(Number(history[2].amount)).toBe(-1200);
    let summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(0);

    // Restoring the deleted payment is also a dated correction.
    await ctx.post(`/payments/${pay.body.id}/undo`, {}).expect(201);
    history = await fullHistory(ctx);
    expect(history.map((r) => r.event)).toEqual([
      'RECORDED',
      'EDITED',
      'DELETED',
      'RESTORED',
    ]);
    summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(1200);
  });

  it('LC-19: undo names the change it undoes; a stale or doubled undo is refused', async () => {
    const { invoice } = await setup();
    const pay = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 3000,
        mode: 'CASH',
        paymentDate: today(),
      })
      .expect(201);
    await ctx
      .patch(`/payments/${pay.body.id}`, {
        amount: 2000,
        mode: 'CASH',
        paymentDate: today(),
      })
      .expect(200);
    await ctx
      .patch(`/payments/${pay.body.id}`, {
        amount: 1000,
        mode: 'CASH',
        paymentDate: today(),
      })
      .expect(200);
    const latest = await ctx.prisma.paymentRevision.findFirstOrThrow({
      where: { paymentId: pay.body.id, action: 'UPDATED' },
      orderBy: { createdAt: 'desc' },
    });

    const [a, b] = await Promise.all([
      ctx.post(`/payments/${pay.body.id}/undo`, { revisionId: latest.id }),
      ctx.post(`/payments/${pay.body.id}/undo`, { revisionId: latest.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, expect.any(Number)]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const p = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: pay.body.id },
    });
    expect(p.amount.toNumber()).toBe(2000);

    await ctx
      .post(`/payments/${pay.body.id}/undo`, { revisionId: latest.id })
      .expect(409);
    await assertCashInvariants(ctx);
  });

  it('LC-19: edit, cheque-status and delete responses name their revision for an immediate undo', async () => {
    const { invoice } = await setup();
    const pay = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 2000,
        ...cheque('400001'),
      })
      .expect(201);
    const cleared = await ctx
      .patch(`/payments/${pay.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    expect(cleared.body.lastChange).toMatchObject({ action: 'CHEQUE_STATUS' });
    await ctx
      .post(`/payments/${pay.body.id}/undo`, {
        revisionId: cleared.body.lastChange.id,
      })
      .expect(201);
    await ctx
      .post(`/payments/${pay.body.id}/undo`, {
        revisionId: cleared.body.lastChange.id,
      })
      .expect(409);

    const deleted = await ctx.del(`/payments/${pay.body.id}`).expect(200);
    expect(deleted.body.revisionId).toEqual(expect.any(String));
    await ctx
      .post(`/payments/${pay.body.id}/undo`, {
        revisionId: deleted.body.revisionId,
      })
      .expect(201);
    const p = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: pay.body.id },
    });
    expect(p.chequeStatus).toBe('PENDING');
    await assertCashInvariants(ctx);
  });

  it('rejects future posting dates, zero, negative and over-precise amounts', async () => {
    const { invoice } = await setup();
    const base = { invoiceId: invoice.id, mode: 'CASH', paymentDate: today() };
    const tomorrow = new Date(Date.now() + 330 * 60_000 + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await ctx
      .post('/payments', { ...base, amount: 10, paymentDate: tomorrow })
      .expect(400);
    await ctx.post('/payments', { ...base, amount: 0 }).expect(400);
    await ctx.post('/payments', { ...base, amount: -5 }).expect(400);
    await ctx.post('/payments', { ...base, amount: 1.005 }).expect(400);
    await ctx.post('/payments', { ...base, amount: 1e12 }).expect(400);
    expect(await ctx.prisma.payment.count()).toBe(0);
  });
});
