/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- assertions read untyped JSON response bodies (supertest) */
import {
  createDealer,
  createInvoice,
  createRepresentative,
  today,
} from '../support/fixtures';
import { assertCashInvariants } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

describe('Rep collections (LC-18)', () => {
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

  async function submission(
    customerId: string,
    invoiceId: string | null,
    amount: number,
  ) {
    const rep = await createRepresentative(ctx.prisma);
    return ctx.prisma.collectionSubmission.create({
      data: {
        representativeId: rep.id,
        customerId,
        invoiceId,
        amount,
        mode: 'CASH',
        collectionDate: new Date(),
      },
    });
  }

  it('confirms into exactly one payment, also under concurrent confirms', async () => {
    const dealer = await createDealer(ctx.prisma);
    const { invoice } = await createInvoice(ctx.prisma, dealer.id, 5000);
    const sub = await submission(dealer.id, invoice.id, 2000);
    const results = await Promise.all(
      [1, 2, 3].map(() => ctx.patch(`/collections/${sub.id}/confirm`, {})),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await ctx.prisma.payment.count()).toBe(1);
    const after = await ctx.prisma.collectionSubmission.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe('CONFIRMED');
    expect(after.resultingPaymentId).toBeTruthy();
    expect((await assertCashInvariants(ctx)).balance).toBe(2000);
  });

  it("refuses another dealer's invoice and leaves the submission pending", async () => {
    const dealer = await createDealer(ctx.prisma);
    const other = await createDealer(ctx.prisma, 'Other');
    const { invoice } = await createInvoice(ctx.prisma, other.id, 5000);
    const sub = await submission(dealer.id, null, 2000);
    await ctx
      .patch(`/collections/${sub.id}/confirm`, { invoiceId: invoice.id })
      .expect(400);
    const after = await ctx.prisma.collectionSubmission.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after).toMatchObject({
      status: 'PENDING_VERIFICATION',
      invoiceId: null,
      resultingPaymentId: null,
    });
    expect(await ctx.prisma.payment.count()).toBe(0);
  });

  it('rolls the confirmation back if the payment is refused (overpayment)', async () => {
    const dealer = await createDealer(ctx.prisma);
    const { invoice } = await createInvoice(ctx.prisma, dealer.id, 1000);
    const sub = await submission(dealer.id, invoice.id, 1500);
    await ctx.patch(`/collections/${sub.id}/confirm`, {}).expect(400);
    const after = await ctx.prisma.collectionSubmission.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(after.status).toBe('PENDING_VERIFICATION');
    expect(await ctx.prisma.payment.count()).toBe(0);
    const d = await ctx.prisma.dealer.findUniqueOrThrow({
      where: { id: dealer.id },
    });
    expect(d.outstandingBalance.toNumber()).toBe(1000);
  });

  it('a confirmed or rejected submission cannot be rejected/confirmed again', async () => {
    const dealer = await createDealer(ctx.prisma);
    const { invoice } = await createInvoice(ctx.prisma, dealer.id, 1000);
    const sub = await submission(dealer.id, invoice.id, 100);
    await ctx
      .patch(`/collections/${sub.id}/reject`, { reason: 'not received' })
      .expect(200);
    await ctx.patch(`/collections/${sub.id}/confirm`, {}).expect(400);
    const results = await Promise.all(
      [1, 2].map(() =>
        ctx.patch(`/collections/${sub.id}/reject`, { reason: 'again' }),
      ),
    );
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
});

describe('Sales returns and payments together (LC-17)', () => {
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

  it('a return and a payment on the same dealer at the same time are both applied to outstandingBalance', async () => {
    const dealer = await createDealer(ctx.prisma);
    await ctx.prisma.dealer.update({
      where: { id: dealer.id },
      data: { creditLimit: 1_000_000 },
    });
    const product = await ctx.prisma.product.create({
      data: {
        productCode: 'RET-1',
        name: 'P',
        costPrice: 100,
        wholesalePrice: 200,
        currentStock: 50,
      },
    });
    const a = await ctx
      .post('/orders', {
        dealerId: dealer.id,
        items: [{ productId: product.id, quantity: 5 }],
      })
      .expect(201);
    await ctx.patch(`/orders/${a.body.id}/complete`).expect(200);
    const b = await ctx
      .post('/orders', {
        dealerId: dealer.id,
        items: [{ productId: product.id, quantity: 5 }],
      })
      .expect(201);
    await ctx.patch(`/orders/${b.body.id}/complete`).expect(200);
    const invB = await ctx.prisma.invoice.findFirstOrThrow({
      where: { orderId: b.body.id },
    });

    await Promise.all([
      ctx
        .post('/sales-returns', {
          orderId: a.body.id,
          reason: 'faulty',
          returnDate: today(),
          items: [{ productId: product.id, quantity: 2 }],
        })
        .expect(201),
      ctx
        .post('/payments', {
          invoiceId: invB.id,
          amount: 300,
          mode: 'CASH',
          paymentDate: today(),
        })
        .expect(201),
    ]);
    const d = await ctx.prisma.dealer.findUniqueOrThrow({
      where: { id: dealer.id },
    });
    expect(d.outstandingBalance.toNumber()).toBe(2000 - 400 - 300);
    await assertCashInvariants(ctx);
  });
});
