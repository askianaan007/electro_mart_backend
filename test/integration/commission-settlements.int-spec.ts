/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import {
  createCommissionLines,
  createRepresentative,
  daysAgo,
  today,
} from '../support/fixtures';
import { assertCashInvariants, fullHistory } from '../support/invariants';
import {
  ADMIN_PASSWORD,
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

describe('Commission settlements → Liquid Cash', () => {
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

  async function approvedSettlement(amounts = [300, 700]) {
    const rep = await createRepresentative(ctx.prisma);
    await createCommissionLines(ctx.prisma, rep.id, amounts);
    const created = await ctx
      .post('/commission/settlements', {
        representativeId: rep.id,
        periodStart: daysAgo(1),
        periodEnd: today(),
      })
      .expect(201);
    await ctx
      .patch(`/commission/settlements/${created.body.id}/approve`)
      .expect(200);
    return { rep, id: created.body.id as string };
  }

  const payCheque = (id: string) =>
    ctx.patch(`/commission/settlements/${id}/pay`, {
      mode: 'CHEQUE',
      chequeNumber: 'S-1',
      bankName: 'HNB',
      chequeDate: today(),
    });

  it('LC-21: the period end date is inclusive (a line at 23:59 Colombo is included)', async () => {
    const rep = await createRepresentative(ctx.prisma);
    const end = daysAgo(1);
    await createCommissionLines(
      ctx.prisma,
      rep.id,
      [111],
      new Date(`${end}T23:59:00+05:30`),
    );
    await createCommissionLines(
      ctx.prisma,
      rep.id,
      [222],
      new Date(`${today()}T00:00:00+05:30`),
    );
    const res = await ctx
      .post('/commission/settlements', {
        representativeId: rep.id,
        periodStart: end,
        periodEnd: end,
      })
      .expect(201);
    expect(Number(res.body.totalCommission)).toBe(111);
  });

  it('concurrent settlement creation for one representative batches each line once', async () => {
    const rep = await createRepresentative(ctx.prisma);
    await createCommissionLines(ctx.prisma, rep.id, [100, 200]);
    const body = {
      representativeId: rep.id,
      periodStart: daysAgo(1),
      periodEnd: today(),
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => ctx.post('/commission/settlements', body)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.prisma.representativeSettlement.count()).toBe(1);
  });

  it('cash payout posts one expense and reduces Liquid Cash', async () => {
    const { id } = await approvedSettlement();
    await ctx
      .patch(`/commission/settlements/${id}/pay`, {
        mode: 'CASH',
        reference: 'R1',
      })
      .expect(200);
    const summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(-1000);
    expect(summary.totalExpensesPaid).toBe(1000);
    const s = await ctx.prisma.representativeSettlement.findUniqueOrThrow({
      where: { id },
    });
    expect(s.status).toBe('PAID');
    expect(s.reference).toBe('R1');
  });

  it('LC-02: parallel pay requests create exactly one expense', async () => {
    const { id } = await approvedSettlement();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        ctx.patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await ctx.prisma.expense.count()).toBe(1);
    expect((await assertCashInvariants(ctx)).balance).toBe(-1000);
  });

  it('LC-02: parallel CLEARED requests on a settlement cheque create exactly one expense', async () => {
    const { id } = await approvedSettlement();
    await payCheque(id).expect(200);
    expect((await assertCashInvariants(ctx)).balance).toBe(0);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        ctx.patch(`/commission/settlements/${id}/cheque-status`, {
          status: 'CLEARED',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await ctx.prisma.expense.count()).toBe(1);
    expect((await assertCashInvariants(ctx)).balance).toBe(-1000);
  });

  it('LC-01: a settlement with a pending cheque cannot be rejected; a rejected one can never pay out', async () => {
    const { id } = await approvedSettlement();
    await payCheque(id).expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/reject`, { reason: 'wrong' })
      .expect(400);
    // A second pay while the cheque is pending is refused too.
    await ctx
      .patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' })
      .expect(400);

    await ctx
      .patch(`/commission/settlements/${id}/cheque-status`, {
        status: 'RETURNED',
      })
      .expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/reject`, { reason: 'cancelled' })
      .expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/cheque-status`, {
        status: 'CLEARED',
      })
      .expect(400);
    await ctx
      .patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' })
      .expect(400);
    expect(await ctx.prisma.expense.count()).toBe(0);
    const lines = await ctx.prisma.commissionLedgerEntry.findMany();
    expect(
      lines.every((l) => l.status === 'PENDING' && l.settlementId === null),
    ).toBe(true);
    expect((await assertCashInvariants(ctx)).balance).toBe(0);
  });

  it('a returned settlement cheque can be re-paid in cash, clearing stale cheque fields', async () => {
    const { id } = await approvedSettlement();
    await payCheque(id).expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/cheque-status`, {
        status: 'RETURNED',
      })
      .expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' })
      .expect(200);
    const s = await ctx.prisma.representativeSettlement.findUniqueOrThrow({
      where: { id },
    });
    expect(s).toMatchObject({
      status: 'PAID',
      chequeNumber: null,
      chequeStatus: null,
    });
    expect((await assertCashInvariants(ctx)).balance).toBe(-1000);
  });

  it('LC-22: a line reversed after batching blocks payment', async () => {
    const { id } = await approvedSettlement();
    const line = await ctx.prisma.commissionLedgerEntry.findFirstOrThrow({
      where: { settlementId: id },
    });
    await ctx.prisma.commissionLedgerEntry.update({
      where: { id: line.id },
      data: { status: 'REVERSED' },
    });
    const res = await ctx
      .patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' })
      .expect(400);
    expect(res.body.message).toMatch(/reversed after it was created/);
    expect(await ctx.prisma.expense.count()).toBe(0);
  });

  it('LC-07: the payout expense cannot be edited or deleted; reversal is a dated adjustment', async () => {
    const { id } = await approvedSettlement();
    await ctx
      .patch(`/commission/settlements/${id}/pay`, { mode: 'CASH' })
      .expect(200);
    const expense = await ctx.prisma.expense.findFirstOrThrow();
    const edit = await ctx
      .patch(`/expenses/${expense.id}`, {
        description: 'edited payout',
        amount: 1,
        expenseDate: today(),
      })
      .expect(400);
    expect(edit.body.message).toMatch(/payout of commission settlement/);
    const del = await ctx.del(`/expenses/${expense.id}`).expect(400);
    expect(del.body.message).toMatch(/payout of commission settlement/);

    await ctx
      .patch(`/commission/settlements/${id}/reverse-payment`, {
        reason: 'paid twice by mistake',
      })
      .expect(200);
    await ctx
      .patch(`/commission/settlements/${id}/reverse-payment`, {
        reason: 'again',
      })
      .expect(400);
    const history = await fullHistory(ctx);
    expect(history.map((r) => [r.type, Number(r.amount)])).toEqual([
      ['EXPENSE', -1000],
      ['ADJUSTMENT', 1000],
    ]);
    expect(history[1].event).toBe('SETTLEMENT_REVERSAL');
    expect(await ctx.prisma.expense.count()).toBe(1);
    const s = await ctx.prisma.representativeSettlement.findUniqueOrThrow({
      where: { id },
    });
    expect(s.status).toBe('REVERSED');
    expect((await assertCashInvariants(ctx)).balance).toBe(0);
    // A settlement reversal can't be reversed through the generic adjustment endpoint.
    const adj = await ctx.prisma.cashAdjustment.findFirstOrThrow();
    const refused = await ctx
      .post(`/cash-adjustments/${adj.id}/reverse`, {
        reason: 'undo the reversal',
        password: ADMIN_PASSWORD,
      })
      .expect(400);
    expect(refused.body.message).toMatch(/settlement/i);
  });
});
