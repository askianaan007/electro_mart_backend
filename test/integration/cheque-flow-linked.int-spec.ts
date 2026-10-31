/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read untyped JSON response bodies (supertest) */
import { randomUUID } from 'crypto';
import { businessDateOf } from '../../src/common/utils/business-date';
import {
  createDealer,
  createInvoice,
  createPurchase,
  createSupplier,
} from '../support/fixtures';
import { assertCashInvariants } from '../support/invariants';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

const day = (offset: number) =>
  businessDateOf(new Date(Date.now() + offset * 86_400_000));
const month = (d: string) => d.slice(0, 7);

/**
 * Cheques recorded in Payments, Credits and Refunds show in Cheque Flow
 * automatically and follow every change made there — read live, never copied.
 */
describe('Cheque Flow — linked to Payments / Credits / Refunds', () => {
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

  async function fingerprint() {
    const out: string[] = [];
    for (const table of [
      'Payment',
      'SupplierPayment',
      'Invoice',
      'Dealer',
      'Supplier',
      'Refund',
      'PaymentRevision',
    ]) {
      const rows = await ctx.prisma.$queryRawUnsafe<{ h: string }[]>(
        `SELECT md5(t::text) h FROM "${table}" t ORDER BY 1`,
      );
      out.push(`${table}:${rows.map((r) => r.h).join(',')}`);
    }
    return out.join('|');
  }

  const flow = async (m: string, query = '') =>
    (await ctx.get(`/cheque-flow?month=${m}${query}`).expect(200)).body;

  async function customerCheque(chequeNumber: string, chequeDate = day(2)) {
    const dealer = await createDealer(ctx.prisma, 'Kaies Stores');
    const { invoice } = await createInvoice(ctx.prisma, dealer.id, 50_000);
    const payment = await ctx
      .post('/payments', {
        invoiceId: invoice.id,
        amount: 20_000,
        mode: 'CHEQUE',
        bankName: 'BOC',
        chequeNumber,
        chequeDate,
        collectedDate: day(0),
        paymentDate: day(0),
      })
      .expect(201);
    return { dealer, invoice, payment: payment.body };
  }

  async function supplierCheque(reference: string, chequeDepositDate = day(3)) {
    const supplier = await createSupplier(ctx.prisma, 'Singer');
    await createPurchase(ctx.prisma, supplier.id, ctx.adminId, 100_000);
    const settlement = await ctx
      .post(`/credits/${supplier.id}/settlements`, {
        amount: 30_000,
        mode: 'CHEQUE',
        reference,
        bankName: 'Sampath',
        chequeDepositDate,
        paymentDate: day(0),
      })
      .expect(201);
    return { supplier, settlement: settlement.body };
  }

  it('customer cheque from Payments: appears, follows cleared / bounced / undo / delete', async () => {
    const { dealer, invoice, payment } = await customerCheque('100200');
    const m = month(day(2));

    let body = await flow(m);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: `pay_${payment.id}`,
      source: 'PAYMENT',
      sourceId: payment.id,
      sourceLabel: 'Payments',
      direction: 'RECEIVABLE',
      chequeNumber: '100200',
      bankName: 'BOC',
      chequeDate: day(2),
      partyName: dealer.businessName,
      invoiceRef: invoice.invoiceNumber,
      amount: 20_000,
      status: 'PENDING',
      link: '/admin/payments',
    });
    expect(body.entries[0].allowedStatuses.sort()).toEqual([
      'BOUNCED',
      'CLEARED',
    ]);
    expect(body.summary.receivable.pending).toBe(20_000);
    expect(body.summary.netPending).toBe(20_000);
    expect(body.timeline).toEqual([
      expect.objectContaining({ date: day(2), receipts: 20_000 }),
    ]);

    // Cleared on the Payments page → cleared here, dated today.
    await ctx
      .patch(`/payments/${payment.id}/cheque-status`, { status: 'CLEARED' })
      .expect(200);
    body = await flow(m);
    expect(body.entries[0]).toMatchObject({
      status: 'CLEARED',
      clearedDate: day(0),
    });
    expect(body.summary.receivable).toMatchObject({
      pending: 0,
      cleared: 20_000,
      total: 20_000,
    });

    // Bounced (RETURNED) → bounced here, out of totals.
    await ctx
      .patch(`/payments/${payment.id}/cheque-status`, { status: 'RETURNED' })
      .expect(200);
    body = await flow(m);
    expect(body.entries[0].status).toBe('BOUNCED');
    expect(body.summary.receivable).toMatchObject({
      total: 0,
      bounced: 20_000,
    });

    // Undo on the Payments page → back to cleared.
    await ctx.post(`/payments/${payment.id}/undo`, {}).expect(201);
    body = await flow(m);
    expect(body.entries[0].status).toBe('CLEARED');

    // Deleted on the Payments page → gone here too.
    await ctx.del(`/payments/${payment.id}`).expect(200);
    body = await flow(m);
    expect(body.entries).toHaveLength(0);
    expect(body.summary.receivable.total).toBe(0);
  });

  it('supplier cheque from Credits: appears with its bank, follows status and delete', async () => {
    const { supplier, settlement } = await supplierCheque('#0091942');
    const m = month(day(3));

    let body = await flow(m);
    expect(body.entries[0]).toMatchObject({
      id: `set_${settlement.id}`,
      source: 'SETTLEMENT',
      sourceLabel: 'Credits',
      direction: 'PAYABLE',
      chequeNumber: '0091942',
      bankName: 'Sampath',
      chequeDate: day(3),
      partyName: supplier.name,
      amount: 30_000,
      status: 'PENDING',
      link: `/admin/credits/${supplier.id}`,
    });
    expect(body.summary.payable.pending).toBe(30_000);
    expect(body.summary.netPending).toBe(-30_000);

    await ctx
      .patch(`/credits/settlements/${settlement.id}/status`, {
        status: 'CLEARED',
      })
      .expect(200);
    body = await flow(m);
    expect(body.entries[0]).toMatchObject({
      status: 'CLEARED',
      clearedDate: day(0),
    });
    // The supplier rule allows only "back to pending" within a day.
    expect(body.entries[0].allowedStatuses).toEqual(['PENDING']);

    await ctx
      .patch(`/credits/settlements/${settlement.id}/status`, {
        status: 'PENDING',
      })
      .expect(200);
    await ctx.del(`/credits/settlements/${settlement.id}`).expect(200);
    body = await flow(m);
    expect(body.entries).toHaveLength(0);
  });

  it('merges all sources in totals, filters, search, alerts, chart and options', async () => {
    const { dealer } = await customerCheque('555001', day(-2)); // overdue
    const { supplier } = await supplierCheque('777001', day(-2));
    await ctx
      .post('/cheque-flow', {
        direction: 'RECEIVABLE',
        chequeNumber: '999001',
        bankName: 'HNB',
        chequeDate: day(-2),
        partyName: 'Walk-in Traders',
        amount: 5_000,
      })
      .expect(201);
    const m = month(day(-2));

    const body = await flow(m);
    expect(
      body.entries.map((e: { source: string }) => e.source).sort(),
    ).toEqual(['MANUAL', 'PAYMENT', 'SETTLEMENT']);
    expect(body.summary.receivable.pending).toBe(25_000);
    expect(body.summary.payable.pending).toBe(30_000);
    expect(body.summary.netPending).toBe(-5_000);

    expect((await flow(m, '&source=PAYMENT')).entries).toHaveLength(1);
    expect((await flow(m, '&source=MANUAL')).entries).toHaveLength(1);
    expect((await flow(m, '&search=777001')).entries[0].source).toBe(
      'SETTLEMENT',
    );
    expect((await flow(m, '&bank=sampath')).entries).toHaveLength(1);
    expect(
      (await flow(m, `&customer=${encodeURIComponent(dealer.businessName)}`))
        .entries,
    ).toHaveLength(2); // the customer filter leaves supplier cheques alone
    expect(
      (await flow(m, `&supplier=${encodeURIComponent(supplier.name)}`)).summary
        .payable.pending,
    ).toBe(30_000);

    const alerts = (await ctx.get('/cheque-flow/alerts').expect(200)).body;
    expect(alerts.overdue.entries).toHaveLength(3);
    expect(alerts.overdue.receivable).toBe(25_000);
    expect(alerts.overdue.payable).toBe(30_000);

    const chart = (
      await ctx.get(`/cheque-flow/monthly?from=${m}&to=${m}`).expect(200)
    ).body;
    expect(chart.months[0]).toMatchObject({
      receiptsPending: 25_000,
      paymentsPending: 30_000,
      netPending: -5_000,
    });

    const options = (await ctx.get('/cheque-flow/options').expect(200)).body;
    expect(options.banks).toEqual(['BOC', 'HNB', 'Sampath']);
    expect(options.customers).toContain(dealer.businessName);
    expect(options.suppliers).toContain(supplier.name);
  });

  it('a cheque already in Payments/Credits cannot be added again by hand or by import; an older manual copy is not double-counted', async () => {
    // Manual first, then the same cheque is recorded in Payments.
    await ctx
      .post('/cheque-flow', {
        direction: 'RECEIVABLE',
        chequeNumber: '00300400',
        bankName: 'boc',
        chequeDate: day(2),
        partyName: 'Kaies',
        amount: 20_000,
      })
      .expect(201);
    const { payment } = await customerCheque('300400');
    const m = month(day(2));
    const body = await flow(m);
    expect(body.entries).toHaveLength(2);
    const manual = body.entries.find(
      (e: { source: string }) => e.source === 'MANUAL',
    );
    expect(manual.duplicateOf).toEqual({
      source: 'PAYMENT',
      id: `pay_${payment.id}`,
      label: 'Payments',
    });
    expect(manual.dueState).toBeNull();
    expect(body.duplicates).toBe(1);
    expect(body.summary.receivable.pending).toBe(20_000); // counted once
    const alerts = (await ctx.get('/cheque-flow/alerts').expect(200)).body;
    expect(alerts.dueSoon.entries).toHaveLength(1);

    // Adding it by hand now is refused, naming where it is.
    const dup = await ctx
      .post('/cheque-flow', {
        direction: 'RECEIVABLE',
        chequeNumber: '300400',
        bankName: 'BOC',
        chequeDate: day(2),
        partyName: 'Kaies',
        amount: 20_000,
      })
      .expect(409);
    expect(dup.body.message).toMatch(/already recorded in Payments/);
    // Same number on the supplier side is a different cheque.
    await ctx
      .post('/cheque-flow', {
        direction: 'PAYABLE',
        chequeNumber: '300400',
        bankName: 'BOC',
        chequeDate: day(2),
        partyName: 'Singer',
        amount: 1_000,
      })
      .expect(201);

    // Supplier settlement cheque vs import.
    await supplierCheque('881122');
    const preview = (
      await ctx
        .post('/cheque-flow/imports/preview', {
          rows: [
            {
              direction: 'PAYABLE',
              chequeNumber: 881122,
              bankName: 'Sampath',
              chequeDate: day(3),
              partyName: 'Singer',
              amount: 30_000,
              status: '',
            },
            {
              direction: 'RECEIVABLE',
              chequeNumber: '424242',
              bankName: 'BOC',
              chequeDate: day(3),
              partyName: 'New Shop',
              amount: 1_500,
              status: '',
            },
          ],
        })
        .expect(201)
    ).body;
    expect(preview.rows[0]).toMatchObject({
      result: 'duplicate',
      duplicateOf: 'linked',
    });
    expect(preview.rows[1].result).toBe('ready');
    const commit = (
      await ctx
        .post('/cheque-flow/imports', {
          importKey: randomUUID(),
          fileName: 'x.xlsx',
          rows: preview.rows.map((_: unknown, i: number) =>
            i === 0
              ? {
                  direction: 'PAYABLE',
                  chequeNumber: 881122,
                  bankName: 'Sampath',
                  chequeDate: day(3),
                  partyName: 'Singer',
                  amount: 30_000,
                  status: '',
                }
              : {
                  direction: 'RECEIVABLE',
                  chequeNumber: '424242',
                  bankName: 'BOC',
                  chequeDate: day(3),
                  partyName: 'New Shop',
                  amount: 1_500,
                  status: '',
                },
          ),
        })
        .expect(201)
    ).body;
    expect(commit).toMatchObject({ inserted: 1, skipped: 1 });
  });

  it('refund cheques show on the right side; cancelled refunds are cancelled', async () => {
    const supplier = await createSupplier(ctx.prisma);
    const dealer = await createDealer(ctx.prisma);
    const admin = await ctx.prisma.admin.findFirstOrThrow();
    const base = {
      amount: 4_000,
      mode: 'CHEQUE' as const,
      refundDate: new Date(`${day(0)}T00:00:00.000Z`),
      chequeStatus: 'PENDING' as const,
      chequeStatusUpdatedAt: new Date(),
      bankName: 'NSB',
      chequeDate: new Date(`${day(1)}T00:00:00.000Z`),
      reason: 'Overpaid',
      adminId: admin.id,
    };
    await ctx.prisma.refund.create({
      data: {
        ...base,
        refundNumber: 'RF-1',
        party: 'SUPPLIER',
        supplierId: supplier.id,
        chequeNumber: '1111',
      },
    });
    await ctx.prisma.refund.create({
      data: {
        ...base,
        refundNumber: 'RF-2',
        party: 'DEALER',
        dealerId: dealer.id,
        chequeNumber: '2222',
        cancelledAt: new Date(),
      },
    });
    const body = await flow(month(day(1)));
    const byNo = Object.fromEntries(
      body.entries.map((e: { chequeNumber: string }) => [e.chequeNumber, e]),
    );
    expect(byNo['1111']).toMatchObject({
      source: 'REFUND',
      direction: 'RECEIVABLE',
      kindLabel: 'Refund from supplier',
      invoiceRef: 'RF-1',
      status: 'PENDING',
    });
    expect(byNo['2222']).toMatchObject({
      direction: 'PAYABLE',
      kindLabel: 'Refund to customer',
      status: 'CANCELLED',
      allowedStatuses: [],
    });
    expect(body.summary.receivable.pending).toBe(4_000);
    expect(body.summary.payable).toMatchObject({ total: 0, cancelled: 4_000 });
  });

  it('reading Cheque Flow never changes ERP data, and the money stays consistent', async () => {
    await customerCheque('123123');
    await supplierCheque('456456');
    const before = await fingerprint();
    await flow(month(day(2)));
    await flow(month(day(2)), '&search=123');
    await ctx.get('/cheque-flow?month=all').expect(400);
    await ctx.get('/cheque-flow').expect(200);
    await ctx.get('/cheque-flow/alerts').expect(200);
    await ctx.get('/cheque-flow/monthly').expect(200);
    await ctx.get('/cheque-flow/options').expect(200);
    expect(await fingerprint()).toBe(before);
    await assertCashInvariants(ctx);
  });

  it('linked rows cannot be edited or deleted through the register endpoints', async () => {
    const { payment } = await customerCheque('777777');
    await ctx
      .patch(`/cheque-flow/pay_${payment.id}`, { amount: 1 })
      .expect(400);
    await ctx.del(`/cheque-flow/pay_${payment.id}`).expect(400);
    await ctx.patch(`/cheque-flow/${payment.id}`, { amount: 1 }).expect(404);
    const stored = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(stored.amount.toNumber()).toBe(20_000);
  });
});
