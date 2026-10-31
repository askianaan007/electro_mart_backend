/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read untyped JSON response bodies (supertest) */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { businessDateOf } from '../../src/common/utils/business-date';
import { createDealer, createInvoice } from '../support/fixtures';
import {
  createTestApp,
  resetWithAdmin,
  TestContext,
} from '../support/test-app';

const day = (offset: number) =>
  businessDateOf(new Date(Date.now() + offset * 86_400_000));
const monthOfDay = (d: string) => d.slice(0, 7);

describe('Cheque Flow register', () => {
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

  const cheque = (over: object = {}) => ({
    direction: 'RECEIVABLE',
    chequeNumber: '000718',
    bankName: 'Amana bank',
    chequeDate: day(3),
    partyName: 'PEDO CENTER',
    invoiceRef: 'INV-2026-00042',
    amount: 190800,
    ...over,
  });

  /** md5 of every row of the ERP's money tables — must not move. */
  async function fingerprint() {
    const out: string[] = [];
    for (const table of [
      'Payment',
      'SupplierPayment',
      'Invoice',
      'Dealer',
      'Supplier',
      'Expense',
      'Investment',
      'Refund',
    ]) {
      const rows = await ctx.prisma.$queryRawUnsafe<{ h: string }[]>(
        `SELECT md5(t::text) h FROM "${table}" t ORDER BY 1`,
      );
      out.push(`${table}:${rows.map((r) => r.h).join(',')}`);
    }
    return out.join('|');
  }

  it('adds, lists by month, totals, moves months, and never touches ERP data', async () => {
    const dealer = await createDealer(ctx.prisma);
    await createInvoice(ctx.prisma, dealer.id, 5000);
    const before = await fingerprint();

    const a = await ctx.post('/cheque-flow', cheque()).expect(201);
    expect(a.body).toMatchObject({
      chequeNumber: '000718',
      amount: 190800,
      status: 'PENDING',
      dueState: 'soon',
    });
    // Same cheque again — even written differently — is refused.
    const dup = await ctx
      .post(
        '/cheque-flow',
        cheque({ chequeNumber: '#718', bankName: 'AMANA  BANK' }),
      )
      .expect(409);
    expect(dup.body.message).toMatch(/already in the register/);
    // The same number at another bank is a different cheque.
    await ctx
      .post('/cheque-flow', cheque({ bankName: 'BOC', amount: 100 }))
      .expect(201);

    await ctx
      .post('/cheque-flow', {
        ...cheque({
          direction: 'PAYABLE',
          chequeNumber: '#091944',
          partyName: 'E-Max',
          bankName: 'Sampath',
          amount: 100000,
        }),
      })
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({ chequeNumber: '1', status: 'BOUNCED', amount: 999 }),
      )
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({ chequeNumber: '2', status: 'CANCELLED', amount: 111 }),
      )
      .expect(201);

    const month = monthOfDay(day(3));
    const list = (await ctx.get(`/cheque-flow?month=${month}`).expect(200))
      .body;
    expect(list.entries).toHaveLength(5);
    expect(list.filtered).toBe(false);
    expect(list.summary.receivable).toMatchObject({
      pending: 190900,
      total: 190900,
      bounced: 999,
      cancelled: 111,
    });
    expect(list.summary.payable.pending).toBe(100000);
    expect(list.summary.netPending).toBe(90900);
    expect(list.timeline).toHaveLength(1);

    // Filters narrow only their own side and are flagged.
    const filtered = (
      await ctx
        .get(`/cheque-flow?month=${month}&supplier=e-max&bank=sampath`)
        .expect(200)
    ).body;
    expect(filtered.filtered).toBe(true);
    expect(
      filtered.entries.map((e: { partyName: string }) => e.partyName),
    ).toEqual(['E-Max']);
    const search = (
      await ctx.get(`/cheque-flow?month=${month}&search=091944`).expect(200)
    ).body;
    expect(search.entries).toHaveLength(1);

    // Changing the cheque date moves it to that month.
    const later = '2030-01-15';
    await ctx
      .patch(`/cheque-flow/${a.body.id}`, { chequeDate: later })
      .expect(200);
    expect(
      (await ctx.get(`/cheque-flow?month=${month}`).expect(200)).body.entries,
    ).toHaveLength(4);
    const jan = (await ctx.get('/cheque-flow?month=2030-01').expect(200)).body;
    expect(jan.entries.map((e: { id: string }) => e.id)).toEqual([a.body.id]);
    const all = (await ctx.get('/cheque-flow').expect(200)).body;
    expect(all.month).toBeNull();
    expect(all.entries).toHaveLength(5);

    expect(await fingerprint()).toBe(before);
  });

  it('status: cleared needs a real date, is never automatic, and leaving it clears the date', async () => {
    const past = await ctx
      .post('/cheque-flow', cheque({ chequeDate: day(-10) }))
      .expect(201);
    expect(past.body.dueState).toBe('overdue');
    expect(past.body.daysOverdue).toBe(10);
    const path = `/cheque-flow/${past.body.id}/status`;

    await ctx.patch(path, { status: 'CLEARED' }).expect(400);
    await ctx
      .patch(path, { status: 'CLEARED', clearedDate: day(2) })
      .expect(400);
    await ctx
      .patch(path, { status: 'CLEARED', clearedDate: day(-11) })
      .expect(400);
    const cleared = await ctx
      .patch(path, { status: 'CLEARED', clearedDate: day(-1) })
      .expect(200);
    expect(cleared.body).toMatchObject({
      status: 'CLEARED',
      clearedDate: day(-1),
      dueState: null,
    });
    const bounced = await ctx.patch(path, { status: 'BOUNCED' }).expect(200);
    expect(bounced.body.clearedDate).toBeNull();
    await ctx.patch(path, { status: 'NOPE' }).expect(400);

    // Creating as cleared also needs the date.
    await ctx
      .post('/cheque-flow', cheque({ chequeNumber: '5', status: 'CLEARED' }))
      .expect(400);
  });

  it('rejects bad input with clear messages', async () => {
    await ctx.post('/cheque-flow', cheque({ amount: 0 })).expect(400);
    await ctx.post('/cheque-flow', cheque({ amount: 1.234 })).expect(400);
    await ctx.post('/cheque-flow', cheque({ partyName: '   ' })).expect(400);
    await ctx
      .post('/cheque-flow', cheque({ chequeDate: '2026-02-30' }))
      .expect(400);
    await ctx
      .post('/cheque-flow', cheque({ direction: 'SIDEWAYS' }))
      .expect(400);
    await ctx.post('/cheque-flow', cheque({ extra: 1 })).expect(400);
    await ctx.get('/cheque-flow?month=2026-13').expect(400);
    await ctx.get('/cheque-flow?status=PENDING,WHATEVER').expect(400);
    await ctx.get('/cheque-flow/not-a-uuid').expect(400);
    await ctx.get(`/cheque-flow/${randomUUID()}`).expect(404);
    await ctx.get('/cheque-flow/monthly?from=2026-01&to=2030-01').expect(400);
  });

  it('delete asks nothing of the server but is restorable, and restore re-checks duplicates', async () => {
    const a = await ctx.post('/cheque-flow', cheque()).expect(201);
    await ctx.del(`/cheque-flow/${a.body.id}`).expect(200);
    await ctx.del(`/cheque-flow/${a.body.id}`).expect(404);
    expect(
      (await ctx.get('/cheque-flow').expect(200)).body.entries,
    ).toHaveLength(0);
    // Re-entered meanwhile → restoring would duplicate it.
    const b = await ctx.post('/cheque-flow', cheque()).expect(201);
    await ctx.post(`/cheque-flow/${a.body.id}/restore`).expect(409);
    await ctx.del(`/cheque-flow/${b.body.id}`).expect(200);
    await ctx.post(`/cheque-flow/${a.body.id}/restore`).expect(201);
    expect(
      (await ctx.get('/cheque-flow').expect(200)).body.entries,
    ).toHaveLength(1);
  });

  it('concurrent identical saves record the cheque once', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ctx.post('/cheque-flow', cheque())),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409,
    ]);
  });

  it('alerts: overdue from any month, due today, next 7 days — pending only', async () => {
    await ctx
      .post('/cheque-flow', cheque({ chequeNumber: '1', chequeDate: day(-90) }))
      .expect(201);
    await ctx
      .post('/cheque-flow', cheque({ chequeNumber: '2', chequeDate: day(0) }))
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({ chequeNumber: '3', chequeDate: day(7), direction: 'PAYABLE' }),
      )
      .expect(201);
    await ctx
      .post('/cheque-flow', cheque({ chequeNumber: '4', chequeDate: day(8) }))
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({ chequeNumber: '5', chequeDate: day(-5), status: 'CANCELLED' }),
      )
      .expect(201);
    const alerts = (await ctx.get('/cheque-flow/alerts').expect(200)).body;
    expect(alerts.overdue.entries).toHaveLength(1);
    expect(alerts.overdue.entries[0].daysOverdue).toBe(90);
    expect(alerts.dueToday.entries).toHaveLength(1);
    expect(alerts.dueSoon.entries).toHaveLength(1);
    expect(alerts.dueSoon.payable).toBe(190800);
  });

  it('monthly chart series and filter options', async () => {
    await ctx
      .post('/cheque-flow', cheque({ chequeDate: '2026-11-05' }))
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({
          direction: 'PAYABLE',
          partyName: 'E-Max',
          chequeDate: '2026-11-10',
          amount: 100000,
        }),
      )
      .expect(201);
    await ctx
      .post(
        '/cheque-flow',
        cheque({
          chequeNumber: '9',
          chequeDate: '2026-12-01',
          status: 'BOUNCED',
        }),
      )
      .expect(201);
    const chart = (
      await ctx.get('/cheque-flow/monthly?from=2026-10&to=2026-12').expect(200)
    ).body;
    expect(chart.months.map((m: { month: string }) => m.month)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(chart.months[1]).toMatchObject({
      receipts: 190800,
      payments: 100000,
      net: 90800,
    });
    expect(chart.months[2].receipts).toBe(0);

    await createDealer(ctx.prisma, 'Kaies Stores');
    const options = (await ctx.get('/cheque-flow/options').expect(200)).body;
    expect(options.banks).toEqual(['Amana bank']);
    expect(options.customers).toEqual(['PEDO CENTER']);
    expect(options.suppliers).toEqual(['E-Max']);
    expect(options.customerSuggestions).toEqual(
      expect.arrayContaining([
        'PEDO CENTER',
        expect.stringMatching(/^Kaies Stores/),
      ]),
    );
  });

  it('import: preview reports each row, commit saves ready rows once, undo removes them', async () => {
    await ctx
      .post(
        '/cheque-flow',
        cheque({
          chequeNumber: '091938',
          bankName: 'Sampath',
          direction: 'PAYABLE',
          partyName: 'E-Max',
        }),
      )
      .expect(201);
    const rows = [
      {
        sourceRow: 5,
        direction: 'RECEIVABLE',
        chequeNumber: '',
        bankName: 'Amana bank',
        chequeDate: '2026-09-05',
        partyName: 'MASLOON MAHAL',
        amount: 224190,
        status: 'Pass',
      },
      {
        sourceRow: 6,
        direction: 'RECEIVABLE',
        chequeNumber: 170722,
        bankName: 'Amana bank',
        chequeDate: '2026-09-15',
        partyName: 'MASLOON MAHAL',
        invoiceRef: 'INV-2026-00037',
        amount: '149,460.00',
        status: 'Pass',
      },
      {
        sourceRow: 6,
        direction: 'PAYABLE',
        chequeNumber: '091938',
        bankName: 'Sampath ',
        chequeDate: '2026-09-11',
        partyName: 'E-Max',
        amount: 100000,
        status: 'Pass',
      },
      {
        sourceRow: 7,
        direction: 'PAYABLE',
        chequeNumber: '#091942 ',
        bankName: 'Sampath',
        chequeDate: '2026-10-17',
        partyName: 'E-Max',
        invoiceRef: '#0148',
        amount: 100000,
        status: 'Pending',
      },
      {
        sourceRow: 8,
        direction: 'PAYABLE',
        chequeNumber: '091942',
        bankName: 'sampath',
        chequeDate: '2026-10-17',
        partyName: 'E-Max',
        amount: 100000,
        status: 'Pending',
      },
      {
        sourceRow: 9,
        direction: 'RECEIVABLE',
        chequeNumber: '1',
        bankName: '',
        chequeDate: 'soon',
        partyName: 'X',
        amount: -5,
        status: 'Maybe',
      },
    ];
    const preview = (
      await ctx.post('/cheque-flow/imports/preview', { rows }).expect(201)
    ).body;
    expect(preview).toMatchObject({ ready: 3, duplicates: 2, errors: 1 });
    expect(preview.rows.map((r: { result: string }) => r.result)).toEqual([
      'ready',
      'ready',
      'duplicate',
      'ready',
      'duplicate',
      'error',
    ]);
    expect(preview.rows[2].duplicateOf).toBe('register');
    expect(preview.rows[4].duplicateOf).toBe('file');
    expect(preview.rows[5].errors.length).toBeGreaterThanOrEqual(4);
    expect(preview.rows[1].entry).toMatchObject({
      chequeNumber: '170722',
      amount: 149460,
      status: 'CLEARED',
      clearedDate: null,
    });
    expect(preview.rows[0].warnings).toContain('No cheque number');
    // Preview saved nothing.
    expect(await ctx.prisma.chequeFlowEntry.count()).toBe(1);

    const importKey = randomUUID();
    const body = {
      importKey,
      fileName: 'CHEQUE FLOW.xlsx',
      rows,
      clearedOnChequeDate: true,
    };
    const [first, again] = await Promise.all([
      ctx.post('/cheque-flow/imports', body),
      ctx.post('/cheque-flow/imports', body),
    ]);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect([first.body.replayed, again.body.replayed].sort()).toEqual([
      false,
      true,
    ]);
    expect(first.body.inserted).toBe(3);
    expect(
      await ctx.prisma.chequeFlowEntry.count({ where: { deletedAt: null } }),
    ).toBe(4);
    const imported = await ctx.prisma.chequeFlowEntry.findFirstOrThrow({
      where: { chequeNumber: '170722' },
    });
    expect(imported.clearedDate?.toISOString().slice(0, 10)).toBe('2026-09-15');

    // Re-importing the same sheet adds nothing.
    const second = await ctx
      .post('/cheque-flow/imports', { ...body, importKey: randomUUID() })
      .expect(400);
    expect(second.body.message).toMatch(/Nothing to import/);

    await ctx.del(`/cheque-flow/imports/${first.body.importId}`).expect(200);
    await ctx.del(`/cheque-flow/imports/${first.body.importId}`).expect(400);
    expect(
      await ctx.prisma.chequeFlowEntry.count({ where: { deletedAt: null } }),
    ).toBe(1);
    const imports = (await ctx.get('/cheque-flow/imports').expect(200)).body;
    expect(imports[0].undoneAt).not.toBeNull();
  });

  it('is admin-only', async () => {
    await request(ctx.app.getHttpServer()).get('/cheque-flow').expect(401);
  });
});
