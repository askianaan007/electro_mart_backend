/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import {
  createDealer,
  createInvestor,
  createInvoice,
  createProduct,
  createSupplier,
  daysAgo,
  today,
} from '../support/fixtures';
import { businessDateOf } from '../../src/common/utils/business-date';
import { assertCashInvariants, fullHistory } from '../support/invariants';
import {
  ADMIN_PASSWORD,
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

describe('Investments, refunds and cash adjustments → Liquid Cash', () => {
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

  const invest = (investorId: string, amount: number, extra: object = {}) =>
    ctx.post('/investments', {
      investorId,
      amount,
      mode: 'CASH',
      investmentDate: today(),
      reason: 'capital',
      ...extra,
    });
  const chequeFields = {
    mode: 'CHEQUE',
    chequeNumber: 'I-1',
    bankName: 'BOC',
    chequeDate: today(),
  };

  describe('investments', () => {
    it('LC-09: a cheque investment counts only once CLEARED; a bounced one never', async () => {
      const investor = await createInvestor(ctx.prisma);
      const chq = await invest(investor.id, 50_000, chequeFields).expect(201);
      let summary = await assertCashInvariants(ctx);
      expect(summary.balance).toBe(0);
      expect(summary.pendingInvestmentCheques).toBe(50_000);
      expect(summary.pendingIn).toBe(50_000);
      let equity = (await ctx.get('/equity').expect(200)).body;
      expect(Number(equity.totals.totalInvestment)).toBe(0);

      await ctx
        .patch(`/investments/${chq.body.id}/cheque-status`, {
          status: 'CLEARED',
        })
        .expect(200);
      summary = await assertCashInvariants(ctx);
      expect(summary).toMatchObject({
        balance: 50_000,
        totalDeposits: 50_000,
        totalInvestments: 50_000,
      });
      equity = (await ctx.get('/equity').expect(200)).body;
      expect(Number(equity.totals.totalInvestment)).toBe(50_000);

      const bounced = await invest(investor.id, 10_000, {
        ...chequeFields,
        chequeNumber: 'I-2',
      }).expect(201);
      await ctx
        .patch(`/investments/${bounced.body.id}/cheque-status`, {
          status: 'RETURNED',
        })
        .expect(200);
      await ctx
        .patch(`/investments/${bounced.body.id}/cheque-status`, {
          status: 'CLEARED',
        })
        .expect(400);
      summary = await assertCashInvariants(ctx);
      expect(summary.balance).toBe(50_000);
      const sheet = (await ctx.get('/balance-sheet').expect(200)).body;
      expect(JSON.stringify(sheet)).not.toContain('60000');
    });

    it('rejects zero, over-precise and future-dated entries', async () => {
      const investor = await createInvestor(ctx.prisma);
      await invest(investor.id, 0).expect(400);
      await invest(investor.id, 10.123).expect(400);
      const future = new Date(Date.now() + 330 * 60_000 + 2 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await invest(investor.id, 100, { investmentDate: future }).expect(400);
      await invest(investor.id, 100, { mode: 'CHEQUE' }).expect(400);
      expect(await ctx.prisma.investment.count()).toBe(0);
    });

    it('LC-16: withdrawals are bounded by equity, including pending withdrawal cheques and concurrency', async () => {
      const investor = await createInvestor(ctx.prisma);
      await invest(investor.id, 1000).expect(201);
      await invest(investor.id, -1000.01).expect(400);
      await invest(investor.id, -600, {
        ...chequeFields,
        chequeNumber: 'W-1',
      }).expect(201);
      // 600 is already committed to a pending cheque.
      await invest(investor.id, -500).expect(400);
      const results = await Promise.all([
        invest(investor.id, -300),
        invest(investor.id, -300),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const summary = await assertCashInvariants(ctx);
      expect(summary).toMatchObject({
        balance: 700,
        totalWithdrawals: 300,
        pendingWithdrawalCheques: 600,
        pendingOut: 600,
      });
    });

    it('editing or deleting an investment is a dated correction', async () => {
      const investor = await createInvestor(ctx.prisma);
      const inv = await invest(investor.id, 5000, {
        investmentDate: daysAgo(3),
      }).expect(201);
      await ctx
        .patch(`/investments/${inv.body.id}`, { amount: 4000 })
        .expect(200);
      await ctx.del(`/investments/${inv.body.id}`).expect(200);
      const history = await fullHistory(ctx);
      expect(history.map((r) => [r.event, Number(r.amount)])).toEqual([
        ['RECORDED', 5000],
        ['EDITED', -1000],
        ['DELETED', -4000],
      ]);
      expect(businessDateOf(history[0].date)).toBe(daysAgo(3));
      expect((await assertCashInvariants(ctx)).balance).toBe(0);
    });
  });

  describe('refunds (LC-12)', () => {
    async function dealerWithCredit(credit: number) {
      const dealer = await createDealer(ctx.prisma);
      const { invoice, order } = await createInvoice(
        ctx.prisma,
        dealer.id,
        1000,
      );
      await ctx
        .post('/payments', {
          invoiceId: invoice.id,
          amount: 1000,
          mode: 'CASH',
          paymentDate: today(),
        })
        .expect(201);
      // A fully paid invoice whose goods were partly returned leaves the
      // dealer in credit (negative outstanding), as SalesReturnsService does.
      await ctx.prisma.salesReturn.create({
        data: {
          returnNumber: `SR-${dealer.id.slice(0, 6)}`,
          orderId: order.id,
          dealerId: dealer.id,
          reason: 'returned goods',
          totalAmount: credit,
          returnDate: new Date(),
        },
      });
      await ctx.prisma.dealer.update({
        where: { id: dealer.id },
        data: { outstandingBalance: { decrement: credit } },
      });
      return dealer;
    }

    it('a dealer refund pays out cash and consumes the credit; it cannot exceed it', async () => {
      const dealer = await dealerWithCredit(400);
      const available = (
        await ctx.get(`/refunds/available/dealer/${dealer.id}`).expect(200)
      ).body;
      expect(available.availableCredit).toBe(400);
      const body = {
        party: 'DEALER',
        dealerId: dealer.id,
        mode: 'CASH',
        refundDate: today(),
        reason: 'return credit',
      };
      await ctx.post('/refunds', { ...body, amount: 400.01 }).expect(400);
      await ctx.post('/refunds', { ...body, amount: 250 }).expect(201);
      const dup = await ctx
        .post('/refunds', { ...body, amount: 250 })
        .expect(409);
      expect(dup.body.error).toBe('POSSIBLE_DUPLICATE');
      const d = await ctx.prisma.dealer.findUniqueOrThrow({
        where: { id: dealer.id },
      });
      expect(d.outstandingBalance.toNumber()).toBe(-150);
      const summary = await ctx.get('/liquid-cash/summary').expect(200);
      expect(summary.body).toMatchObject({
        balance: 750,
        totalRefundsPaid: 250,
      });
    });

    it('concurrent dealer refunds never exceed the credit', async () => {
      const dealer = await dealerWithCredit(500);
      const results = await Promise.all(
        [300, 250].map((amount) =>
          ctx.post('/refunds', {
            party: 'DEALER',
            dealerId: dealer.id,
            amount,
            mode: 'CASH',
            refundDate: today(),
            reason: 'overpaid',
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    });

    it('a cheque refund pays out only when CLEARED; RETURNED restores the credit; cancel is a dated correction', async () => {
      const dealer = await dealerWithCredit(400);
      const chq = await ctx
        .post('/refunds', {
          party: 'DEALER',
          dealerId: dealer.id,
          amount: 400,
          mode: 'CHEQUE',
          chequeNumber: 'R-1',
          bankName: 'BOC',
          chequeDate: today(),
          refundDate: today(),
          reason: 'overpaid',
        })
        .expect(201);
      let s = (await ctx.get('/liquid-cash/summary').expect(200)).body;
      expect(s).toMatchObject({
        balance: 1000,
        pendingRefundChequesOut: 400,
        pendingOut: 400,
      });
      await ctx
        .patch(`/refunds/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
        .expect(200);
      let d = await ctx.prisma.dealer.findUniqueOrThrow({
        where: { id: dealer.id },
      });
      expect(d.outstandingBalance.toNumber()).toBe(-400);
      await ctx
        .patch(`/refunds/${chq.body.id}/cheque-status`, { status: 'CLEARED' })
        .expect(400);

      const cash = await ctx
        .post('/refunds', {
          party: 'DEALER',
          dealerId: dealer.id,
          amount: 400,
          mode: 'CASH',
          refundDate: today(),
          reason: 'overpaid again',
        })
        .expect(201);
      await ctx
        .patch(`/refunds/${cash.body.id}/cancel`, {
          reason: 'entered in error',
        })
        .expect(200);
      await ctx
        .patch(`/refunds/${cash.body.id}/cancel`, { reason: 'again' })
        .expect(400);
      d = await ctx.prisma.dealer.findUniqueOrThrow({
        where: { id: dealer.id },
      });
      expect(d.outstandingBalance.toNumber()).toBe(-400);
      const refundRows = await fullHistory(ctx, '&type=REFUND');
      expect(refundRows.map((r) => [r.event, Number(r.amount)])).toEqual([
        ['RECORDED', 0],
        ['RECORDED', -400],
        ['CANCELLED', 400],
      ]);
      s = await assertCashInvariants(ctx);
      expect(s.balance).toBe(1000);
    });

    it('a supplier refund brings cash in and clears the supplier-owed credit', async () => {
      const supplier = await createSupplier(ctx.prisma);
      const product = await createProduct(ctx.prisma);
      const purchase = await ctx
        .post('/purchases', {
          supplierId: supplier.id,
          invoiceNumber: 'S1',
          purchaseDate: today(),
          items: [{ productId: product.id, quantity: 10, unitCost: 100 }],
        })
        .expect(201);
      await ctx
        .post(`/credits/${supplier.id}/settlements`, {
          amount: 1000,
          mode: 'CASH',
          paymentDate: today(),
        })
        .expect(201);
      await ctx
        .post('/purchase-returns', {
          purchaseId: purchase.body.id,
          supplierId: supplier.id,
          reason: 'faulty',
          returnDate: today(),
          items: [{ productId: product.id, quantity: 2, unitCost: 100 }],
        })
        .expect(201);
      const body = {
        party: 'SUPPLIER',
        supplierId: supplier.id,
        mode: 'BANK_TRANSFER',
        refundDate: today(),
        reason: 'return',
      };
      await ctx.post('/refunds', { ...body, amount: 201 }).expect(400);
      await ctx.post('/refunds', { ...body, amount: 200 }).expect(201);
      const detail = (await ctx.get(`/credits/${supplier.id}`).expect(200))
        .body;
      expect(Number(detail.creditBalance)).toBe(0);
      const s = await assertCashInvariants(ctx);
      expect(s).toMatchObject({ balance: -800, totalRefundsReceived: 200 });
    });
  });

  describe('cash adjustments (opening balance)', () => {
    const adjust = (body: object) =>
      ctx.post('/cash-adjustments', {
        type: 'ADJUSTMENT',
        adjustmentDate: today(),
        reason: 'bank reconciliation',
        evidenceReference: 'Statement 2026-10',
        password: ADMIN_PASSWORD,
        ...body,
      });

    it('requires the admin password and evidence; zero is refused', async () => {
      await adjust({ amount: 100, password: 'wrong' }).expect(403);
      await adjust({ amount: 100, evidenceReference: '' }).expect(400);
      await adjust({ amount: 0 }).expect(400);
      expect(await ctx.prisma.cashAdjustment.count()).toBe(0);
    });

    it('one active opening balance, dated on or before the first cash entry; reversal is a new row', async () => {
      const investor = await createInvestor(ctx.prisma);
      await invest(investor.id, 1000, { investmentDate: daysAgo(10) }).expect(
        201,
      );
      await adjust({
        type: 'OPENING_BALANCE',
        amount: 5000,
        adjustmentDate: daysAgo(9),
      }).expect(400);
      const results = await Promise.all([
        adjust({
          type: 'OPENING_BALANCE',
          amount: 5000,
          adjustmentDate: daysAgo(11),
        }),
        adjust({
          type: 'OPENING_BALANCE',
          amount: 5000,
          adjustmentDate: daysAgo(11),
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const opening = results.find((r) => r.status === 201)!.body;

      let s = await assertCashInvariants(ctx);
      expect(s).toMatchObject({
        balance: 6000,
        openingBalance: 5000,
        totalAdjustments: 0,
      });
      const history = await fullHistory(ctx);
      expect(history[0]).toMatchObject({
        type: 'ADJUSTMENT',
        event: 'OPENING_BALANCE',
      });
      expect(Number(history[1].balanceAfter)).toBe(6000);

      await ctx
        .post(`/cash-adjustments/${opening.id}/reverse`, {
          reason: 'wrong figure',
          password: ADMIN_PASSWORD,
        })
        .expect(201);
      await ctx
        .post(`/cash-adjustments/${opening.id}/reverse`, {
          reason: 'again',
          password: ADMIN_PASSWORD,
        })
        .expect(400);
      s = await assertCashInvariants(ctx);
      expect(s).toMatchObject({ balance: 1000, openingBalance: 0 });
      // The original stays in history; the reversal is its own row.
      expect(await ctx.prisma.cashAdjustment.count()).toBe(2);
      // And a corrected opening balance can now be entered.
      await adjust({
        type: 'OPENING_BALANCE',
        amount: 4500,
        adjustmentDate: daysAgo(11),
      }).expect(201);
      expect((await assertCashInvariants(ctx)).balance).toBe(5500);
    });

    it('a signed adjustment moves the balance and is reported separately', async () => {
      await adjust({ amount: -125.5 }).expect(201);
      const s = await assertCashInvariants(ctx);
      expect(s).toMatchObject({ balance: -125.5, totalAdjustments: -125.5 });
    });
  });
});
