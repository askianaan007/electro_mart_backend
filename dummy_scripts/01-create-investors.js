// Creates 4 clearly-labeled dummy investors for testing /admin/investments,
// each with a real (nonzero) profitSharePercentage.
//
// The app enforces total profitSharePercentage across every investor <= 100%
// (InvestorsService.assertProfitShareWithinLimit). This script scales every
// *real* investor (any investor NOT named "Dummy Investor …") down
// proportionally so it never exceedalls the cap once the 4 dummy investors take
// their share — preserving real investors' relative ratio to each other
// rather than overwriting them with arbitrary numbers. With zero real
// investors present, the dummy investors simply take the full 100% (25% each).
//
// Safe to re-run: upserts by name (updates in place, doesn't duplicate), and
// always re-derives the real-investor rescale from whatever is currently in
// the table, so re-running just re-asserts the same target percentages.
const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();

const DUMMY_SHARE_EACH = 25; // 4 x 25% = 100% when there are no real investors to share with
const REAL_INVESTORS_TARGET_TOTAL = 100 - DUMMY_SHARE_EACH * 4; // 0% here — adjust both constants together if this ever needs to change

const DUMMY_INVESTORS = [
  { name: 'Dummy Investor One', phone: '0771000001', email: 'dummy.investor.one@example.test' },
  { name: 'Dummy Investor Two', phone: '0771000002', email: 'dummy.investor.two@example.test' },
  { name: 'Dummy Investor Three', phone: '0771000003', email: 'dummy.investor.three@example.test' },
  { name: 'Dummy Investor Four', phone: '0771000004', email: 'dummy.investor.four@example.test' },
];

(async () => {
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Scale every real (non-dummy) investor proportionally to a combined REAL_INVESTORS_TARGET_TOTAL.
      // NOTE: negating a sub-filter must be `NOT: { name: { startsWith } }` at the
      // top level — `{ name: { not: { startsWith } } }` is NOT valid Prisma and
      // silently matches nothing, which is what caused this script to previously
      // report "No real investors found" even when real investors existed.
      const realInvestors = await tx.investor.findMany({
        where: { NOT: { name: { startsWith: 'Dummy Investor' } } },
      });
      const realTotal = realInvestors.reduce(
        (sum, inv) => sum.add(inv.profitSharePercentage),
        new Prisma.Decimal(0),
      );

      if (realInvestors.length > 0 && realTotal.greaterThan(0)) {
        for (const inv of realInvestors) {
          const newShare = inv.profitSharePercentage
            .mul(REAL_INVESTORS_TARGET_TOTAL)
            .div(realTotal)
            .toDecimalPlaces(2);
          await tx.investor.update({ where: { id: inv.id }, data: { profitSharePercentage: newShare } });
          console.log(
            `Rescaled real investor: ${inv.name} — ${inv.profitSharePercentage.toString()}% -> ${newShare.toString()}%`,
          );
        }
      } else {
        console.log(`No real investors found — the dummy investors take the full ${DUMMY_SHARE_EACH * 4}%.`);
      }

      // 2. Upsert the 4 dummy investors.
      for (const data of DUMMY_INVESTORS) {
        const existing = await tx.investor.findFirst({ where: { name: data.name } });
        if (existing) {
          const updated = await tx.investor.update({
            where: { id: existing.id },
            data: { ...data, profitSharePercentage: DUMMY_SHARE_EACH },
          });
          console.log(`Updated: ${updated.name} — ${updated.profitSharePercentage.toString()}% — ${updated.id}`);
        } else {
          const created = await tx.investor.create({
            data: { ...data, profitSharePercentage: DUMMY_SHARE_EACH },
          });
          console.log(`Created: ${created.name} — ${created.profitSharePercentage.toString()}% — ${created.id}`);
        }
      }
    });

    const all = await prisma.investor.findMany({ orderBy: { createdAt: 'asc' } });
    const grandTotal = all.reduce((sum, inv) => sum.add(inv.profitSharePercentage), new Prisma.Decimal(0));
    console.log('\n=== Final investor profit-share allocation ===');
    all.forEach((inv) => console.log(`${inv.name}: ${inv.profitSharePercentage.toString()}%`));
    console.log(`Total: ${grandTotal.toString()}%`);
  } finally {
    await prisma.$disconnect();
  }
})();
