/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import { businessDateOf } from '../../src/common/utils/business-date';
import {
  createDealer,
  createInvestor,
  createProduct,
  createSupplier,
  daysAgo,
  today,
} from '../support/fixtures';
import { assertCashInvariants, fullHistory } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

/**
 * Replays the audit's isolated scenario (S1–S10) through the API with the
 * remediated code, then cross-checks every report against the others.
 */
describe('Reconciliation across Liquid Cash, dashboard, balance sheet, AR and AP', () => {
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

  async function sell(dealerId: string, productId: string, quantity: number) {
    const order = await ctx
      .post('/orders', { dealerId, items: [{ productId, quantity }] })
      .expect(201);
    // An admin-recorded order starts APPROVED (stock reserved, invoiced).
    await ctx.patch(`/orders/${order.body.id}/complete`).expect(200);
    const invoice = await ctx.prisma.invoice.findFirstOrThrow({
      where: { orderId: order.body.id },
    });
    return { orderId: order.body.id as string, invoice };
  }

  it('audit scenario: every figure agrees, and the balance sheet difference is fully explained', async () => {
    const investor = await createInvestor(ctx.prisma, 100);
    const supplier = await createSupplier(ctx.prisma);
    const product = await createProduct(ctx.prisma);
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: { costPrice: 1000, wholesalePrice: 2000 },
    });
    const dealer = await createDealer(ctx.prisma);
    await ctx.prisma.dealer.update({
      where: { id: dealer.id },
      data: { creditLimit: 1_000_000 },
    });

    const inv = (amount: number, extra: object = {}) =>
      ctx.post('/investments', {
        investorId: investor.id,
        amount,
        mode: 'CASH',
        investmentDate: daysAgo(10),
        reason: 'capital',
        ...extra,
      });

    // S1 capital
    await inv(100_000).expect(201);
    await inv(-20_000).expect(201);
    await inv(0).expect(400);
    await inv(5000, {
      mode: 'CHEQUE',
      chequeNumber: 'I1',
      bankName: 'BOC',
      chequeDate: today(),
    }).expect(201);
    // S2 purchase 10 × 1,000 with transport 500
    await ctx
      .post('/purchases', {
        supplierId: supplier.id,
        invoiceNumber: 'P-1',
        purchaseDate: daysAgo(9),
        items: [{ productId: product.id, quantity: 10, unitCost: 1000 }],
        transportCharges: 500,
      })
      .expect(201);
    // S3 supplier settlements
    await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 4000,
        mode: 'CASH',
        paymentDate: daysAgo(8),
      })
      .expect(201);
    const supChq = await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 3000,
        mode: 'CHEQUE',
        paymentDate: daysAgo(8),
        chequeDepositDate: today(),
      })
      .expect(201);
    await ctx
      .patch(`/credits/settlements/${supChq.body.id}/status`, {
        status: 'CLEARED',
      })
      .expect(200);
    await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 99_999,
        mode: 'CASH',
        paymentDate: daysAgo(8),
      })
      .expect(400);
    // S4 sale of 5 units and dealer payments
    const { orderId, invoice } = await sell(dealer.id, product.id, 5);
    expect(Number(invoice.grandTotal)).toBe(10_000);
    const cashPay = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 3000,
        mode: 'CASH',
        paymentDate: daysAgo(7),
      })
      .expect(201);
    const chqPay = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 4000,
        mode: 'CHEQUE',
        paymentDate: daysAgo(7),
        chequeNumber: 'C1',
        bankName: 'BOC',
        chequeDate: today(),
        collectedDate: daysAgo(7),
      })
      .expect(201);
    await ctx
      .patch(`/payments/${chqPay.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    await ctx
      .patch(`/payments/${chqPay.body.id}/cheque-status`, {
        status: 'RETURNED',
      })
      .expect(200);
    await ctx
      .patch(`/payments/${cashPay.body.id}`, {
        amount: 2500,
        mode: 'CASH',
        paymentDate: daysAgo(7),
      })
      .expect(200);
    await ctx.del(`/payments/${cashPay.body.id}`).expect(200);
    await ctx.post(`/payments/${cashPay.body.id}/undo`, {}).expect(201);
    // S5 a double-submitted payment is caught
    const retry = {
      invoiceId: invoice.id,
      amount: 1000,
      mode: 'CASH',
      paymentDate: daysAgo(6),
      reference: 'RETRY-1',
    };
    const [a, b] = await Promise.all([
      ctx.post('/payments', retry),
      ctx.post('/payments', retry),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    // S6 sales return of one unit
    await ctx
      .post('/sales-returns', {
        orderId,
        reason: 'faulty',
        returnDate: daysAgo(5),
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(201);
    // S7/S8 future dates are refused
    const future = new Date(Date.now() + 330 * 60_000 + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await ctx
      .post('/expenses', {
        description: 'rent',
        amount: 1000,
        expenseDate: future,
      })
      .expect(400);
    await ctx
      .post('/expenses', {
        description: 'rent',
        amount: 1000,
        expenseDate: daysAgo(4),
      })
      .expect(201);
    await inv(2000, { investmentDate: future }).expect(400);
    // S9 second sale and a payment entered at 01:00 Colombo time
    const second = await sell(dealer.id, product.id, 1);
    const localMorning = `${today()}T01:00:00+05:30`;
    await ctx
      .post('/payments', {
        invoiceId: second.invoice.id,
        amount: 100,
        mode: 'CASH',
        paymentDate: localMorning,
      })
      .expect(201);

    // ---- Liquid Cash ----
    const summary = await assertCashInvariants(ctx);
    // 100,000 − 20,000 − 4,000 − 3,000 + 2,500 + 1,000 − 1,000 + 100
    expect(summary.balance).toBe(75_600);
    expect(summary).toMatchObject({
      totalDeposits: 100_000,
      totalWithdrawals: 20_000,
      totalCollected: 3600,
      totalPaidToSuppliers: 7000,
      totalExpensesPaid: 1000,
      pendingInvestmentCheques: 5000,
      pendingDealerCheques: 0,
      scheduled: 0,
    });
    // An independent recomputation straight from the source tables.
    const [indep] = await ctx.prisma.$queryRawUnsafe<{ v: string }[]>(`
      SELECT (
        (SELECT COALESCE(SUM(amount),0) FROM "Investment" WHERE mode <> 'CHEQUE' OR "chequeStatus" = 'CLEARED')
      + (SELECT COALESCE(SUM(amount),0) FROM "Payment" WHERE mode <> 'CHEQUE' OR "chequeStatus" = 'CLEARED')
      - (SELECT COALESCE(SUM(amount),0) FROM "SupplierPayment" WHERE mode <> 'CHEQUE' OR "chequeStatus" = 'CLEARED')
      - (SELECT COALESCE(SUM(amount),0) FROM "Expense")
      )::text AS v`);
    expect(Number(indep.v)).toBe(summary.balance);

    // LC-13: the 01:00 payment is on today's Colombo date.
    const todays = await fullHistory(
      ctx,
      `&dateFrom=${today()}&dateTo=${today()}&type=DEALER_PAYMENT`,
    );
    expect(todays.some((r) => Number(r.amount) === 100)).toBe(true);
    expect(
      businessDateOf(todays.find((r) => Number(r.amount) === 100)!.date),
    ).toBe(today());

    // ---- Dashboard (LC-14): this month's net cash flow = Liquid Cash change this month ----
    const dash = (await ctx.get('/dashboard/admin').expect(200)).body;
    expect(dash.liquidCash).toBe(summary.balance);
    const monthStart = `${today().slice(0, 8)}01`;
    const month = await fullHistory(
      ctx,
      `&dateFrom=${monthStart}&dateTo=${today()}`,
    );
    const monthChange =
      Math.round(month.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
    expect(dash.netCashFlow).toBe(monthChange);
    expect(dash.operatingCashFlow).toBe(monthChange - 80_000);

    // ---- AP ----
    const cb = (await ctx.get('/credit-balance/summary').expect(200)).body;
    expect(cb.balance).toBe(10_000 - 500 - 7000);

    // ---- Balance sheet (LC-15) ----
    const sheet = (await ctx.get('/balance-sheet').expect(200)).body;
    expect(sheet.assets.current.cashAndBank).toBe('75600.00');
    expect(sheet.reconciliation.knownTransportChargeDifference).toBe('500.00');
    expect(sheet.reconciliation.unexplainedDifference).toBe('0.00');
    expect(sheet.reconciliation.status).toBe(
      'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE',
    );
  });

  it('LC-11: a legacy future-dated row is reported as scheduled, not in the balance', async () => {
    const investor = await createInvestor(ctx.prisma);
    await ctx
      .post('/investments', {
        investorId: investor.id,
        amount: 1000,
        mode: 'CASH',
        investmentDate: today(),
        reason: 'cap',
      })
      .expect(201);
    // Inserted directly: the API now refuses future dates, but historical data may hold them.
    await ctx.prisma.expense.create({
      data: {
        description: 'legacy',
        amount: 300,
        expenseDate: new Date(Date.now() + 40 * 86_400_000),
      },
    });
    const summary = await assertCashInvariants(ctx);
    expect(summary).toMatchObject({ balance: 1000, scheduled: -300 });
    const history = await fullHistory(ctx);
    expect(history[history.length - 1]).toMatchObject({ isFuture: true });
  });

  it('LC-13: inclusive whole-day filters on the Liquid Cash history', async () => {
    const investor = await createInvestor(ctx.prisma);
    for (const [date, amount] of [
      [`${daysAgo(2)}T00:00:00+05:30`, 1],
      [`${daysAgo(2)}T23:59:00+05:30`, 2],
      [`${daysAgo(1)}T00:00:00+05:30`, 4],
    ] as const) {
      await ctx.prisma.investment.create({
        data: {
          investorId: investor.id,
          amount,
          mode: 'CASH',
          investmentDate: new Date(date),
          reason: 'r',
        },
      });
    }
    const rows = await fullHistory(
      ctx,
      `&dateFrom=${daysAgo(2)}&dateTo=${daysAgo(2)}`,
    );
    expect(rows.map((r) => Number(r.amount))).toEqual([1, 2]);
  });

  it('sales analysis flags when expenses are left out of a filtered net profit', async () => {
    const dealer = await createDealer(ctx.prisma);
    const all = (await ctx.get('/sales-analysis/summary').expect(200)).body;
    const filtered = (
      await ctx.get(`/sales-analysis/summary?dealerId=${dealer.id}`).expect(200)
    ).body;
    expect(all.expensesIncluded).toBe(true);
    expect(filtered.expensesIncluded).toBe(false);
  });
});
