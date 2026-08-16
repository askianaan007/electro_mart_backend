const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const investors = await prisma.investor.findMany({
      where: { name: { startsWith: 'Dummy Investor' } },
    });
    const investorIds = investors.map((i) => i.id);

    const { count: investmentsDeleted } = await prisma.investment.deleteMany({
      where: { investorId: { in: investorIds } },
    });
    const { count: investorsDeleted } = await prisma.investor.deleteMany({
      where: { id: { in: investorIds } },
    });

    console.log(`Deleted ${investmentsDeleted} dummy investment row(s) and ${investorsDeleted} dummy investor(s).`);
  } finally {
    await prisma.$disconnect();
  }
})();
