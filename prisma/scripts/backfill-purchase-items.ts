/**
 * One-off backfill: every Purchase imported from the legacy EMAX bookkeeping
 * data (see import-emax-legacy.ts) is missing its PurchaseItem rows — the
 * live "Purchases" list/detail pages show a total value but an empty line
 * items table for all of them. Reconstructed here from the same source
 * spreadsheet data (prisma/scripts/data/emax-legacy-data.json), matched to
 * each existing Purchase by invoiceNumber. Ten of eleven reconcile exactly
 * against the purchase's stored totalValue; one ("078") is off by 7,500
 * against the raw sheet (15 units at 33,500 = 502,500, but the purchase's
 * totalValue is 510,000 = 15 x 34,000) — treated as a later price
 * correction that was applied to the purchase record but not back into the
 * sheet, so its unitCost here is back-derived from the authoritative stored
 * totalValue instead of trusting the sheet's price column.
 *
 * Only inserts PurchaseItem rows — never touches currentStock or
 * InventoryLog, since whatever those already reflect is the live
 * operational state and this is purely filling in a missing historical
 * detail record. Skips any purchase that already has items, so it's safe to
 * run more than once.
 *
 * Note: the sheet's per-row price for the 32" QLED TV ("32SMART") is
 * 33,500, but two purchases (078 and the untitled 2026-04-29 row backing
 * UN-0004) only reconcile against their stored totalValue at 34,000/unit —
 * consistently, a flat 500/unit higher in both. Both entries below use
 * 34,000 rather than the sheet's 33,500 for that reason.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-purchase-items.ts            (dry run, no writes)
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-purchase-items.ts --commit    (writes for real)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

const PRODUCT_CODE_BY_SHEET_CODE: Record<string, string> = {
  '32LED': 'EMX-TV-32-0001',
  '50LED': 'EMX-TV-50-0001',
  '32SMART': 'EMX-SMTV-32-0001',
  '40SMART': 'EMX-SMTV-40-0001',
};

const BACKFILL: Record<string, { code: string; quantity: number; unitCost: number }[]> = {
  '0048': [
    { code: '32LED', quantity: 15, unitCost: 27500 },
    { code: '50LED', quantity: 2, unitCost: 108000 },
  ],
  '0051': [{ code: '32LED', quantity: 10, unitCost: 27500 }],
  '0059': [{ code: '32LED', quantity: 10, unitCost: 27500 }],
  '0088': [{ code: '32LED', quantity: 9, unitCost: 27500 }],
  '0120': [{ code: '32LED', quantity: 14, unitCost: 27500 }],
  '0104': [{ code: '32LED', quantity: 15, unitCost: 27500 }],
  '0110': [{ code: '32LED', quantity: 13, unitCost: 27500 }],
  'UN-0001': [{ code: '32LED', quantity: 15, unitCost: 27500 }],
  'UN-0002': [{ code: '32LED', quantity: 1, unitCost: 27500 }],
  'UN-0004': [
    { code: '32SMART', quantity: 14, unitCost: 34000 },
    { code: '40SMART', quantity: 8, unitCost: 65000 },
  ],
  '078': [{ code: '32SMART', quantity: 15, unitCost: 34000 }],
};

async function main() {
  const productByCode = new Map<string, { id: string; name: string }>();
  for (const productCode of Object.values(PRODUCT_CODE_BY_SHEET_CODE)) {
    const product = await prisma.product.findUnique({ where: { productCode } });
    if (!product) throw new Error(`Product ${productCode} not found`);
    productByCode.set(productCode, { id: product.id, name: product.name });
  }

  const purchases = await prisma.purchase.findMany({
    include: { _count: { select: { items: true } } },
  });

  let backfilled = 0;
  for (const purchase of purchases) {
    const lines = BACKFILL[purchase.invoiceNumber];
    if (!lines) {
      console.log(`? No backfill mapping for purchase ${purchase.invoiceNumber} — skipping`);
      continue;
    }
    if (purchase._count.items > 0) {
      console.log(`- ${purchase.invoiceNumber} already has items — skipping`);
      continue;
    }

    const items = lines.map((line) => {
      const productCode = PRODUCT_CODE_BY_SHEET_CODE[line.code];
      const product = productByCode.get(productCode)!;
      const lineTotal = line.quantity * line.unitCost;
      return { productId: product.id, productName: product.name, quantity: line.quantity, unitCost: line.unitCost, lineTotal };
    });
    const computedTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const matchesStoredTotal = computedTotal === Number(purchase.totalValue);

    console.log(
      `${purchase.invoiceNumber}: computed ${computedTotal} vs stored ${purchase.totalValue.toString()} ${matchesStoredTotal ? 'OK' : '** MISMATCH **'}`,
    );
    for (const i of items) {
      console.log(`    ${i.productName} x${i.quantity} @ ${i.unitCost} = ${i.lineTotal}`);
    }

    if (COMMIT) {
      await prisma.purchaseItem.createMany({
        data: items.map((i) => ({
          purchaseId: purchase.id,
          productId: i.productId,
          quantity: i.quantity,
          unitCost: i.unitCost,
          lineTotal: i.lineTotal,
        })),
      });
    }
    backfilled++;
  }

  console.log(`\n${backfilled} purchase(s) backfilled.`);
  console.log(COMMIT ? 'Changes committed.' : 'Dry run only — pass --commit to apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
