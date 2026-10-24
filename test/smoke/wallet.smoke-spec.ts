/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- assertions read untyped JSON response bodies (supertest) */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { applyGlobalPipesAndFilters } from '../../src/create-app';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createDealer } from '../support/fixtures';

/**
 * Dealer wallet smoke run against the serial TEST COPY — never production.
 * Adds its own marked dealer/product/orders and proves no pre-existing
 * business row changed.
 */
const RUN = randomUUID().slice(0, 6).toUpperCase();

const FINGERPRINT_TABLES = [
  'Product',
  'Invoice',
  'Payment',
  'Dealer',
  'SalesReturn',
  'Refund',
  'DealerCreditUse',
];

function assertTestCopy() {
  for (const name of ['DATABASE_URL', 'DIRECT_URL']) {
    const value = process.env[name] ?? '';
    if (value.includes('ep-icy-boat') || !value.includes('ep-bold-voice')) {
      throw new Error(`REFUSED: ${name} is not the serial test copy`);
    }
  }
  if (process.env.SMTP_HOST) throw new Error('REFUSED: SMTP must be blank');
}

async function rowHashes(prisma: PrismaService) {
  const out = new Map<string, string>();
  for (const table of FINGERPRINT_TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; h: string }[]>(
      `SELECT id, md5(t::text) h FROM "${table}" t`,
    );
    for (const r of rows) out.set(`${table}:${r.id}`, r.h);
  }
  return out;
}

describe('dealer wallet smoke (test copy)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let call: (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: object,
  ) => request.Test;
  let before: Map<string, string>;

  beforeAll(async () => {
    assertTestCopy();
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applyGlobalPipesAndFilters(app);
    await app.init();
    prisma = app.get(PrismaService);
    const admin = await prisma.admin.findFirstOrThrow();
    const token = app
      .get(JwtService)
      .sign({ sub: admin.id, role: Role.ADMIN, email: admin.email });
    const server = app.getHttpServer();
    call = (method, path, body) => {
      const t = request(server)
        [method](path)
        .set('Authorization', `Bearer ${token}`);
      return body ? t.send(body) : t;
    };
    before = await rowHashes(prisma);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('overpays into the wallet, spends it on later invoices, and guards it', async () => {
    const ok = async (t: request.Test, label: string) => {
      const res = await t;
      console.log(`${label}: ${res.status}`);
      if (res.status >= 300) {
        throw new Error(`${label} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body;
    };
    const refused = async (t: request.Test, label: string) => {
      const res = await t;
      console.log(`${label}: ${res.status} ${res.body?.message}`);
      if (res.status < 400) throw new Error(`${label} should be refused`);
    };
    const today = new Date().toISOString().slice(0, 10);

    const dealer = await prisma.dealer.update({
      where: { id: (await createDealer(prisma, `SMOKE Wallet ${RUN}`)).id },
      data: { unlimitedCredit: true },
    });
    const makeProduct = (code: string, price: number) =>
      ok(
        call('post', '/products', {
          productCode: `SMOKE-W${code}-${RUN}`,
          name: `SMOKE Wallet item ${code} ${RUN}`,
          costPrice: price / 2,
          wholesalePrice: price,
          currentStock: 100,
        }),
        `product ${price}`,
      );
    const prices = new Map([
      [1220, await makeProduct('A', 1220)],
      [100, await makeProduct('B', 100)],
    ]);
    const sale = async (qty: number, price: number, walletCredit?: number) =>
      ok(
        call('post', '/orders', {
          dealerId: dealer.id,
          saleDate: today,
          items: [{ productId: prices.get(price).id, quantity: qty }],
          ...(walletCredit && { walletCredit }),
        }),
        `order ${qty}×${price}${walletCredit ? ` using ${walletCredit} wallet` : ''}`,
      );
    const invoiceOf = async (order: { id: string }) =>
      prisma.invoice.findFirstOrThrow({ where: { orderId: order.id } });
    const wallet = () =>
      ok(call('get', `/dealers/${dealer.id}/wallet`), 'wallet');
    const outstanding = async () =>
      (
        await prisma.dealer.findUniqueOrThrow({ where: { id: dealer.id } })
      ).outstandingBalance.toNumber();

    // A: bill 1220, customer hands over 1400 cash.
    const orderA = await sale(1, 1220);
    const invA = await invoiceOf(orderA);
    expect(invA.grandTotal.toNumber()).toBe(1220);
    const pay = (invoiceId: string, amount: number, extra: object = {}) =>
      call('post', '/payments', {
        invoiceId,
        amount,
        mode: 'CASH',
        paymentDate: today,
        ...extra,
      });
    await refused(pay(invA.id, 1400), 'overpay without wallet flag');
    const payA = await ok(
      pay(invA.id, 1400, { excessToWallet: true }),
      'pay 1400 on 1220',
    );
    expect((await invoiceOf(orderA)).paymentStatus).toBe('PAID');
    let w = await wallet();
    expect(w).toMatchObject({ balance: 180, available: 180, pending: 0 });
    expect(await outstanding()).toBe(-180);

    // C: next purchase 300, using 100 of the wallet at order time.
    const orderC = await sale(3, 100, 100);
    const invC = await invoiceOf(orderC);
    expect(invC.paymentStatus).toBe('PARTIAL');
    w = await wallet();
    expect(w).toMatchObject({ balance: 80, available: 80, used: 100 });

    // B: 500 paid with a 600 cheque — its 100 excess waits for clearing.
    const orderB = await sale(5, 100);
    const invB = await invoiceOf(orderB);
    const cheque = await ok(
      pay(invB.id, 600, {
        mode: 'CHEQUE',
        bankName: 'SMOKE Bank',
        chequeNumber: `SMK${RUN}`,
        chequeDate: today,
        collectedDate: today,
        excessToWallet: true,
      }),
      'cheque 600 on 500',
    );
    w = await wallet();
    expect(w).toMatchObject({ balance: 180, available: 80, pending: 100 });

    await refused(
      call('post', `/invoices/${invC.id}/wallet-credit`, { amount: 150 }),
      'use 150 with 80 available',
    );
    await ok(
      call('post', `/invoices/${invC.id}/wallet-credit`, { amount: 80 }),
      'use 80 on C',
    );
    await refused(
      call('delete', `/payments/${payA.id}`),
      'delete the overpayment that funded C',
    );
    const refundable = await ok(
      call('get', `/refunds/available/dealer/${dealer.id}`),
      'refundable',
    );
    expect(refundable.availableCredit).toBe(0);
    await refused(
      call('post', '/payments', {
        invoiceId: invC.id,
        amount: 200,
        mode: 'CASH',
        paymentDate: today,
      }),
      'pay 200 when 120 is due (credit counted)',
    );

    // Cheque clears → its 100 becomes spendable.
    await ok(
      call('patch', `/payments/${cheque.id}/cheque-status`, {
        status: 'CLEARED',
      }),
      'clear cheque',
    );
    w = await wallet();
    expect(w).toMatchObject({ balance: 100, available: 100, pending: 0 });
    const use = await ok(
      call('post', `/invoices/${invC.id}/wallet-credit`, { amount: 100 }),
      'use 100 on C',
    );
    await ok(call('delete', `/wallet-credit/${use.id}`), 'remove that use');
    expect((await wallet()).available).toBe(100);
    await ok(
      call('post', `/invoices/${invC.id}/wallet-credit`, { amount: 100 }),
      'use 100 on C again',
    );
    const invCNow = await prisma.invoice.findUniqueOrThrow({
      where: { id: invC.id },
    });
    expect(invCNow.paymentStatus).toBe('PARTIAL'); // 300 − 280 = 20 due

    await refused(
      call('delete', `/orders/${orderC.id}`),
      'delete an order paid with wallet credit',
    );

    // The bank reverses the cheque: recorded anyway, wallet shows overdrawn.
    await ok(
      call('patch', `/payments/${cheque.id}/cheque-status`, {
        status: 'RETURNED',
      }),
      'bounce cheque',
    );
    w = await wallet();
    expect(w.balance).toBe(-100);
    // Dealer owes: B 500 + C 20 + 100 overdrawn wallet = 620.
    expect(await outstanding()).toBe(620);

    // Credit uses never become payments (Liquid Cash only sees real money).
    expect(await prisma.payment.count({ where: { dealerId: dealer.id } })).toBe(
      2,
    );

    const invoiceView = await ok(
      call('get', `/invoices/${invC.id}`),
      'invoice detail',
    );
    expect(invoiceView.creditUses).toHaveLength(3); // 100 at order time, 80, 100

    // Credit Balance history: wallet rows included, and the ledger still ends
    // at the summary's total (the overdrawn wallet is closed by an adjustment).
    const summary = await ok(call('get', '/credit-balance/summary'), 'summary');
    const ledger = await ok(
      call('get', '/credit-balance/history?limit=1'),
      'credit history',
    );
    expect(Number(ledger.data[0].balanceAfter)).toBeCloseTo(
      summary.totalOwed,
      2,
    );
    const walletRows = await ok(
      call(
        'get',
        `/credit-balance/history?limit=50&search=${encodeURIComponent(dealer.businessName)}`,
      ),
      'wallet rows',
    );
    const types = walletRows.data.map((r: { type: string }) => r.type).sort();
    expect(types).toEqual([
      'WALLET_ADJUSTMENT',
      'WALLET_CREDIT',
      'WALLET_USED',
      'WALLET_USED',
      'WALLET_USED',
    ]); // 100 at order time, 80, 100 (the removed use is gone)

    const after = await rowHashes(prisma);
    expect([...before].filter(([k, h]) => after.get(k) !== h)).toEqual([]);
    console.log(`wallet smoke ${RUN}: OK, 0 pre-existing rows changed`);
  });
});
