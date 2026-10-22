/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- assertions read untyped JSON response bodies (supertest) */
import {
  createDealer,
  createInvestor,
  createProduct,
  createSupplier,
  daysAgo,
  today,
} from '../support/fixtures';
import { assertCashInvariants } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

/**
 * The whole business cycle through the API — capital, purchase, supplier
 * settlement, sales, overpayment into the wallet, wallet used on the next
 * sale, a return on a paid invoice, a refund from the wallet, an expense and
 * a bounced cheque — then every report must agree: Liquid Cash, the dealer's
 * wallet and dues, Credit Balance (summary and ledger), the dashboard and
 * the balance sheet.
 */
describe('Full ERP cycle with the dealer wallet', () => {
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

  it('every figure agrees through overpayment, wallet use, return, refund and a bounce', async () => {
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
      data: { unlimitedCredit: true },
    });

    // Capital and stock.
    await ctx
      .post('/investments', {
        investorId: investor.id,
        amount: 200_000,
        mode: 'CASH',
        investmentDate: daysAgo(10),
        reason: 'capital',
      })
      .expect(201);
    await ctx
      .post('/purchases', {
        supplierId: supplier.id,
        invoiceNumber: 'P-1',
        purchaseDate: daysAgo(9),
        items: [{ productId: product.id, quantity: 20, unitCost: 1000 }],
      })
      .expect(201);
    await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 15_000,
        mode: 'CASH',
        paymentDate: daysAgo(8),
      })
      .expect(201);

    const sell = async (quantity: number, walletCredit?: number) => {
      const order = await ctx
        .post('/orders', {
          dealerId: dealer.id,
          items: [{ productId: product.id, quantity }],
          ...(walletCredit && { walletCredit }),
        })
        .expect(201);
      await ctx.patch(`/orders/${order.body.id}/complete`).expect(200);
      const invoice = await ctx.prisma.invoice.findFirstOrThrow({
        where: { orderId: order.body.id },
      });
      return { orderId: order.body.id as string, invoice };
    };
    const pay = (invoiceId: string, amount: number, extra: object = {}) =>
      ctx.post('/payments', {
        invoiceId,
        amount,
        mode: 'CASH',
        paymentDate: daysAgo(5),
        ...extra,
      });
    const wallet = async () =>
      (await ctx.get(`/dealers/${dealer.id}/wallet`).expect(200)).body;

    // A: 10,000 bill, 12,000 handed over → 2,000 into the wallet, only when asked.
    const a = await sell(5);
    await pay(a.invoice.id, 12_000).expect(400);
    await pay(a.invoice.id, 12_000, { excessToWallet: true }).expect(201);
    expect(await wallet()).toMatchObject({ balance: 2000, available: 2000 });

    // B: 4,000 bill, 1,500 from the wallet at order time, 2,500 cash.
    const b = await sell(2, 1500);
    await pay(b.invoice.id, 2501).expect(400);
    await pay(b.invoice.id, 2500).expect(201);
    expect(
      (
        await ctx.prisma.invoice.findUniqueOrThrow({
          where: { id: b.invoice.id },
        })
      ).paymentStatus,
    ).toBe('PAID');

    // A return on paid invoice A puts the 2,000 refund value in the wallet.
    await ctx
      .post('/sales-returns', {
        orderId: a.orderId,
        reason: 'faulty',
        returnDate: daysAgo(4),
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(201);
    expect(await wallet()).toMatchObject({ balance: 2500, available: 2500 });

    // 1,000 paid back from the wallet in cash; an expense.
    await ctx
      .post('/refunds', {
        party: 'DEALER',
        dealerId: dealer.id,
        amount: 1000,
        mode: 'CASH',
        refundDate: daysAgo(3),
        reason: 'wallet refund',
      })
      .expect(201);
    await ctx
      .post('/expenses', {
        description: 'rent',
        amount: 500,
        expenseDate: daysAgo(3),
      })
      .expect(201);

    // C: 2,000 bill paid with a 2,500 cheque — its 500 extra waits for clearing.
    const c = await sell(1);
    const chq = await pay(c.invoice.id, 2500, {
      mode: 'CHEQUE',
      bankName: 'BOC',
      chequeNumber: 'W1',
      chequeDate: today(),
      collectedDate: daysAgo(2),
      excessToWallet: true,
    }).expect(201);
    expect(await wallet()).toMatchObject({
      balance: 2000,
      available: 1500,
      pending: 500,
    });

    const checkAll = async (expected: {
      cash: number;
      wallet: number;
      owed: number;
    }) => {
      // Liquid Cash — wallet credit is never cash.
      const cash = await assertCashInvariants(ctx);
      expect(cash.balance).toBe(expected.cash);
      expect(
        await ctx.prisma.payment.count({ where: { dealerId: dealer.id } }),
      ).toBe(3); // 12,000 and 2,500 cash, the cheque

      // Dealer page: balance + wallet = what's owed on invoices.
      const d = (await ctx.get(`/dealers/${dealer.id}`).expect(200)).body;
      const w = await wallet();
      expect(w.balance).toBe(expected.wallet);
      expect(Math.round((Number(d.balance) + w.balance) * 100) / 100).toBe(
        expected.owed,
      );

      // Credit Balance: suppliers 5,000 + positive wallets; the ledger ends there.
      const cb = (await ctx.get('/credit-balance/summary').expect(200)).body;
      const held = Math.max(0, expected.wallet);
      expect(cb).toMatchObject({
        balance: 5000,
        customerWallets: held,
        totalOwed: 5000 + held,
      });
      const ledger = (
        await ctx.get('/credit-balance/history?limit=1').expect(200)
      ).body;
      expect(Number(ledger.data[0].balanceAfter)).toBe(5000 + held);

      // Dashboard.
      const dash = (await ctx.get('/dashboard/admin').expect(200)).body;
      expect(dash.liquidCash).toBe(expected.cash);
      expect(dash.creditBalance).toBe(5000 + held);
      expect(Number(dash.outstandingPayments)).toBe(expected.owed);

      // Balance sheet: wallet money is a liability, and nothing is unexplained.
      const sheet = (await ctx.get('/balance-sheet').expect(200)).body;
      expect(sheet.assets.current.cashAndBank).toBe(expected.cash.toFixed(2));
      expect(sheet.liabilities.current.customerAdvances).toBe(held.toFixed(2));
      expect(sheet.liabilities.current.accountsPayable).toBe('5000.00');
      expect(sheet.reconciliation.unexplainedDifference).toBe('0.00');
      expect(sheet.reconciliation.status).not.toBe('UNBALANCED');
    };

    // 200,000 − 15,000 + 12,000 + 2,500 − 1,000 − 500 (cheque still pending)
    await checkAll({ cash: 198_000, wallet: 2000, owed: 0 });

    // The cheque clears: cash +2,500, the 500 becomes spendable.
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    expect(await wallet()).toMatchObject({ available: 2000, pending: 0 });
    await checkAll({ cash: 200_500, wallet: 2000, owed: 0 });

    // The bank reverses it: C is unpaid again and its 500 extra is gone.
    await ctx
      .patch(`/payments/${chq.body.id}/cheque-status`, { status: 'RETURNED' })
      .expect(200);
    await checkAll({ cash: 198_000, wallet: 1500, owed: 2000 });

    // The wallet pays C's balance off — no cash moves.
    await ctx
      .post(`/invoices/${c.invoice.id}/wallet-credit`, { amount: 1500 })
      .expect(201);
    await checkAll({ cash: 198_000, wallet: 0, owed: 500 });
  });
});
