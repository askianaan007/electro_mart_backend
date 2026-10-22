/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import { createProduct, createSupplier, today } from '../support/fixtures';
import { assertCashInvariants, fullHistory } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

describe('Supplier settlements, purchases → Liquid Cash and payables', () => {
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

  async function supplierWithPurchase(
    quantity = 100,
    unitCost = 100,
    transportCharges = 0,
  ) {
    const supplier = await createSupplier(ctx.prisma);
    const product = await createProduct(ctx.prisma);
    const purchase = await ctx
      .post('/purchases', {
        supplierId: supplier.id,
        invoiceNumber: 'SUP-INV-1',
        purchaseDate: today(),
        items: [{ productId: product.id, quantity, unitCost }],
        transportCharges,
      })
      .expect(201);
    return { supplier, product, purchase: purchase.body };
  }

  const balance = async (supplierId: string) =>
    Number(
      (await ctx.get(`/credits/${supplierId}`).expect(200)).body.creditBalance,
    );

  const settle = (supplierId: string, body: object) =>
    ctx.post(`/credits/${supplierId}/settlements`, {
      paymentDate: today(),
      ...body,
    });

  it('LC-08 rule: transport charges are deducted from the payable (supplier-borne), not a cash movement', async () => {
    const { supplier } = await supplierWithPurchase(10, 100, 150);
    expect(await balance(supplier.id)).toBe(850);
    const summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(0);
  });

  it('cash settlement reduces payable and cash; overpaying is refused', async () => {
    const { supplier } = await supplierWithPurchase();
    await settle(supplier.id, { amount: 4000, mode: 'CASH' }).expect(201);
    expect(await balance(supplier.id)).toBe(6000);
    await settle(supplier.id, {
      amount: 6000.01,
      mode: 'BANK_TRANSFER',
    }).expect(400);
    const summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(-4000);
    expect(summary.totalPaidToSuppliers).toBe(4000);
  });

  it('LC-03: supplier cheque lifecycle — payable falls when written, cash only when CLEARED; RETURNED is final after a day', async () => {
    const { supplier } = await supplierWithPurchase();
    const chq = await settle(supplier.id, {
      amount: 3000,
      mode: 'CHEQUE',
      reference: 'CHQ-9',
      chequeDepositDate: today(),
    }).expect(201);
    expect(await balance(supplier.id)).toBe(7000);
    let summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(0);
    expect(summary.pendingSupplierCheques).toBe(3000);
    expect(summary.pendingOut).toBe(3000);

    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'CLEARED',
      })
      .expect(200);
    summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(-3000);

    // CLEARED → RETURNED is not a legal supplier transition.
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'RETURNED',
      })
      .expect(400);
    // Within the day, a mis-click can be reverted to PENDING.
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'PENDING',
      })
      .expect(200);
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'RETURNED',
      })
      .expect(200);
    expect(await balance(supplier.id)).toBe(10_000);
    summary = await assertCashInvariants(ctx);
    expect(summary.balance).toBe(0);

    // After a day the RETURNED status is final.
    await ctx.prisma.supplierPayment.update({
      where: { id: chq.body.id },
      data: { chequeStatusUpdatedAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'PENDING',
      })
      .expect(400);

    // History never rewrote the clearing: it shows CLEARED then the revert
    // as its own row. PENDING → RETURNED moves no cash, so adds no row.
    const history = await fullHistory(ctx, '&type=SUPPLIER_PAYMENT');
    expect(history.map((r) => [r.event, Number(r.amount)])).toEqual([
      ['RECORDED', 0],
      ['CHEQUE_CLEARED', -3000],
      ['CHEQUE_PENDING', 3000],
    ]);
  });

  it('LC-03: reinstating a RETURNED cheque is refused if it would overpay the supplier', async () => {
    const { supplier } = await supplierWithPurchase(10, 100);
    const chq = await settle(supplier.id, {
      amount: 800,
      mode: 'CHEQUE',
      chequeDepositDate: today(),
    }).expect(201);
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'RETURNED',
      })
      .expect(200);
    await settle(supplier.id, { amount: 500, mode: 'CASH' }).expect(201);
    await ctx
      .patch(`/credits/settlements/${chq.body.id}/status`, {
        status: 'PENDING',
      })
      .expect(400);
    await assertCashInvariants(ctx);
  });

  it('LC-04: concurrent identical supplier settlements — one recorded, others flagged', async () => {
    const { supplier } = await supplierWithPurchase();
    const body = { amount: 1000, mode: 'CASH' };
    const results = await Promise.all(
      [1, 2, 3].map(() => settle(supplier.id, body)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe(
      'POSSIBLE_DUPLICATE',
    );
    await settle(supplier.id, { ...body, confirmDuplicate: true }).expect(201);
    expect(await balance(supplier.id)).toBe(8000);
    await assertCashInvariants(ctx);
  });

  it('concurrent different settlements never overpay the supplier', async () => {
    const { supplier } = await supplierWithPurchase(10, 100);
    const results = await Promise.all(
      [600, 500, 400].map((amount) =>
        settle(supplier.id, { amount, mode: 'CASH' }),
      ),
    );
    const paid = results
      .filter((r) => r.status === 201)
      .reduce((s, r) => s + Number(r.body.amount), 0);
    expect(paid).toBeLessThanOrEqual(1000);
    expect(await balance(supplier.id)).toBeGreaterThanOrEqual(0);
  });

  it('deleting a settlement (within a day) is a dated correction, not a rewrite', async () => {
    const { supplier } = await supplierWithPurchase();
    const s = await settle(supplier.id, { amount: 2000, mode: 'CASH' }).expect(
      201,
    );
    await ctx.del(`/credits/settlements/${s.body.id}`).expect(200);
    const history = await fullHistory(ctx);
    expect(history.map((r) => [r.event, Number(r.amount)])).toEqual([
      ['RECORDED', -2000],
      ['DELETED', 2000],
    ]);
    expect((await assertCashInvariants(ctx)).balance).toBe(0);
  });

  it('LC-25: a replacement receipt reverses the credit its return took off the payable', async () => {
    const { supplier, product, purchase } = await supplierWithPurchase(10, 100);
    await ctx
      .post('/purchase-returns', {
        purchaseId: purchase.id,
        supplierId: supplier.id,
        reason: 'damaged',
        returnDate: today(),
        items: [{ productId: product.id, quantity: 3, unitCost: 100 }],
      })
      .expect(201);
    expect(await balance(supplier.id)).toBe(700);
    const ret = await ctx.prisma.purchaseReturn.findFirstOrThrow();
    await ctx.prisma.purchaseReturnReplacement.create({
      data: {
        replacementNumber: 'RPL-T1',
        idempotencyKey: 'k1',
        purchaseReturnId: ret.id,
        supplierId: supplier.id,
        totalAmount: 200,
        receivedDate: new Date(),
        adminId: ctx.adminId,
      },
    });
    expect(await balance(supplier.id)).toBe(900);
    const all = (await ctx.get('/credits').expect(200)).body;
    const entry = all.entries.find(
      (e: any) =>
        e.supplierId === supplier.id || e.supplier?.id === supplier.id,
    );
    expect(Number(entry.creditBalance)).toBe(900);
    const cb = (await ctx.get('/credit-balance/summary').expect(200)).body;
    expect(cb).toMatchObject({
      balance: 900,
      totalReturns: 300,
      totalReplacements: 200,
    });
    // The payable ledger's running balance ends at the same figure.
    const ledger = (
      await ctx.get('/credit-balance/history?limit=100').expect(200)
    ).body.data;
    expect(ledger.map((r: any) => r.type)).toContain('REPLACEMENT');
    expect(Number(ledger[0].balanceAfter)).toBe(900);
  });

  it('LC-20: a purchase edit or delete that would leave the supplier overpaid is refused', async () => {
    const { supplier, product, purchase } = await supplierWithPurchase(10, 100);
    await settle(supplier.id, { amount: 900, mode: 'CASH' }).expect(201);
    await ctx
      .patch(`/purchases/${purchase.id}`, {
        supplierId: supplier.id,
        invoiceNumber: 'SUP-INV-1',
        purchaseDate: today(),
        items: [{ productId: product.id, quantity: 5, unitCost: 100 }],
      })
      .expect(400);
    await ctx.del(`/purchases/${purchase.id}`).expect(400);
    expect(await balance(supplier.id)).toBe(100);
    expect(await ctx.prisma.purchase.count()).toBe(1);
  });

  it('LC-20: deleting a purchase does not renumber other purchases', async () => {
    const { supplier, product } = await supplierWithPurchase(1, 10);
    const second = await ctx
      .post('/purchases', {
        supplierId: supplier.id,
        invoiceNumber: 'SUP-INV-2',
        purchaseDate: today(),
        items: [{ productId: product.id, quantity: 1, unitCost: 10 }],
      })
      .expect(201);
    const before = await ctx.prisma.purchase.findMany({
      orderBy: { createdAt: 'asc' },
    });
    await ctx.del(`/purchases/${before[0].id}`).expect(200);
    const after = await ctx.prisma.purchase.findUniqueOrThrow({
      where: { id: second.body.id },
    });
    expect(after.invoiceNumber).toBe(before[1].invoiceNumber);
  });
});
