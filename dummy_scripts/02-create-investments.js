const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const MODES = ['CASH', 'CHEQUE', 'BANK_TRANSFER'];
const CONTRIBUTION_REASONS = [
  'Capital injection',
  'Working capital top-up',
  'Quarterly contribution',
  'Inventory expansion funding',
  'Bridge funding',
  'Additional paid-in capital',
  'Seasonal stock financing',
  'Emergency capital call',
];
const WITHDRAWAL_REASONS = [
  'Partial withdrawal',
  'Profit distribution drawdown',
  'Personal fund transfer',
  'Return of excess capital',
];
const REMARKS_POOL = [
  null,
  null,
  null,
  'Confirmed by phone',
  'Wired via primary account',
  'Deposited at head office',
  'Pending bank confirmation on the day',
  'Regular scheduled contribution',
];

const TOTAL_RECORDS = 100;
const WITHDRAWAL_PROBABILITY = 0.15;
const DAYS_LOOKBACK = 540; 

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDateWithinLookback() {
  const now = Date.now();
  const offsetMs = Math.floor(Math.random() * DAYS_LOOKBACK) * 24 * 60 * 60 * 1000;
  return new Date(now - offsetMs);
}

function randomAmount(isWithdrawal) {
  if (isWithdrawal) {
    return -Math.round((10_000 + Math.random() * 140_000) / 500) * 500;
  }
  return Math.round((25_000 + Math.random() * 725_000) / 500) * 500;
}

(async () => {
  try {
    const investors = await prisma.investor.findMany({
      where: { name: { startsWith: 'Dummy Investor' } },
    });
    if (investors.length === 0) {
      console.error('No dummy investors found — run 01-create-investors.js first.');
      process.exitCode = 1;
      return;
    }

    const rows = [];
    for (let i = 0; i < TOTAL_RECORDS; i++) {
      const isWithdrawal = Math.random() < WITHDRAWAL_PROBABILITY;
      const investor = randomItem(investors);
      rows.push({
        investorId: investor.id,
        amount: randomAmount(isWithdrawal),
        mode: randomItem(MODES),
        investmentDate: randomDateWithinLookback(),
        reason: isWithdrawal ? randomItem(WITHDRAWAL_REASONS) : randomItem(CONTRIBUTION_REASONS),
        remarks: randomItem(REMARKS_POOL),
      });
    }

    await prisma.investment.createMany({ data: rows });
    console.log(`Created ${rows.length} dummy investment rows across ${investors.length} dummy investors.`);

    const totalCount = await prisma.investment.count();
    console.log(`Total investment rows now in DB (including real ones): ${totalCount}`);
  } finally {
    await prisma.$disconnect();
  }
})();
