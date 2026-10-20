/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read untyped JSON response bodies (supertest) */
import { createProduct, createSupplier, today } from '../support/fixtures';
import { assertCashInvariants } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

/**
 * A purchase of 60 × 1,450 = 87,000 with a 30,000 advance, then called off:
 * the goods go back, the supplier owes the advance back, and that refund
 * reaches Liquid Cash only when the money (or a cleared cheque) arrives.
 */
describe('Purchase cancellation and advance refunds', () => {
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

  async function orderWithAdvance() {
    const supplier = await createSupplier(ctx.prisma);
    const product = await createProduct(ctx.prisma);
    const purchase = (
      await ctx
        .post('/purchases', {
          supplierId: supplier.id,
          invoiceNumber: '000000',
          purchaseDate: today(),
          items: [{ productId: product.id, quantity: 60, unitCost: 1450 }],
        })
        .expect(201)
    ).body;
    await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 30000,
        mode: 'BANK_TRANSFER',
        paymentDate: today(),
      })
      .expect(201);
    return { supplier, product, purchase };
  }

  const cancel = (purchaseId: string) =>
    ctx.post(`/purchases/${purchaseId}/cancel`, {
      reason: 'Changed our mind',
      cancelDate: today(),
    });

  const balance = async (supplierId: string) =>
    Number(
      (await ctx.get(`/credits/${supplierId}`).expect(200)).body.creditBalance,
    );

  const cash = async () => (await assertCashInvariants(ctx)).balance;

  const stock = async (productId: string) =>
    (await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .currentStock;

  const refund = (supplierId: string, body: object) =>
    ctx.post('/refunds', {
      party: 'SUPPLIER',
      supplierId,
      refundDate: today(),
      reason: 'Advance on cancelled order',
      ...body,
    });

  it('cancelling returns every unit, flips the payable to a credit, and leaves cash alone', async () => {
    const { supplier, product, purchase } = await orderWithAdvance();
    expect(await balance(supplier.id)).toBe(57000);
    expect(await cash()).toBe(-30000);

    const cancelled = (await cancel(purchase.id).expect(201)).body;
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(await stock(product.id)).toBe(0);
    expect(await balance(supplier.id)).toBe(-30000);
    expect(await cash()).toBe(-30000);

    const returns = (
      await ctx.get(`/purchase-returns/by-purchase/${purchase.id}`).expect(200)
    ).body;
    expect(returns).toHaveLength(1);
    expect(returns[0].isCancellation).toBe(true);
    expect(Number(returns[0].totalAmount)).toBe(87000);

    // Nothing can be returned, edited or undone around the cancellation.
    await cancel(purchase.id).expect(400);
    await ctx
      .post('/purchase-returns', {
        purchaseId: purchase.id,
        reason: 'again',
        returnDate: today(),
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(400);
    await ctx.del(`/purchase-returns/${returns[0].id}`).expect(400);
    await ctx
      .patch(`/purchases/${purchase.id}`, {
        supplierId: supplier.id,
        invoiceNumber: '000000',
        purchaseDate: today(),
        items: [{ productId: product.id, quantity: 60, unitCost: 1450 }],
      })
      .expect(400);
  });

  it('a refund cheque only reaches Liquid Cash when cleared, and every status change can be undone', async () => {
    const { supplier, purchase } = await orderWithAdvance();
    await cancel(purchase.id).expect(201);

    const cheque = (
      await refund(supplier.id, {
        purchaseId: purchase.id,
        amount: 30000,
        mode: 'CHEQUE',
        chequeNumber: '123456',
        bankName: 'BOC',
        chequeDate: today(),
      }).expect(201)
    ).body;
    expect(cheque.chequeStatus).toBe('PENDING');
    expect(await balance(supplier.id)).toBe(0);
    expect(await cash()).toBe(-30000);

    const status = (s: string) =>
      ctx.patch(`/refunds/${cheque.id}/cheque-status`, { status: s });

    await status('CLEARED').expect(200);
    expect(await cash()).toBe(0);

    // Bank reverses it after clearing: the supplier owes us again.
    await status('RETURNED').expect(200);
    expect(await balance(supplier.id)).toBe(-30000);
    expect(await cash()).toBe(-30000);

    // Re-presented, then cleared.
    await status('PENDING').expect(200);
    expect(await balance(supplier.id)).toBe(0);
    expect(await cash()).toBe(-30000);
    await status('CLEARED').expect(200);
    expect(await cash()).toBe(0);

    const linked = (
      await ctx.get(`/refunds?purchaseId=${purchase.id}`).expect(200)
    ).body;
    expect(linked.data).toHaveLength(1);
    expect(linked.data[0].purchase.invoiceNumber).toBe('000000');
  });

  it('a cash refund can be edited, cancelled and restored, never beyond what is owed', async () => {
    const { supplier, purchase } = await orderWithAdvance();
    await cancel(purchase.id).expect(201);

    await refund(supplier.id, { amount: 30000.01, mode: 'CASH' }).expect(400);
    const cashRefund = (
      await refund(supplier.id, {
        purchaseId: purchase.id,
        amount: 30000,
        mode: 'CASH',
      }).expect(201)
    ).body;
    expect(await cash()).toBe(0);

    await ctx
      .patch(`/refunds/${cashRefund.id}/cancel`, { reason: 'Not received' })
      .expect(200);
    expect(await balance(supplier.id)).toBe(-30000);
    expect(await cash()).toBe(-30000);

    await ctx.patch(`/refunds/${cashRefund.id}/restore`).expect(200);
    expect(await cash()).toBe(0);

    const edit = (body: object) =>
      ctx.patch(`/refunds/${cashRefund.id}`, {
        amount: 20000,
        mode: 'CASH',
        refundDate: today(),
        reason: 'Part received',
        purchaseId: purchase.id,
        ...body,
      });
    await edit({}).expect(200);
    expect(await balance(supplier.id)).toBe(-10000);
    expect(await cash()).toBe(-10000);
    await edit({ amount: 30000.01 }).expect(400);

    // Turned out to be a cheque: out of Liquid Cash until it clears.
    const asCheque = (
      await edit({
        mode: 'CHEQUE',
        chequeNumber: '777',
        bankName: 'HNB',
        chequeDate: today(),
      }).expect(200)
    ).body;
    expect(asCheque.chequeStatus).toBe('PENDING');
    expect(await balance(supplier.id)).toBe(-10000);
    expect(await cash()).toBe(-30000);

    // Once the credit is used by another refund, the cancelled one can't come back.
    await ctx
      .patch(`/refunds/${cashRefund.id}/cancel`, { reason: 'Wrong entry' })
      .expect(200);
    await refund(supplier.id, { amount: 30000, mode: 'CASH' }).expect(201);
    await ctx.patch(`/refunds/${cashRefund.id}/restore`).expect(400);
    expect(await balance(supplier.id)).toBe(0);
    expect(await cash()).toBe(0);
  });

  it('reinstating removes the cancellation return and restores stock and the payable', async () => {
    const { supplier, product, purchase } = await orderWithAdvance();
    await cancel(purchase.id).expect(201);

    const reinstated = (
      await ctx.post(`/purchases/${purchase.id}/reinstate`).expect(201)
    ).body;
    expect(reinstated.cancelledAt).toBeNull();
    expect(await stock(product.id)).toBe(60);
    expect(await balance(supplier.id)).toBe(57000);
    expect(
      (await ctx.get(`/purchase-returns/by-purchase/${purchase.id}`)).body,
    ).toHaveLength(0);
    await ctx.post(`/purchases/${purchase.id}/reinstate`).expect(400);

    // And it can be cancelled again.
    await cancel(purchase.id).expect(201);
    expect(await balance(supplier.id)).toBe(-30000);
    await assertCashInvariants(ctx);
  });

  it('refuses to cancel once some of the goods have left stock', async () => {
    const { product, purchase } = await orderWithAdvance();
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: { currentStock: 10 },
    });
    const res = await cancel(purchase.id).expect(400);
    expect(res.body.message).toMatch(/already left stock/);
    const unchanged = (await ctx.get(`/purchases/${purchase.id}`)).body;
    expect(unchanged.cancelledAt).toBeNull();
  });

  it('a standalone return can be linked to its purchase, which then stops a second return of the same goods', async () => {
    const { supplier, product, purchase } = await orderWithAdvance();
    // Extra stock of the same product from elsewhere, so only the
    // purchase's own remaining-quantity check can stop a double return.
    await ctx.prisma.product.update({
      where: { id: product.id },
      data: { currentStock: { increment: 100 } },
    });
    const standalone = (
      await ctx
        .post('/purchase-returns', {
          supplierId: supplier.id,
          reason: 'Cancle',
          returnDate: today(),
          items: [{ productId: product.id, quantity: 60, unitCost: 1450 }],
        })
        .expect(201)
    ).body;
    expect(await balance(supplier.id)).toBe(-30000);

    const other = await createSupplier(ctx.prisma, 'Other');
    const otherPurchase = (
      await ctx
        .post('/purchases', {
          supplierId: other.id,
          invoiceNumber: 'OTHER-1',
          purchaseDate: today(),
          items: [{ productId: product.id, quantity: 60, unitCost: 1450 }],
        })
        .expect(201)
    ).body;
    await ctx
      .patch(`/purchase-returns/${standalone.id}/link`, {
        purchaseId: otherPurchase.id,
      })
      .expect(400);

    const linked = (
      await ctx
        .patch(`/purchase-returns/${standalone.id}/link`, {
          purchaseId: purchase.id,
        })
        .expect(200)
    ).body;
    expect(linked.purchaseId).toBe(purchase.id);
    expect(await balance(supplier.id)).toBe(-30000);

    await ctx
      .post('/purchase-returns', {
        purchaseId: purchase.id,
        reason: 'double',
        returnDate: today(),
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(400);

    // Already fully returned: cancelling just marks it, reinstating just unmarks it.
    await cancel(purchase.id).expect(201);
    await ctx.patch(`/purchase-returns/${standalone.id}/unlink`).expect(400);
    await ctx.post(`/purchases/${purchase.id}/reinstate`).expect(201);
    expect(
      (await ctx.get(`/purchase-returns/by-purchase/${purchase.id}`)).body,
    ).toHaveLength(1);

    await ctx.patch(`/purchase-returns/${standalone.id}/unlink`).expect(200);
    expect(
      (await ctx.get(`/purchase-returns?linked=false`)).body.data,
    ).toHaveLength(1);
    await assertCashInvariants(ctx);
  });

  it('a refund can only be linked to its own supplier’s purchase, and a linked purchase cannot be deleted', async () => {
    const { supplier, purchase } = await orderWithAdvance();
    await cancel(purchase.id).expect(201);
    const other = await createSupplier(ctx.prisma, 'Other');

    await refund(other.id, {
      purchaseId: purchase.id,
      amount: 1,
      mode: 'CASH',
    }).expect(400);
    await refund(supplier.id, {
      purchaseId: purchase.id,
      amount: 30000,
      mode: 'CASH',
    }).expect(201);

    await ctx.post(`/purchases/${purchase.id}/reinstate`).expect(201);
    const res = await ctx.del(`/purchases/${purchase.id}`).expect(400);
    expect(res.body.message).toMatch(/linked to this purchase/);
  });
});
