/**
 * One-off seed: creates the 3 real equity partners (Amjath, Aski, Mubarak)
 * with their profit-share percentages. Investments, profit entries, and
 * expenses are NOT seeded here — those are added afterward through the
 * admin UI/API.
 *
 * Idempotent: skips entirely if any Investor already exists.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/seed-equity-data.ts            (dry run, no writes)
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/seed-equity-data.ts --commit    (writes for real)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

const INVESTOR_NAMES = ['Amjath', 'Aski', 'Mubarak'] as const;

const PROFIT_SHARE_PERCENTAGE: Record<(typeof INVESTOR_NAMES)[number], number> = {
  Amjath: 33.33,
  Aski: 33.33,
  Mubarak: 33.33,
};

async function main() {
  const existingCount = await prisma.investor.count();
  if (existingCount > 0) {
    console.log(
      `Investor table already has ${existingCount} row(s) — skipping, this script is idempotent and only meant to run once.`,
    );
    return;
  }

  const percentageSum = Object.values(PROFIT_SHARE_PERCENTAGE).reduce((a, b) => a + b, 0);

  console.log('--- Dry run summary ---');
  console.log(`Investors to create: ${INVESTOR_NAMES.join(', ')}`);
  console.log(`Profit share percentages: ${JSON.stringify(PROFIT_SHARE_PERCENTAGE)} (sum = ${percentageSum}%)`);
  if (percentageSum !== 100) {
    console.warn(`WARNING: percentages sum to ${percentageSum}%, not 100%`);
  }

  if (!COMMIT) {
    console.log('\nDry run only — rerun with --commit to write these rows.');
    return;
  }

  console.log('\n--- Committing ---');

  for (const name of INVESTOR_NAMES) {
    const investor = await prisma.investor.create({
      data: { name, profitSharePercentage: PROFIT_SHARE_PERCENTAGE[name] },
    });
    console.log(`Created investor ${name} (${investor.id}), share=${PROFIT_SHARE_PERCENTAGE[name]}%`);
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
