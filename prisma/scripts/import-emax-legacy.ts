/**
 * One-off historical backfill: imports the old "Emax (2).xlsx" manual accounting
 * workbook (supplier, products, purchases, sales/orders, dealer payments, supplier
 * payments) into the live schema.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/import-emax-legacy.ts            (dry run, no writes)
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/import-emax-legacy.ts --commit    (writes for real)
 */
import { PrismaClient, InventoryLogType, PaymentMode, PaymentStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import { generateTempPassword } from '../../src/common/utils/generate-password';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const PASSWORD_SALT_ROUNDS = 10;
const TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 20000 };
const ADMIN_EMAIL = 'electromarttrade@gmail.com';

type RawData = {
  purchases: [string, string | null, string, number, number, number][];
  sales: [string, string, string | null, string, number, number, number][];
  collections: [number, string, string, number, string | null, string | null][];
  supplierPayments: [string, string | null, number | null, number, string | null][];
};

const raw: RawData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'emax-legacy-data.json'), 'utf-8'),
);

const DEALER_CANON: Record<string, string> = {
  'jrt enterprise': 'JRT Enterprise',
  hra: 'HRA',
  ithris: 'Ithris Store',
  'ithris store': 'Ithris Store',
  'masloon mahal': 'Masloon Mahal',
  'top electrical': 'Top Electrical',
  'ss multy': 'SS Multy',
  'vihara flowers': 'Vihara Flowers',
  kaies: 'Kaies Stores',
  'kaies stores': 'Kaies Stores',
  'aheel mall': 'Aheel Mall',
  'pedo center': 'Pedo Center',
  'thivarathy phone shop': 'Thivarathy Phone Shop',
  nafeer: 'Nafeer',
  'rafeek palace': 'Rafeek Palace',
  'thanu traders': 'Thanu Traders',
  'avk multi shop': 'AVK Multi Shop',
  'avk multi': 'AVK Multi Shop',
};
function canonDealer(name: string): string {
  return DEALER_CANON[name.trim().toLowerCase()] ?? name.trim();
}
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PRODUCTS: Record<string, { name: string; costPrice: number; price: number }> = {
  '32LED': { name: '32" LED TV', costPrice: 27500, price: 32900 },
  '50LED': { name: '50" LED TV', costPrice: 108000, price: 129000 },
  '32SMART': { name: '32" QLED TV', costPrice: 33500, price: 39750 },
  '40SMART': { name: '40" QLED TV', costPrice: 65000, price: 75950 },
};

// ---------------------------------------------------------------------------
// Sequence numbers — mirrors src/common/utils/sequence.ts but lets us stamp
// the *historical* year on the number, and works outside a NestJS tx wrapper.
// ---------------------------------------------------------------------------
async function nextSeq(
  tx: Prisma.TransactionClient,
  key: string,
  prefix: string,
  historicalYear: number,
): Promise<string> {
  const counter = await tx.counter.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });
  const serial = String(counter.value).padStart(5, '0');
  return `${prefix}-${historicalYear}-${serial}`;
}

// ---------------------------------------------------------------------------
// Build purchase events (real purchases vs RTN adjustments)
// ---------------------------------------------------------------------------
type PurchaseEvent = {
  kind: 'PURCHASE';
  date: string;
  invRef: string;
  code: string;
  qty: number;
  unitCost: number;
  total: number;
};
type AdjustmentEvent = {
  kind: 'ADJUSTMENT';
  date: string;
  code: string;
  quantityOut: number;
  quantityIn: number;
  reference: string;
};

let autoInvoiceSeq = 0;
const purchaseEvents: PurchaseEvent[] = [];
const adjustmentEvents: AdjustmentEvent[] = [];
for (const [date, invRefRaw, code, qty, unitCost, total] of raw.purchases) {
  const isReturn = String(invRefRaw ?? '').toUpperCase().startsWith('RTN') || qty < 0;
  if (isReturn) {
    adjustmentEvents.push({
      kind: 'ADJUSTMENT',
      date,
      code,
      quantityOut: Math.abs(qty),
      quantityIn: 0,
      reference: invRefRaw ?? `RETURN-${date}`,
    });
  } else {
    autoInvoiceSeq += 1;
    const invRef = invRefRaw ?? `LEGACY-${date}-${autoInvoiceSeq}`;
    purchaseEvents.push({ kind: 'PURCHASE', date, invRef, code, qty, unitCost, total });
  }
}

// ---------------------------------------------------------------------------
// Build order groups from Sales Account rows
// ---------------------------------------------------------------------------
type SaleRow = {
  date: string;
  code: string;
  invRef: string | null;
  customer: string;
  qty: number;
  price: number;
  total: number;
};
const saleRows: SaleRow[] = raw.sales.map(([date, code, invRef, customerRaw, qty, price, total]) => ({
  date,
  code,
  invRef: invRef ? invRef.trim() : null,
  customer: canonDealer(customerRaw),
  qty,
  price,
  total,
}));

// The one documented exception: a standalone return (no invoice ref, negative
// qty) three months after the original sale — not foldable into any single
// invoice. Modeled as a pure stock adjustment, not an order.
const standaloneReturns = saleRows.filter((r) => r.invRef === null && r.qty < 0);
for (const r of standaloneReturns) {
  adjustmentEvents.push({
    kind: 'ADJUSTMENT',
    date: r.date,
    code: r.code,
    quantityIn: Math.abs(r.qty),
    quantityOut: 0,
    reference: `Return - ${r.customer} (no invoice ref, ${r.date})`,
  });
}
const orderableSaleRows = saleRows.filter((r) => !(r.invRef === null && r.qty < 0));

type OrderGroup = {
  key: string;
  date: string;
  customer: string;
  invRef: string | null;
  items: Map<string, { qty: number; price: number; sheetTotal: number }>;
};
const orderGroups: OrderGroup[] = [];
const groupIndex = new Map<string, OrderGroup>();
let standaloneCounter = 0;
for (const r of orderableSaleRows) {
  const key = r.invRef
    ? `${r.customer}|${r.invRef}|${r.date}`
    : `${r.customer}|__standalone__${(standaloneCounter += 1)}__${r.date}`;
  let group = groupIndex.get(key);
  if (!group) {
    group = { key, date: r.date, customer: r.customer, invRef: r.invRef, items: new Map() };
    groupIndex.set(key, group);
    orderGroups.push(group);
  }
  const existing = group.items.get(r.code);
  if (existing) {
    existing.qty += r.qty;
    existing.sheetTotal += r.total;
    existing.price = r.price;
  } else {
    group.items.set(r.code, { qty: r.qty, price: r.price, sheetTotal: r.total });
  }
}
orderGroups.sort((a, b) => a.date.localeCompare(b.date));

function orderTotals(g: OrderGroup) {
  const items = [...g.items.values()];
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const totalAmount = items.reduce((s, i) => s + i.sheetTotal, 0);
  const discount = Math.max(0, subtotal - totalAmount);
  return { subtotal, totalAmount, discount };
}

// ---------------------------------------------------------------------------
// Payment matching — resolved against a "virtual ledger" so it can be
// validated in dry-run mode too, before anything is written to the DB.
// ---------------------------------------------------------------------------
type LedgerEntry = { key: string; grandTotal: number; dealerName: string; date: string; paidSoFar: number };

function buildVirtualLedger(): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  for (const g of orderGroups) {
    const { totalAmount } = orderTotals(g);
    ledger.set(g.key, { key: g.key, grandTotal: totalAmount, dealerName: g.customer, date: g.date, paidSoFar: 0 });
  }
  return ledger;
}

// Order group keys are `${customer}|${invRef}|${date}` (or a __standalone__
// variant). This finds all keys for a dealer whose invRef segment matches.
function keysByInvRef(invoicesByDealer: Map<string, string[]>, customer: string, invRef: string): string[] {
  return (invoicesByDealer.get(customer) ?? []).filter((k) => {
    const parts = k.split('|');
    return parts.length === 3 && parts[1] === invRef;
  });
}

function resolveRefKeys(
  invoicesByDealer: Map<string, string[]>,
  customer: string,
  refRaw: string,
): string[] {
  const ref = refRaw.trim();
  if (ref.includes('&')) {
    const base = ref.split('#')[1]?.split('/')[0];
    const nums = ref
      .replace(/^#?[A-Za-z]+\//, '')
      .split('&')
      .map((s) => s.trim());
    return nums.flatMap((n) => keysByInvRef(invoicesByDealer, customer, `#${base}/${n}`));
  }
  const suffixMatch = ref.match(/^(.*)\.(\d+)$/);
  if (suffixMatch) {
    const [, baseRef, idxStr] = suffixMatch;
    const idx = parseInt(idxStr, 10) - 1;
    // multiple orders can share the same base ref; gather all sharing it in date order
    // (invoicesByDealer lists are already sorted chronologically per dealer)
    const sameRef = keysByInvRef(invoicesByDealer, customer, baseRef);
    return sameRef[idx] ? [sameRef[idx]] : [];
  }
  return keysByInvRef(invoicesByDealer, customer, ref);
}

type PaymentAssignment = { sno: number; date: string; customer: string; key: string; amount: number };

function simulatePayments(ledger: Map<string, LedgerEntry>): {
  assignments: PaymentAssignment[];
  warnings: string[];
} {
  const invoicesByDealer = new Map<string, string[]>();
  for (const inv of ledger.values()) {
    const list = invoicesByDealer.get(inv.dealerName) ?? [];
    list.push(inv.key);
    invoicesByDealer.set(inv.dealerName, list);
  }
  for (const list of invoicesByDealer.values()) {
    list.sort((a, b) => ledger.get(a)!.date.localeCompare(ledger.get(b)!.date));
  }

  const sortedCollections = [...raw.collections].sort((a, b) => {
    const da = a[1] ?? '';
    const db = b[1] ?? '';
    if (da !== db) return da.localeCompare(db);
    return a[0] - b[0];
  });

  const assignments: PaymentAssignment[] = [];
  const warnings: string[] = [];

  for (const [sno, date, customerRaw, amount, refRaw, _status] of sortedCollections) {
    const customer = canonDealer(customerRaw);
    let targetKeys: string[];
    let amounts: number[];

    if (refRaw) {
      targetKeys = resolveRefKeys(invoicesByDealer, customer, refRaw);
      if (targetKeys.length > 1) {
        // Either a compound ref ("A & B") or the same ref was reused for more
        // than one order for this dealer — greedily settle the oldest/first
        // still-owing match(es) first (targetKeys/invoicesByDealer are date-sorted).
        amounts = [];
        let remaining = amount;
        for (const k of targetKeys) {
          const inv = ledger.get(k);
          const owed = inv ? inv.grandTotal - inv.paidSoFar : 0;
          const take = Math.min(remaining, owed);
          amounts.push(take);
          remaining -= take;
        }
      } else {
        amounts = [amount];
      }
    } else {
      const list = invoicesByDealer.get(customer) ?? [];
      const openKey = list.find((k) => {
        const inv = ledger.get(k)!;
        return inv.paidSoFar < inv.grandTotal;
      });
      targetKeys = openKey ? [openKey] : [];
      amounts = [amount];
    }

    if (targetKeys.length === 0) {
      warnings.push(`sno=${sno} ${customer} ref=${refRaw ?? '(none)'} amount=${amount} -> NO MATCHING INVOICE`);
      continue;
    }

    const assignedTotal = amounts.reduce((s, a) => s + a, 0);
    if (Math.round(assignedTotal) !== Math.round(amount)) {
      warnings.push(
        `sno=${sno} ${customer} ref=${refRaw ?? '(none)'} amount=${amount} -> only ${assignedTotal.toFixed(2)} could be allocated across matched invoice(s)`,
      );
    }

    for (let i = 0; i < targetKeys.length; i++) {
      const key = targetKeys[i];
      const inv = ledger.get(key);
      const payAmount = amounts[i] ?? 0;
      if (!inv) {
        warnings.push(`sno=${sno} ${customer} ref=${refRaw ?? '(none)'} amount=${amount} -> UNRESOLVED (key=${key})`);
        continue;
      }
      // Zero here just means this matched invoice didn't need any of the
      // remaining payment (already covered by an earlier key in the greedy
      // allocation above) — not an error; the assignedTotal check catches
      // genuine shortfalls.
      if (payAmount <= 0) continue;
      inv.paidSoFar += payAmount;
      assignments.push({ sno, date, customer, key, amount: payAmount });
    }
  }

  return { assignments, warnings };
}

// ---------------------------------------------------------------------------
// Dry-run summary (always runs; this is the preflight validation)
// ---------------------------------------------------------------------------
const previewLedger = buildVirtualLedger();
const { assignments: paymentAssignments, warnings: paymentWarnings } = simulatePayments(previewLedger);

console.log(`Mode: ${COMMIT ? 'COMMIT (writing to DB)' : 'DRY RUN (no writes)'}`);
console.log(`Dealers: ${new Set(orderGroups.map((g) => g.customer)).size}`);
console.log(`Products: ${Object.keys(PRODUCTS).length}`);
console.log(`Real purchases: ${purchaseEvents.length}`);
console.log(`Purchase/sale adjustments (returns): ${adjustmentEvents.length}`);
console.log(`Orders: ${orderGroups.length}`);
console.log(`Dealer payment rows: ${raw.collections.length} -> ${paymentAssignments.length} assigned`);
console.log(`Supplier payment rows: ${raw.supplierPayments.length}`);
const orderTotal = orderGroups.reduce((sum, g) => sum + orderTotals(g).totalAmount, 0);
console.log(`Sum of order net totals: ${orderTotal.toFixed(2)}`);
console.log(`Sum of dealer payments (sheet): ${raw.collections.reduce((s, c) => s + c[3], 0)}`);
console.log(`Sum of dealer payments (assigned): ${paymentAssignments.reduce((s, a) => s + a.amount, 0).toFixed(2)}`);
console.log(`Sum of supplier payments: ${raw.supplierPayments.reduce((s, p) => s + p[3], 0)}`);

if (paymentWarnings.length) {
  console.log(`\n${paymentWarnings.length} payment(s) could not be resolved to an invoice:`);
  for (const w of paymentWarnings) console.log(`  ! ${w}`);
} else {
  console.log('\nAll dealer payments resolved cleanly to an invoice.');
}

if (!COMMIT) {
  console.log('\nDry run only. Re-run with --commit to write to the database.');
  void prisma.$disconnect();
  process.exit(0);
}

if (paymentWarnings.length) {
  console.error('\nRefusing to commit: unresolved payments found (see warnings above). Fix the mapping first.');
  void prisma.$disconnect();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commit phase
// ---------------------------------------------------------------------------
async function main() {
  const admin = await prisma.admin.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });

  const supplier = await prisma.supplier.create({ data: { name: 'E-MAX' } });

  const productByCode = new Map<string, { id: string }>();
  for (const [code, def] of Object.entries(PRODUCTS)) {
    const product = await prisma.product.create({
      data: {
        productCode: code,
        name: def.name,
        category: 'Television',
        costPrice: def.costPrice,
        wholesalePrice: def.price,
        currentStock: 0,
      },
    });
    productByCode.set(code, { id: product.id });
  }

  const dealerCredentials: { dealer: string; username: string; password: string }[] = [];
  const dealerByName = new Map<string, { id: string; outstandingBalance: Prisma.Decimal }>();
  for (const name of new Set(orderGroups.map((g) => g.customer))) {
    const username = slugify(name);
    const tempPassword = generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, PASSWORD_SALT_ROUNDS);
    const dealer = await prisma.dealer.create({
      data: {
        businessName: name,
        ownerName: name,
        phone: '0000000000',
        username,
        password: hashed,
        creditLimit: 300000,
        outstandingBalance: 0,
      },
    });
    dealerByName.set(name, { id: dealer.id, outstandingBalance: dealer.outstandingBalance });
    dealerCredentials.push({ dealer: name, username, password: tempPassword });
  }

  // ---- Phase A: chronological stock ledger (purchases, adjustments, orders) ----
  type StockEvent =
    | { kind: 'PURCHASE'; date: string; data: PurchaseEvent }
    | { kind: 'ADJUSTMENT'; date: string; data: AdjustmentEvent }
    | { kind: 'ORDER'; date: string; data: OrderGroup };
  const stockEvents: StockEvent[] = [
    ...purchaseEvents.map((p) => ({ kind: 'PURCHASE' as const, date: p.date, data: p })),
    ...adjustmentEvents.map((a) => ({ kind: 'ADJUSTMENT' as const, date: a.date, data: a })),
    ...orderGroups.map((o) => ({ kind: 'ORDER' as const, date: o.date, data: o })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  // maps an order group's key -> the real invoice id created for it
  const invoiceIdByKey = new Map<string, string>();

  for (const ev of stockEvents) {
    const year = new Date(ev.date).getFullYear();

    if (ev.kind === 'PURCHASE') {
      const p = ev.data;
      const product = productByCode.get(p.code);
      if (!product) throw new Error(`Unknown product code ${p.code}`);
      await prisma.$transaction(async (tx) => {
        const purchase = await tx.purchase.create({
          data: {
            supplierId: supplier.id,
            invoiceNumber: p.invRef,
            purchaseDate: new Date(p.date),
            totalValue: p.total,
            adminId: admin.id,
            items: {
              create: [{ productId: product.id, quantity: p.qty, unitCost: p.unitCost, lineTotal: p.total }],
            },
          },
        });
        const updated = await tx.product.update({
          where: { id: product.id },
          data: { currentStock: { increment: p.qty } },
        });
        await tx.inventoryLog.create({
          data: {
            productId: product.id,
            type: InventoryLogType.PURCHASE,
            quantityIn: p.qty,
            quantityOut: 0,
            balanceAfter: updated.currentStock,
            reference: purchase.id,
          },
        });
      }, TRANSACTION_OPTIONS);
      continue;
    }

    if (ev.kind === 'ADJUSTMENT') {
      const a = ev.data;
      const product = productByCode.get(a.code);
      if (!product) throw new Error(`Unknown product code ${a.code}`);
      await prisma.$transaction(async (tx) => {
        const netDelta = a.quantityIn - a.quantityOut;
        const updated = await tx.product.update({
          where: { id: product.id },
          data: { currentStock: { increment: netDelta } },
        });
        await tx.inventoryLog.create({
          data: {
            productId: product.id,
            type: InventoryLogType.ADJUSTMENT,
            quantityIn: a.quantityIn,
            quantityOut: a.quantityOut,
            balanceAfter: updated.currentStock,
            reference: a.reference,
          },
        });
      }, TRANSACTION_OPTIONS);
      continue;
    }

    // ORDER
    const g = ev.data;
    const dealer = dealerByName.get(g.customer);
    if (!dealer) throw new Error(`Unknown dealer ${g.customer}`);

    const items = [...g.items.entries()].map(([code, item]) => {
      const product = productByCode.get(code);
      if (!product) throw new Error(`Unknown product code ${code}`);
      return { productId: product.id, quantity: item.qty, unitPrice: item.price, sheetTotal: item.sheetTotal };
    });
    const { subtotal, totalAmount, discount } = orderTotals(g);

    const result = await prisma.$transaction(async (tx) => {
      const orderNumber = await nextSeq(tx, 'order', 'ORD', year);
      const order = await tx.order.create({
        data: {
          orderNumber,
          dealerId: dealer.id,
          status: 'COMPLETED',
          subtotal,
          discount,
          totalAmount,
          approvedByAdminId: admin.id,
          approvedAt: new Date(g.date),
          packedAt: new Date(g.date),
          deliveredAt: new Date(g.date),
          completedAt: new Date(g.date),
          createdAt: new Date(g.date),
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              lineTotal: i.quantity * i.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      for (const item of order.items) {
        const updated = await tx.product.update({
          where: { id: item.productId },
          data: { currentStock: { decrement: item.quantity } },
        });
        await tx.inventoryLog.create({
          data: {
            productId: item.productId,
            type: InventoryLogType.RESERVE,
            quantityIn: 0,
            quantityOut: item.quantity,
            balanceAfter: updated.currentStock,
            reference: order.id,
          },
        });
      }

      const invoiceNumber = await nextSeq(tx, 'invoice', 'INV', year);
      const dueDate = new Date(g.date);
      dueDate.setDate(dueDate.getDate() + 15);
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: order.id,
          dealerId: dealer.id,
          subtotal,
          discountTotal: discount,
          grandTotal: totalAmount,
          dueDate,
          createdAt: new Date(g.date),
        },
      });

      await tx.dealer.update({
        where: { id: dealer.id },
        data: { outstandingBalance: { increment: totalAmount } },
      });

      return { invoiceId: invoice.id };
    }, TRANSACTION_OPTIONS);

    invoiceIdByKey.set(g.key, result.invoiceId);
    const dealerRow = dealerByName.get(g.customer)!;
    dealerRow.outstandingBalance = dealerRow.outstandingBalance.add(totalAmount);
  }

  // ---- Phase B: dealer payments — reuse the exact assignments already
  // validated in the preflight simulation above ----
  for (const a of paymentAssignments) {
    const invoiceId = invoiceIdByKey.get(a.key);
    const dealerRow = dealerByName.get(a.customer);
    if (!invoiceId || !dealerRow) throw new Error(`Missing invoice/dealer for assignment ${JSON.stringify(a)}`);

    await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          invoiceId,
          dealerId: dealerRow.id,
          amount: a.amount,
          mode: PaymentMode.CASH,
          paymentDate: new Date(a.date),
        },
      });

      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true } });
      const totalPaid = invoice.payments.reduce((s, p) => s.add(p.amount), new Prisma.Decimal(0));
      const paymentStatus = totalPaid.greaterThanOrEqualTo(invoice.grandTotal)
        ? PaymentStatus.PAID
        : totalPaid.greaterThan(0)
          ? PaymentStatus.PARTIAL
          : PaymentStatus.PENDING;
      await tx.invoice.update({ where: { id: invoiceId }, data: { paymentStatus } });

      const newOutstanding = Prisma.Decimal.max(0, dealerRow.outstandingBalance.sub(a.amount));
      dealerRow.outstandingBalance = newOutstanding;
      await tx.dealer.update({ where: { id: dealerRow.id }, data: { outstandingBalance: newOutstanding } });
    }, TRANSACTION_OPTIONS);
  }

  // ---- Phase C: supplier payments ----
  for (const [date, mode, ref, amount, remarks] of raw.supplierPayments) {
    const isCheque = (mode ?? '').toLowerCase().includes('cheque');
    await prisma.supplierPayment.create({
      data: {
        supplierId: supplier.id,
        amount,
        mode: isCheque ? PaymentMode.CHEQUE : PaymentMode.CASH,
        reference: ref ? String(ref) : undefined,
        paymentDate: new Date(date),
        remarks: remarks ?? undefined,
      },
    });
  }

  // ---- Final report ----
  console.log('\n=== Import complete ===');
  console.log('\nDealer credentials (share securely, dealers should reset on first login):');
  for (const c of dealerCredentials) {
    console.log(`  ${c.dealer.padEnd(24)} username=${c.username.padEnd(24)} password=${c.password}`);
  }

  console.log('\nFinal dealer outstanding balances:');
  for (const [name, d] of dealerByName) {
    console.log(`  ${name.padEnd(24)} ${d.outstandingBalance.toString()}`);
  }

  const finalStock = await prisma.product.findMany({ select: { productCode: true, currentStock: true } });
  console.log('\nFinal stock:', finalStock);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
