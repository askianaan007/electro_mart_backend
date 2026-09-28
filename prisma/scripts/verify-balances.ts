/**
 * READ-ONLY before/after invariant check for the replacement-receipts
 * migration (return_feature_implementation.md §8). Runs every query inside a
 * Postgres READ ONLY transaction, so the database itself rejects any write.
 *
 * Captures row counts, every supplier's credit balance (computed with the
 * ORIGINAL formula, written out inline here — independent of app code), and
 * every product's stock, then compares two snapshots.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/verify-balances.ts snapshot before.json
 *   ...apply migration / deploy...
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/verify-balances.ts snapshot after.json
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/verify-balances.ts compare before.json after.json
 *
 * compare exits 1 on any difference. It is meant for snapshots taken around
 * the migration/deploy (no business activity in between): row counts,
 * supplier components, old-formula balances and product stock must all be
 * identical, and in the second snapshot every supplier's new-formula balance
 * must equal old formula + that supplier's replacement receipts.
 */
import { writeFileSync, readFileSync } from 'fs';
import { PrismaClient, Prisma } from '@prisma/client';
import { supplierBalance } from '../../src/common/utils/supplier-balance';

type Money = string; // fixed 2dp

interface Snapshot {
  takenAt: string;
  databaseHost: string;
  replacementTableExists: boolean;
  counts: Record<string, number>;
  suppliers: Record<
    string,
    {
      name: string;
      purchases: Money;
      transport: Money;
      returns: Money;
      settled: Money;
      replacements: Money;
      balanceOldFormula: Money;
      balanceNewFormula: Money | null;
    }
  >;
  products: Record<
    string,
    { currentStock: number; lastLedgerBalance: number | null }
  >;
  totals: { balanceOldFormula: Money; balanceNewFormula: Money | null };
}

const prisma = new PrismaClient();
const ZERO = new Prisma.Decimal(0);
const money = (d: Prisma.Decimal | null | undefined) => (d ?? ZERO).toFixed(2);

function databaseHost() {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host;
  } catch {
    return 'unknown';
  }
}

async function snapshot(): Promise<Snapshot> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;

      const [{ exists }] = await tx.$queryRaw<{ exists: boolean }[]>`
        SELECT to_regclass('public."PurchaseReturnReplacement"') IS NOT NULL AS exists
      `;

      const countRows = await tx.$queryRaw<{ t: string; n: bigint }[]>`
        SELECT 'Supplier' AS t, COUNT(*) AS n FROM "Supplier"
        UNION ALL SELECT 'Product', COUNT(*) FROM "Product"
        UNION ALL SELECT 'Purchase', COUNT(*) FROM "Purchase"
        UNION ALL SELECT 'PurchaseItem', COUNT(*) FROM "PurchaseItem"
        UNION ALL SELECT 'PurchaseReturn', COUNT(*) FROM "PurchaseReturn"
        UNION ALL SELECT 'PurchaseReturnItem', COUNT(*) FROM "PurchaseReturnItem"
        UNION ALL SELECT 'SupplierPayment', COUNT(*) FROM "SupplierPayment"
        UNION ALL SELECT 'InventoryLog', COUNT(*) FROM "InventoryLog"
      `;
      const counts: Record<string, number> = Object.fromEntries(
        countRows.map((r) => [r.t, Number(r.n)]),
      );

      // Original formula, inline: purchases − returns − settled(non-bounced) − transport
      const supplierRows = await tx.$queryRaw<
        {
          id: string;
          name: string;
          purchases: Prisma.Decimal | null;
          transport: Prisma.Decimal | null;
          returns: Prisma.Decimal | null;
          settled: Prisma.Decimal | null;
        }[]
      >`
        SELECT s.id, s.name,
          (SELECT SUM(p."totalValue") FROM "Purchase" p WHERE p."supplierId" = s.id) AS purchases,
          (SELECT SUM(p."transportCharges") FROM "Purchase" p WHERE p."supplierId" = s.id) AS transport,
          (SELECT SUM(r."totalAmount") FROM "PurchaseReturn" r WHERE r."supplierId" = s.id) AS returns,
          (SELECT SUM(sp.amount) FROM "SupplierPayment" sp
             WHERE sp."supplierId" = s.id
               AND NOT (sp.mode = 'CHEQUE' AND sp."chequeStatus" IS NOT NULL AND sp."chequeStatus" = 'RETURNED')
          ) AS settled
        FROM "Supplier" s
      `;

      const replacementBySupplier = new Map<string, Prisma.Decimal>();
      if (exists) {
        counts.PurchaseReturnReplacement = Number(
          (
            await tx.$queryRaw<{ n: bigint }[]>`
              SELECT COUNT(*) AS n FROM "PurchaseReturnReplacement"
            `
          )[0].n,
        );
        const rows = await tx.$queryRaw<
          { supplierId: string; total: Prisma.Decimal }[]
        >`
          SELECT "supplierId", SUM("totalAmount") AS total
          FROM "PurchaseReturnReplacement" GROUP BY "supplierId"
        `;
        for (const r of rows) replacementBySupplier.set(r.supplierId, r.total);
      }

      let totalOld = ZERO;
      let totalNew = ZERO;
      const suppliers: Snapshot['suppliers'] = {};
      for (const s of supplierRows) {
        const purchases = new Prisma.Decimal(s.purchases ?? 0);
        const transport = new Prisma.Decimal(s.transport ?? 0);
        const returns = new Prisma.Decimal(s.returns ?? 0);
        const settled = new Prisma.Decimal(s.settled ?? 0);
        const replacements = replacementBySupplier.get(s.id) ?? ZERO;
        const oldBalance = purchases.sub(returns).sub(settled).sub(transport);
        const newBalance = exists
          ? supplierBalance({
              purchases,
              transportCharges: transport,
              returns,
              replacements,
              settled,
            })
          : null;
        totalOld = totalOld.add(oldBalance);
        if (newBalance) totalNew = totalNew.add(newBalance);
        suppliers[s.id] = {
          name: s.name,
          purchases: money(purchases),
          transport: money(transport),
          returns: money(returns),
          settled: money(settled),
          replacements: money(replacements),
          balanceOldFormula: money(oldBalance),
          balanceNewFormula: newBalance ? money(newBalance) : null,
        };
      }

      const productRows = await tx.$queryRaw<
        { id: string; currentStock: number; last: number | null }[]
      >`
        SELECT p.id, p."currentStock",
          (SELECT l."balanceAfter" FROM "InventoryLog" l
             WHERE l."productId" = p.id
             ORDER BY l."createdAt" DESC, l.id DESC LIMIT 1) AS last
        FROM "Product" p
      `;
      const products: Snapshot['products'] = Object.fromEntries(
        productRows.map((p) => [
          p.id,
          { currentStock: p.currentStock, lastLedgerBalance: p.last },
        ]),
      );

      return {
        takenAt: new Date().toISOString(),
        databaseHost: databaseHost(),
        replacementTableExists: exists,
        counts,
        suppliers,
        products,
        totals: {
          balanceOldFormula: money(totalOld),
          balanceNewFormula: exists ? money(totalNew) : null,
        },
      };
    },
    { maxWait: 10000, timeout: 120000 },
  );
}

function compare(a: Snapshot, b: Snapshot): string[] {
  const problems: string[] = [];
  if (a.databaseHost !== b.databaseHost) {
    problems.push(
      `Snapshots are from different databases: ${a.databaseHost} vs ${b.databaseHost}`,
    );
  }
  for (const [table, n] of Object.entries(a.counts)) {
    if (b.counts[table] !== n) {
      problems.push(`Row count ${table}: ${n} → ${b.counts[table]}`);
    }
  }
  for (const [id, sa] of Object.entries(a.suppliers)) {
    const sb = b.suppliers[id];
    if (!sb) {
      problems.push(`Supplier ${sa.name} (${id}) missing in second snapshot`);
      continue;
    }
    for (const k of [
      'purchases',
      'transport',
      'returns',
      'settled',
      'balanceOldFormula',
    ] as const) {
      if (sa[k] !== sb[k]) {
        problems.push(`Supplier ${sa.name}: ${k} ${sa[k]} → ${sb[k]}`);
      }
    }
    // New formula must equal old formula + replacements, for every supplier.
    if (sb.balanceNewFormula !== null) {
      const expected = new Prisma.Decimal(sb.balanceOldFormula)
        .add(sb.replacements)
        .toFixed(2);
      if (sb.balanceNewFormula !== expected) {
        problems.push(
          `Supplier ${sb.name}: new-formula balance ${sb.balanceNewFormula} ≠ old ${sb.balanceOldFormula} + replacements ${sb.replacements}`,
        );
      }
    }
  }
  for (const [id, pa] of Object.entries(a.products)) {
    const pb = b.products[id];
    if (!pb) {
      problems.push(`Product ${id} missing in second snapshot`);
    } else if (pa.currentStock !== pb.currentStock) {
      problems.push(
        `Product ${id}: currentStock ${pa.currentStock} → ${pb.currentStock}`,
      );
    }
  }
  return problems;
}

function warnLedgerMismatches(s: Snapshot) {
  const mismatched = Object.entries(s.products).filter(
    ([, p]) =>
      p.lastLedgerBalance !== null && p.lastLedgerBalance !== p.currentStock,
  );
  if (mismatched.length > 0) {
    console.warn(
      `Note: ${mismatched.length} product(s) have currentStock ≠ latest InventoryLog.balanceAfter (pre-existing; reported only, not fixed).`,
    );
  }
}

async function main() {
  const [mode, fileA, fileB] = process.argv.slice(2);

  if (mode === 'snapshot' && fileA) {
    console.log(`Reading (READ ONLY) from database host: ${databaseHost()}`);
    const snap = await snapshot();
    writeFileSync(fileA, JSON.stringify(snap, null, 2));
    console.log(
      `Snapshot written to ${fileA}: ${Object.keys(snap.suppliers).length} suppliers, ` +
        `${Object.keys(snap.products).length} products, total balance ${snap.totals.balanceOldFormula}` +
        (snap.replacementTableExists
          ? ` (new formula ${snap.totals.balanceNewFormula})`
          : ' (replacement table not present yet)'),
    );
    warnLedgerMismatches(snap);
    return;
  }

  if (mode === 'compare' && fileA && fileB) {
    const a = JSON.parse(readFileSync(fileA, 'utf8')) as Snapshot;
    const b = JSON.parse(readFileSync(fileB, 'utf8')) as Snapshot;
    const problems = compare(a, b);
    if (problems.length === 0) {
      console.log(
        `PASS — ${Object.keys(a.suppliers).length} suppliers and ${Object.keys(a.products).length} products identical; ` +
          `every new-formula balance = old formula + replacements.`,
      );
      return;
    }
    console.error(`FAIL — ${problems.length} difference(s):`);
    for (const p of problems.slice(0, 200)) console.error(`  • ${p}`);
    process.exitCode = 1;
    return;
  }

  console.error(
    'Usage: verify-balances.ts snapshot <out.json> | compare <before.json> <after.json>',
  );
  process.exitCode = 2;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
