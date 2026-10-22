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
 * Serial-tracking smoke run (Bar_code_plan.md §10.1 step 5) against the
 * serial TEST COPY — never production, never truncated. It adds its own
 * marked supplier/dealer/product and then proves no pre-existing business row
 * changed. Run with: npm run test:serials-smoke (see scripts/assert-test-db.sh).
 */
const RUN = randomUUID().slice(0, 6).toUpperCase();
const S = (n: string) => `SMK${RUN}-${n}`;

const FINGERPRINT_TABLES = [
  'Product',
  'InventoryLog',
  'Invoice',
  'OrderItem',
  'Payment',
  'Dealer',
  'Purchase',
  'SupplierPayment',
  'SalesReturn',
  'PurchaseReturn',
  'Refund',
  'CashAdjustment',
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

describe('serial tracking smoke (test copy)', () => {
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

  it('runs the full unit life cycle without touching existing rows', async () => {
    const ok = async (t: request.Test, label: string) => {
      const started = Date.now();
      const res = await t;
      console.log(`${label}: ${res.status} in ${Date.now() - started}ms`);
      if (res.status >= 300) {
        throw new Error(`${label} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body;
    };
    const refused = async (t: request.Test, label: string) => {
      const res = await t;
      if (res.status < 400) throw new Error(`${label} should be refused`);
      return res.body?.message as string;
    };
    const unitBySerial = (serial: string) =>
      prisma.productUnit.findFirstOrThrow({
        where: { serialKey: serial.toUpperCase() },
      });
    const stock = async () =>
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .currentStock;

    // ── fixtures ───────────────────────────────────────────────────────
    const supplier = await ok(
      call('post', '/suppliers', { name: `SMOKE Supplier ${RUN}` }),
      'supplier',
    );
    const dealer = await prisma.dealer.update({
      where: { id: (await createDealer(prisma, `SMOKE Dealer ${RUN}`)).id },
      data: { unlimitedCredit: true },
    });
    const product = await ok(
      call('post', '/products', {
        productCode: `SMOKE-${RUN}`,
        name: `SMOKE Serial TV ${RUN}`,
        costPrice: 100,
        wholesalePrice: 150,
        trackSerials: true,
        warrantyMonths: 12,
      }),
      'product',
    );
    expect(product.trackSerials).toBe(true);

    // ── receive: 5 units, scan 3 now and 2 later ───────────────────────
    const purchase = await ok(
      call('post', '/purchases', {
        supplierId: supplier.id,
        invoiceNumber: `SMOKE-PI-${RUN}`,
        purchaseDate: new Date().toISOString(),
        items: [
          {
            productId: product.id,
            quantity: 5,
            unitCost: 100,
            serials: [S('A1'), S('A2'), S('A3')],
          },
        ],
      }),
      'purchase',
    );
    expect(await stock()).toBe(5);

    const dupVerdict = await ok(
      call('post', '/product-units/validate', {
        productId: product.id,
        context: 'RECEIVE',
        purchaseId: purchase.id,
        serials: [S('A1'), S('A4')],
      }),
      'validate',
    );
    expect(JSON.stringify(dupVerdict)).toContain(S('A1'));

    const laterKey = randomUUID();
    const later = {
      productId: product.id,
      purchaseId: purchase.id,
      serials: [S('A4'), S('A5')],
      idempotencyKey: laterKey,
    };
    const first = await ok(call('post', '/product-units', later), 'register');
    const replay = await ok(call('post', '/product-units', later), 'replay');
    expect(replay).toEqual(first);
    await refused(
      call('post', '/product-units', {
        ...later,
        serials: [S('A6')],
        idempotencyKey: randomUUID(),
      }),
      'over-registration (6 serials for 5 received)',
    );
    expect(
      await prisma.productUnit.count({ where: { productId: product.id } }),
    ).toBe(5);

    // ── sell 2: allocate, change mind, deliver ─────────────────────────
    const order = await ok(
      call('post', '/orders', {
        dealerId: dealer.id,
        items: [{ productId: product.id, quantity: 2 }],
      }),
      'order',
    );
    // Scanning at packing time (the order detail page's path). Serials can
    // also go on the admin create call; from this machine (~0.5s per query to
    // us-east-1) that create already runs close to the 20s transaction limit.
    await ok(
      call('put', `/orders/${order.id}/units`, {
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, serials: [S('A1'), S('A2')] }],
      }),
      'assign',
    );
    expect((await unitBySerial(S('A1'))).status).toBe('ALLOCATED');
    await ok(
      call('put', `/orders/${order.id}/units`, {
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, serials: [S('A1'), S('A3')] }],
      }),
      'reassign',
    );
    expect((await unitBySerial(S('A2'))).status).toBe('IN_STOCK');
    expect((await unitBySerial(S('A3'))).status).toBe('ALLOCATED');

    await ok(
      call('patch', `/orders/${order.id}/status`, { status: 'PACKED' }),
      'packed',
    );
    await ok(
      call('patch', `/orders/${order.id}/status`, { status: 'DELIVERED' }),
      'delivered',
    );
    const soldA1 = await unitBySerial(S('A1'));
    expect(soldA1.status).toBe('SOLD');
    expect(soldA1.warrantyExpiresAt).not.toBeNull();
    expect(await stock()).toBe(3);

    const orderDetail = await ok(call('get', `/orders/${order.id}`), 'order');
    const invoice = await ok(
      call('get', `/invoices/${orderDetail.invoice.id}`),
      'invoice',
    );
    expect(JSON.stringify(invoice.serialAnnex)).toContain(S('A3'));

    await ok(
      call('patch', `/orders/${order.id}/status`, { status: 'COMPLETED' }),
      'completed',
    );
    expect((await unitBySerial(S('A1'))).status).toBe('SOLD');

    // ── customer returns A1 as defective ───────────────────────────────
    const salesReturn = await ok(
      call('post', '/sales-returns', {
        orderId: order.id,
        reason: 'Smoke: no display',
        returnDate: new Date().toISOString(),
        items: [
          {
            productId: product.id,
            quantity: 1,
            serials: [
              {
                serial: S('A1'),
                condition: 'DEFECTIVE',
                faultNote: 'no display',
              },
            ],
          },
        ],
      }),
      'sales return',
    );
    const returnedA1 = await unitBySerial(S('A1'));
    expect(returnedA1.status).toBe('IN_STOCK');
    expect(returnedA1.condition).toBe('DEFECTIVE');
    expect(await stock()).toBe(4);

    // a defective unit cannot be put on an order
    const order2 = await ok(
      call('post', '/orders', {
        dealerId: dealer.id,
        items: [{ productId: product.id, quantity: 1 }],
      }),
      'order 2',
    );
    await refused(
      call('put', `/orders/${order2.id}/units`, {
        idempotencyKey: randomUUID(),
        lines: [{ productId: product.id, serials: [S('A1')] }],
      }),
      'allocate defective',
    );

    // ── send A1 back to the supplier, supplier sends R1 ────────────────
    const purchaseReturn = await ok(
      call('post', '/purchase-returns', {
        purchaseId: purchase.id,
        reason: 'Smoke: faulty panel',
        returnDate: new Date().toISOString(),
        items: [{ productId: product.id, quantity: 1, serials: [S('A1')] }],
      }),
      'purchase return',
    );
    expect((await unitBySerial(S('A1'))).status).toBe('RETURNED_TO_SUPPLIER');

    // reversing the customer return now is refused (A1 has moved on)
    await refused(
      call('delete', `/sales-returns/${salesReturn.id}`),
      'reverse sales return after supplier return',
    );

    // the replacement's stock is recorded first; the serial only labels it
    await refused(
      call('post', `/product-units/${returnedA1.id}/supplier-replacement`, {
        serial: S('R1'),
        receivedAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      }),
      'replacement serial with no stock recorded',
    );
    await ok(
      call('post', '/inventory/adjustment', {
        productId: product.id,
        direction: 'IN',
        quantity: 1,
        reason: 'Smoke: supplier replacement received',
      }),
      'replacement stock in',
    );
    const replacement = await ok(
      call('post', `/product-units/${returnedA1.id}/supplier-replacement`, {
        serial: S('R1'),
        receivedAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
      }),
      'supplier replacement',
    );
    const r1 = await prisma.productUnit.findUniqueOrThrow({
      where: { id: replacement.newUnitId },
    });
    expect(r1.serialNumber).toBe(S('R1'));
    expect(r1.source).toBe('REPLACEMENT');
    expect(r1.replacesUnitId).toBe(returnedA1.id);
    await refused(
      call('delete', `/purchase-returns/${purchaseReturn.id}`),
      'reverse supplier return after replacement',
    );

    // ── warranty swap: buyer's A3 is faulty, give them A2 ─────────────
    const soldA3 = await unitBySerial(S('A3'));
    await ok(
      call('post', `/product-units/${soldA3.id}/warranty-swap`, {
        replacementSerial: S('A2'),
        reason: 'Smoke: dead pixel',
        idempotencyKey: randomUUID(),
      }),
      'warranty swap',
    );
    expect((await unitBySerial(S('A2'))).status).toBe('SOLD');

    // ── write one off through a stock adjustment ───────────────────────
    const stockBeforeWriteOff = await stock();
    await ok(
      call('post', '/inventory/adjustment', {
        productId: product.id,
        direction: 'OUT',
        quantity: 1,
        reason: 'Smoke: damaged in store',
        serials: [S('A5')],
      }),
      'write-off',
    );
    expect((await unitBySerial(S('A5'))).status).toBe('WRITTEN_OFF');
    expect(await stock()).toBe(stockBeforeWriteOff - 1);

    // ── scan + detail page ────────────────────────────────────────────
    const scan = await ok(
      call('get', `/product-units/scan/${encodeURIComponent(S('A1'))}`),
      'scan',
    );
    expect(scan.kind).toBe('UNIT');
    const detail = await ok(
      call('get', `/product-units/${returnedA1.id}`),
      'unit detail',
    );
    expect(detail.customerReturns.length).toBe(1);
    expect(detail.supplierReturns.length).toBe(1);
    expect(detail.timeline.length).toBeGreaterThanOrEqual(5);

    // ── invariants ────────────────────────────────────────────────────
    const coverage = await ok(
      call('get', `/product-units/coverage?productId=${product.id}`),
      'coverage',
    );
    console.log('coverage', JSON.stringify(coverage));
    const [shelf] = await prisma.$queryRawUnsafe<
      { on_shelf: number; tagged: number }[]
    >(
      `SELECT
         (SELECT p."currentStock" FROM "Product" p WHERE p.id = $1)
         + COALESCE((SELECT SUM(oi.quantity) FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
                     WHERE oi."productId" = $1 AND o.status IN ('APPROVED','PACKED')), 0) AS on_shelf,
         (SELECT COUNT(*) FROM "ProductUnit" u WHERE u."productId" = $1
            AND u.status IN ('IN_STOCK','ALLOCATED'))::int AS tagged`,
      product.id,
    );
    expect(Number(shelf.tagged)).toBeLessThanOrEqual(Number(shelf.on_shelf));

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ProductUnitEvent" SET reason = 'tamper' WHERE "unitId" = $1`,
        returnedA1.id,
      ),
    ).rejects.toThrow();

    // ── nothing that existed before was changed ───────────────────────
    const after = await rowHashes(prisma);
    const changed = [...before].filter(([k, h]) => after.get(k) !== h);
    expect(changed).toEqual([]);
    console.log(
      `smoke ${RUN}: ${after.size - before.size} new business rows, 0 pre-existing rows changed`,
    );
  });

  it('buys two new products with unit barcodes, then sells one by its barcode', async () => {
    const ok = async (t: request.Test, label: string) => {
      const started = Date.now();
      const res = await t;
      console.log(`${label}: ${res.status} in ${Date.now() - started}ms`);
      if (res.status >= 300) {
        throw new Error(`${label} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      return res.body;
    };
    const productRow = (id: string) =>
      prisma.product.findUniqueOrThrow({ where: { id } });

    const supplier = await ok(
      call('post', '/suppliers', { name: `SMOKE Supplier B ${RUN}` }),
      'supplier',
    );
    const dealer = await prisma.dealer.update({
      where: { id: (await createDealer(prisma, `SMOKE Dealer B ${RUN}`)).id },
      data: { unlimitedCredit: true },
    });
    // Created the plain way — tracking off, no barcode on the product itself.
    const tv32 = await ok(
      call('post', '/products', {
        productCode: `SMOKE-32-${RUN}`,
        name: `SMOKE Smart TV 32 ${RUN}`,
        costPrice: 100,
        wholesalePrice: 130,
      }),
      'product 32"',
    );
    const tv40 = await ok(
      call('post', '/products', {
        productCode: `SMOKE-40-${RUN}`,
        name: `SMOKE Smart TV 40 ${RUN}`,
        costPrice: 200,
        wholesalePrice: 260,
      }),
      'product 40"',
    );
    expect(tv32.trackSerials).toBe(false);

    const serials32 = Array.from({ length: 10 }, (_, i) => S(`T32-${i}`));
    const serials40 = Array.from({ length: 5 }, (_, i) => S(`T40-${i}`));
    await ok(
      call('post', '/purchases', {
        supplierId: supplier.id,
        invoiceNumber: `SMOKE-PI-B-${RUN}`,
        purchaseDate: new Date().toISOString(),
        items: [
          {
            productId: tv32.id,
            quantity: 10,
            unitCost: 100,
            serials: serials32,
          },
          {
            productId: tv40.id,
            quantity: 5,
            unitCost: 200,
            serials: serials40,
          },
        ],
      }),
      'purchase 10 + 5 with barcodes',
    );

    // Products and inventory reflect the purchase; registering turned tracking on.
    for (const [product, qty] of [
      [tv32, 10],
      [tv40, 5],
    ] as const) {
      const row = await productRow(product.id);
      expect(row.currentStock).toBe(qty);
      expect(row.trackSerials).toBe(true);
      expect(
        await prisma.productUnit.count({
          where: { productId: product.id, status: 'IN_STOCK' },
        }),
      ).toBe(qty);
    }
    const inventory = await ok(
      call(
        'get',
        `/inventory?search=${encodeURIComponent(`SMOKE Smart TV 32 ${RUN}`)}`,
      ),
      'inventory',
    );
    expect(JSON.stringify(inventory)).toContain(tv32.id);

    // The order screen resolves a scanned barcode to its unit and product …
    const scanned = await ok(
      call('get', `/product-units/scan/${encodeURIComponent(serials32[3])}`),
      'scan',
    );
    expect(scanned.kind).toBe('UNIT');
    expect(scanned.units[0].product.id).toBe(tv32.id);
    expect(scanned.units[0].status).toBe('IN_STOCK');

    // … and creates the order with that serial on the line.
    const order = await ok(
      call('post', '/orders', {
        dealerId: dealer.id,
        items: [{ productId: tv32.id, quantity: 1, serials: [serials32[3]] }],
      }),
      'order with scanned barcode',
    );
    const unit = await prisma.productUnit.findFirstOrThrow({
      where: { serialKey: serials32[3].toUpperCase() },
    });
    expect(unit.status).toBe('ALLOCATED');
    expect(unit.orderId).toBe(order.id);

    const after = await rowHashes(prisma);
    expect([...before].filter(([k, h]) => after.get(k) !== h)).toEqual([]);
    console.log(
      `smoke B ${RUN}: purchase → stock → scan → order OK, 0 pre-existing rows changed`,
    );
  });

  it('buys without barcodes, then registers them later from the products page', async () => {
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
    const supplier = await ok(
      call('post', '/suppliers', { name: `SMOKE Supplier C ${RUN}` }),
      'supplier',
    );
    const tv = await ok(
      call('post', '/products', {
        productCode: `SMOKE-50-${RUN}`,
        name: `SMOKE Smart TV 50 ${RUN}`,
        costPrice: 300,
        wholesalePrice: 390,
        trackSerials: true,
      }),
      'product 50" (tracked)',
    );
    const purchase = await ok(
      call('post', '/purchases', {
        supplierId: supplier.id,
        invoiceNumber: `SMOKE-PI-C-${RUN}`,
        purchaseDate: new Date().toISOString(),
        items: [{ productId: tv.id, quantity: 4, unitCost: 300 }],
      }),
      'purchase 4 without barcodes',
    );

    const missing = await ok(call('get', '/product-units/missing'), 'missing');
    expect(missing).toContainEqual({ productId: tv.id, missing: 4 });

    const pending = await ok(
      call('get', `/product-units/unlabelled/${tv.id}`),
      'unlabelled',
    );
    expect(pending.missing).toBe(4);
    expect(pending.purchases).toHaveLength(1);
    expect(pending.purchases[0]).toMatchObject({
      id: purchase.id,
      room: 4,
      supplierName: supplier.name,
    });

    // More than the room is refused and changes nothing.
    await refused(
      call('post', '/product-units', {
        productId: tv.id,
        purchaseId: purchase.id,
        serials: [S('T50-a'), S('T50-b'), S('T50-c'), S('T50-d'), S('T50-e')],
        idempotencyKey: randomUUID(),
      }),
      'register 5 into room for 4',
    );
    await ok(
      call('post', '/product-units', {
        productId: tv.id,
        purchaseId: purchase.id,
        serials: [S('T50-a'), S('T50-b'), S('T50-c')],
        idempotencyKey: randomUUID(),
      }),
      'register 3 later',
    );
    const after3 = await ok(
      call('get', `/product-units/unlabelled/${tv.id}`),
      'unlabelled after 3',
    );
    expect(after3.missing).toBe(1);
    expect(after3.purchases[0].room).toBe(1);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: tv.id } }))
        .currentStock,
    ).toBe(4);
    expect(
      await prisma.productUnit.count({
        where: { productId: tv.id, purchaseId: purchase.id },
      }),
    ).toBe(3);

    const after = await rowHashes(prisma);
    expect([...before].filter(([k, h]) => after.get(k) !== h)).toEqual([]);
    console.log(`smoke C ${RUN}: buy → missing badge → register later OK`);
  });
});
