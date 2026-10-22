import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { BalanceSheetService } from './balance-sheet.service';
import { PrismaService } from '../prisma/prisma.service';
import { LiquidCashService } from '../liquid-cash/liquid-cash.service';
import { CreditBalanceService } from '../credit-balance/credit-balance.service';
import { EquityService } from '../equity/equity.service';

const D = (v: number | string) => new Prisma.Decimal(v);

/**
 * Every test in this file runs against fully mocked dependencies — no real
 * database connection is ever opened, so these tests cannot read, let alone
 * write, any production (or any real) data. This is a deliberate choice
 * (balance_sheet.md §19/§2): the repo has zero existing financial-service
 * test infrastructure to extend, and BalanceSheetService is a pure
 * composition/aggregation layer, so its correctness is fully exercised by
 * controlling exactly what its four dependencies (PrismaService,
 * LiquidCashService, CreditBalanceService, EquityService) return.
 *
 * `prisma` below is intentionally a *read-only allowlist* mock (see
 * `makeReadOnlyPrisma`) — it only implements the specific aggregate/raw-query
 * methods BalanceSheetService is supposed to call. If the service under test
 * ever called `.create`/`.update`/`.delete`/`.upsert`/`.updateMany`/
 * `.deleteMany` on any model, or touched a model outside the allowlist, the
 * mock throws immediately — this is the "no write path exists" regression
 * guard required by the task, enforced structurally rather than by
 * inspecting a real (mutable) database after the fact.
 */
// Every OTHER Prisma model in the schema (prisma/schema.prisma) — accessing any of these
// from BalanceSheetService would mean it started reading (or, worse, writing) a table it
// has no business touching. Listed explicitly, as a blacklist, so framework-internal
// property probes (`then`, `catch`, symbols, etc. — triggered by Nest's DI container and
// Jest's own promise/thenable duck-typing) are left alone and don't false-positive.
const OTHER_PRISMA_MODELS = [
  'admin',
  'category',
  'product',
  'productImage',
  'supplier',
  'purchase',
  'purchaseReturn',
  'purchaseReturnItem',
  'purchaseItem',
  'inventoryLog',
  'order',
  'orderItem',
  'invoice',
  'payment',
  'supplierPayment',
  'investor',
  'expense',
  'salesReturn',
  'salesReturnItem',
  'activityLog',
  'counter',
  'refreshToken',
  'representative',
  'representativeLoginHistory',
  'representativeActivityLog',
  'customerProfile',
  'customerNote',
  'productAssignment',
  'bannerAssignment',
  'productAvailabilityOverride',
  'commissionRule',
  'representativeSettlement',
  'collectionSubmission',
  'collectionReminderLog',
  'brand',
  'banner',
  'repOrderDraft',
  'repOrderDraftItem',
];
const WRITE_OR_TRANSACTION_METHODS = [
  '$transaction',
  '$executeRaw',
  '$connect',
  '$disconnect',
];

function makeReadOnlyPrisma() {
  const dealerAggregate = jest.fn();
  const investmentAggregate = jest.fn();
  const commissionLedgerEntryAggregate = jest.fn();
  const queryRaw = jest.fn();

  const ALLOWED: Record<string, Record<string, unknown>> = {
    dealer: { aggregate: dealerAggregate },
    investment: { aggregate: investmentAggregate },
    commissionLedgerEntry: { aggregate: commissionLedgerEntryAggregate },
  };

  const modelProxy = (modelName: string) =>
    new Proxy(ALLOWED[modelName], {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (typeof prop !== 'string' || prop.startsWith('$') === false) {
          // Any *named* method other than the whitelisted one(s) above — most importantly
          // create/update/delete/upsert/updateMany/deleteMany/findUnique/findFirst — is a
          // write (or at least a non-audited read) attempt and must fail loudly.
          if (typeof prop === 'string' && /^[a-zA-Z]+$/.test(prop)) {
            throw new Error(
              `BalanceSheetService attempted to call a non-whitelisted Prisma method "${modelName}.${String(prop)}" — ` +
                'this service must be strictly read-only.',
            );
          }
        }
        return undefined;
      },
    });

  const root = new Proxy(
    { $queryRaw: queryRaw },
    {
      get(target, prop: string | symbol) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === '$queryRaw') return target.$queryRaw;
        if (prop in ALLOWED) return modelProxy(prop);
        if (WRITE_OR_TRANSACTION_METHODS.includes(prop)) {
          throw new Error(
            `BalanceSheetService attempted to call a non-whitelisted Prisma root method "${prop}" — ` +
              'this service must be strictly read-only and must never touch write/transaction APIs.',
          );
        }
        if (OTHER_PRISMA_MODELS.includes(prop)) {
          throw new Error(
            `BalanceSheetService attempted to access a non-whitelisted Prisma model "${prop}" — ` +
              'this service must only read Dealer, Investment, and CommissionLedgerEntry via aggregate, plus two raw SELECTs.',
          );
        }
        // Anything else (then/catch/toJSON/constructor/inspect symbols/...) is framework
        // introspection, not a real data-access attempt — leave it alone.
        return undefined;
      },
    },
  );

  return {
    prisma: root as unknown as PrismaService,
    mocks: {
      dealerAggregate,
      investmentAggregate,
      commissionLedgerEntryAggregate,
      queryRaw,
    },
  };
}

describe('BalanceSheetService', () => {
  let service: BalanceSheetService;
  let mocks: ReturnType<typeof makeReadOnlyPrisma>['mocks'];
  let liquidCashService: { getSummary: jest.Mock };
  let creditBalanceService: { getSummary: jest.Mock };
  let equityService: { getSummary: jest.Mock };

  /** Sets up a fully clean, self-consistent fixture: no in-flight orders, 100% investor
   * profit-share allocation, zero commission outstanding, everything matched. */
  function wireCleanFixture() {
    liquidCashService.getSummary.mockResolvedValue({
      balance: 500_000,
      totalInvestments: 400_000,
      totalCollected: 300_000,
      totalPaidToSuppliers: 150_000,
      totalExpensesPaid: 50_000,
      pendingDealerCheques: 0,
      pendingSupplierCheques: 0,
      pendingRefundChequesIn: 0,
      pendingRefundChequesOut: 0,
      openingBalance: 0,
      totalAdjustments: 0,
    });
    creditBalanceService.getSummary.mockResolvedValue({
      balance: 120_000,
      totalPurchases: 200_000,
      totalTransportCharges: 0,
      totalReturns: 10_000,
      totalSettled: 60,
      pendingChequeSettlements: 0,
    });
    equityService.getSummary.mockResolvedValue({
      investorCount: 1,
      entries: [],
      totals: {
        totalInvestment: D(400_000),
        totalProfit: D(80_000),
        totalExpenses: D(50_000),
        totalEquity: D(430_000), // = 400,000 + 80,000 - 50,000 (100% allocated)
        percentageTotal: D(100),
      },
    });
    mocks.dealerAggregate.mockResolvedValue({
      _sum: { outstandingBalance: D(90_000) },
    });
    mocks.investmentAggregate
      .mockResolvedValueOnce({ _sum: { amount: D(400_000) } }) // contributions
      .mockResolvedValueOnce({ _sum: { amount: null } }); // withdrawals — none
    mocks.queryRaw
      .mockResolvedValueOnce([{ value: D(40_000) }]) // inventory
      .mockResolvedValueOnce([{ value: D(0), count: BigInt(0) }]); // in-flight orders — none
    mocks.commissionLedgerEntryAggregate.mockResolvedValue({
      _sum: { amount: D(0) },
      _count: 0,
    });
    // Assets: 500,000 + 90,000 + 0 + 40,000 = 630,000
    // Liabilities: 120,000 + 0 = 120,000
    // Equity: 430,000 → L+E = 550,000 ... NOT balanced by construction here on purpose;
    // individual tests override pieces to hit the specific scenario under test.
  }

  beforeEach(async () => {
    const { prisma, mocks: m } = makeReadOnlyPrisma();
    mocks = m;
    liquidCashService = { getSummary: jest.fn() };
    creditBalanceService = { getSummary: jest.fn() };
    equityService = { getSummary: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceSheetService,
        { provide: PrismaService, useValue: prisma },
        { provide: LiquidCashService, useValue: liquidCashService },
        { provide: CreditBalanceService, useValue: creditBalanceService },
        { provide: EquityService, useValue: equityService },
      ],
    }).compile();

    service = module.get<BalanceSheetService>(BalanceSheetService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  describe('read-only guarantee', () => {
    it('never calls a write/transaction Prisma method — the mock throws immediately if it tries', async () => {
      wireCleanFixture();
      // If the service under test called anything outside the allowlisted
      // aggregate/$queryRaw methods, this call would throw synchronously
      // during the underlying Promise.all — so simply awaiting successfully
      // proves no write/transaction path was exercised.
      await expect(service.getSummary()).resolves.toBeDefined();
    });

    it('only reads Dealer, Investment, CommissionLedgerEntry via aggregate, plus two raw SELECTs — nothing else', async () => {
      wireCleanFixture();
      await service.getSummary();
      expect(mocks.dealerAggregate).toHaveBeenCalledTimes(1);
      expect(mocks.investmentAggregate).toHaveBeenCalledTimes(2);
      expect(mocks.commissionLedgerEntryAggregate).toHaveBeenCalledTimes(1);
      expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('Decimal precision', () => {
    it('never introduces floating-point error on values that break naive JS number arithmetic', async () => {
      wireCleanFixture();
      // 0.1 + 0.2 !== 0.3 in IEEE754 — verify the service's Decimal-based
      // arithmetic gets this exactly right end-to-end.
      liquidCashService.getSummary.mockResolvedValue({
        balance: 0.1,
        totalInvestments: 0,
        totalCollected: 0,
        totalPaidToSuppliers: 0,
        totalExpensesPaid: 0,
        pendingDealerCheques: 0.2,
        pendingSupplierCheques: 0,
        pendingRefundChequesIn: 0,
        pendingRefundChequesOut: 0,
        openingBalance: 0,
        totalAdjustments: 0,
      });
      mocks.dealerAggregate.mockResolvedValue({
        _sum: { outstandingBalance: D(0) },
      });
      mocks.queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ value: D(0) }])
        .mockResolvedValueOnce([{ value: D(0), count: BigInt(0) }]);

      const result = await service.getSummary();
      expect(result.assets.current.cashAndBank).toBe('0.10');
      expect(result.assets.current.chequesInHand).toBe('0.20');
      expect(result.assets.current.totalCurrentAssets).toBe('0.30');
    });

    it('returns every monetary field as a fixed-2-decimal string, never a JS number', async () => {
      wireCleanFixture();
      const result = await service.getSummary();
      for (const value of [
        result.assets.current.cashAndBank,
        result.assets.current.accountsReceivable,
        result.assets.current.inventory,
        result.liabilities.current.accountsPayable,
        result.equity.totalEquity,
        result.summary.rawDifference,
      ]) {
        expect(typeof value).toBe('string');
        expect(value).toMatch(/^-?\d+\.\d{2}$/);
      }
    });
  });

  describe('Commission Payable — memorandum only (§10 Option B)', () => {
    it('is excluded from totalLiabilities regardless of how large it is', async () => {
      wireCleanFixture();
      // Force an otherwise-balanced fixture (Assets == Liabilities + Equity)
      // so any leakage of commissionPayable into totalLiabilities would be
      // immediately visible as a nonzero rawDifference.
      equityService.getSummary.mockResolvedValue({
        investorCount: 1,
        entries: [],
        totals: {
          totalInvestment: D(400_000),
          totalProfit: D(160_000),
          totalExpenses: D(50_000),
          // Internally consistent at percentageTotal=100: 400,000 + (160,000-50,000) = 510,000,
          // chosen so that 630,000 (assets) == 120,000 (AP) + 510,000 (equity) exactly.
          totalEquity: D(510_000),
          percentageTotal: D(100),
        },
      });
      mocks.commissionLedgerEntryAggregate.mockResolvedValue({
        _sum: { amount: D(250_000) }, // large outstanding commission
        _count: 7,
      });

      const result = await service.getSummary();
      expect(result.liabilities.current.totalCurrentLiabilities).toBe(
        '120000.00',
      );
      expect(result.liabilities.totalLiabilities).toBe('120000.00');
      expect(result.memorandum.commissionPayable.value).toBe('250000.00');
      expect(result.memorandum.commissionPayable.includedInTotals).toBe(false);
      expect(
        result.memorandum.commissionPayable.pendingOrApprovedLineCount,
      ).toBe(7);
      expect(result.reconciliation.status).toBe('BALANCED');
    });

    it('never appears inside rawDifference/unexplainedDifference — a large outstanding balance changes nothing but the memorandum', async () => {
      wireCleanFixture();
      mocks.commissionLedgerEntryAggregate.mockResolvedValue({
        _sum: { amount: D(999_999) },
        _count: 3,
      });
      const result = await service.getSummary();
      // Hand-computed from wireCleanFixture's fixed inputs, independent of commissionPayable:
      // Assets = 500,000 + 90,000 + 0 + 40,000 = 630,000
      // Liabilities = 120,000 (AP) + 0 (supplier cheques) = 120,000
      // Equity = 430,000 (100% allocated, no in-flight orders)
      // rawDifference = 630,000 - (120,000 + 430,000) = 80,000; both known-difference
      // components are 0 here, so unexplainedDifference must also be exactly 80,000 —
      // completely unaffected by the 999,999 of outstanding commission above.
      expect(result.summary.rawDifference).toBe('80000.00');
      expect(result.reconciliation.knownDifference).toBe('0.00');
      expect(result.reconciliation.unexplainedDifference).toBe('80000.00');
      expect(result.reconciliation.status).toBe('UNBALANCED');
    });

    it('includes the exclusion rationale in accountingWarnings whenever commission is outstanding', async () => {
      wireCleanFixture();
      mocks.commissionLedgerEntryAggregate.mockResolvedValue({
        _sum: { amount: D(1) },
        _count: 1,
      });
      const result = await service.getSummary();
      expect(
        result.accountingWarnings.some((w) => w.includes('commissionPayable')),
      ).toBe(true);
    });
  });

  describe('in-flight order timing gap (§12/§13.2)', () => {
    // Self-contained, hand-verified fixture (deliberately not reusing wireCleanFixture's
    // numbers, to keep the arithmetic easy to audit):
    //   Assets      = cash 100,000 + AR 50,000 + cheques 0 + inventory 30,000 = 180,000
    //   Liabilities = AP 40,000 + supplier cheques 0                          =  40,000
    //   Equity      = totalInvestment 150,000 + (profit 10,000 - expenses 1,500) @ 100% = 158,500
    //   L+E = 40,000 + 158,500 = 198,500
    //   rawDifference = 180,000 - 198,500 = -18,500, which must exactly equal
    //   knownOrderTimingDifference when the in-flight reserved-cost query returns 18,500.
    function wireTimingFixture(extraAR = 0) {
      liquidCashService.getSummary.mockResolvedValue({
        balance: 100_000,
        totalInvestments: 150_000,
        totalCollected: 0,
        totalPaidToSuppliers: 0,
        totalExpensesPaid: 0,
        pendingDealerCheques: 0,
        pendingSupplierCheques: 0,
        pendingRefundChequesIn: 0,
        pendingRefundChequesOut: 0,
        openingBalance: 0,
        totalAdjustments: 0,
      });
      creditBalanceService.getSummary.mockResolvedValue({
        balance: 40_000,
        totalPurchases: 40_000,
        totalTransportCharges: 0,
        totalReturns: 0,
        totalSettled: 0,
        pendingChequeSettlements: 0,
      });
      equityService.getSummary.mockResolvedValue({
        investorCount: 1,
        entries: [],
        totals: {
          totalInvestment: D(150_000),
          totalProfit: D(10_000),
          totalExpenses: D(1_500),
          totalEquity: D(158_500),
          percentageTotal: D(100),
        },
      });
      mocks.dealerAggregate.mockResolvedValue({
        _sum: { outstandingBalance: D(50_000 + extraAR) },
      });
      mocks.investmentAggregate
        .mockReset()
        .mockResolvedValueOnce({ _sum: { amount: D(150_000) } })
        .mockResolvedValueOnce({ _sum: { amount: null } });
      mocks.queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ value: D(30_000) }]) // inventory
        .mockResolvedValueOnce([{ value: D(18_500), count: BigInt(1) }]); // in-flight order
      mocks.commissionLedgerEntryAggregate.mockResolvedValue({
        _sum: { amount: D(0) },
        _count: 0,
      });
    }

    it('classifies a fixture with exactly one known-explained gap as BALANCED_WITH_KNOWN_TIMING_DIFFERENCE', async () => {
      wireTimingFixture();
      const result = await service.getSummary();
      expect(result.summary.rawDifference).toBe('-18500.00');
      expect(result.reconciliation.knownOrderTimingDifference).toBe(
        '-18500.00',
      );
      expect(result.reconciliation.inFlightOrderCount).toBe(1);
      expect(result.reconciliation.unexplainedDifference).toBe('0.00');
      expect(result.reconciliation.status).toBe(
        'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE',
      );
    });

    it('reports UNBALANCED with a nonzero unexplainedDifference when an extra, unrelated discrepancy exists', async () => {
      // Inject an unrelated extra 5,500 of AR with no matching explanation.
      wireTimingFixture(5_500);
      const result = await service.getSummary();
      expect(result.summary.rawDifference).toBe('-13000.00');
      expect(result.reconciliation.knownDifference).toBe('-18500.00');
      // unexplainedDifference = rawDifference - knownDifference = -13,000 - (-18,500) = +5,500.
      expect(result.reconciliation.unexplainedDifference).toBe('5500.00');
      expect(result.reconciliation.status).toBe('UNBALANCED');
    });
  });

  describe('unallocated investor profit share (§13.6 addendum, discovered during implementation)', () => {
    it('is computed purely from EquityService totals and folded into knownDifference — EquityService itself is untouched', async () => {
      wireCleanFixture();
      // Only 60% of profit share is allocated to named investors.
      equityService.getSummary.mockResolvedValue({
        investorCount: 1,
        entries: [],
        totals: {
          totalInvestment: D(400_000),
          totalProfit: D(80_000),
          totalExpenses: D(50_000),
          // 400,000 + (80,000-50,000)*0.6 = 400,000 + 18,000 = 418,000
          totalEquity: D(418_000),
          percentageTotal: D(60),
        },
      });
      const result = await service.getSummary();
      // accumulatedEarningsGross (30,000) - (totalEquity - totalInvestment = 18,000) = 12,000
      expect(result.reconciliation.knownUnallocatedEquityDifference).toBe(
        '12000.00',
      );
      expect(result.reconciliation.investorPercentageTotal).toBe('60');
      expect(
        result.accountingWarnings.some((w) => w.includes('profit-share')),
      ).toBe(true);
    });

    it('does not add the unallocated-equity warning when percentageTotal is exactly 100', async () => {
      wireCleanFixture();
      const result = await service.getSummary();
      expect(result.reconciliation.knownUnallocatedEquityDifference).toBe(
        '0.00',
      );
      expect(
        result.accountingWarnings.some((w) => w.includes('profit-share')),
      ).toBe(false);
    });
  });

  describe('equity is never used as a balancing plug (§16.4/§19 no-plug rule)', () => {
    it('totalEquity always equals exactly what EquityService returned, even when the sheet is UNBALANCED', async () => {
      wireCleanFixture();
      // Deliberately unbalanced fixture — nothing here should cause totalEquity
      // to be silently recomputed as totalAssets - totalLiabilities.
      mocks.dealerAggregate.mockResolvedValue({
        _sum: { outstandingBalance: D(999_999) },
      });
      const result = await service.getSummary();
      expect(result.reconciliation.status).toBe('UNBALANCED');
      expect(result.equity.totalEquity).toBe(D(430_000).toFixed(2));
      // Explicitly confirm it is NOT totalAssets - totalLiabilities (which would be a plug).
      const plugValue = new Prisma.Decimal(result.summary.totalAssets)
        .sub(result.summary.totalLiabilities)
        .toFixed(2);
      expect(result.equity.totalEquity).not.toBe(plugValue);
    });
  });

  describe('AR / Cash / Inventory field mapping', () => {
    it('maps LiquidCashService.pendingDealerCheques into assets.current.chequesInHand without double counting AR', async () => {
      wireCleanFixture();
      liquidCashService.getSummary.mockResolvedValue({
        balance: 500_000,
        totalInvestments: 400_000,
        totalCollected: 300_000,
        totalPaidToSuppliers: 150_000,
        totalExpensesPaid: 50_000,
        pendingDealerCheques: 25_000,
        pendingSupplierCheques: 0,
        pendingRefundChequesIn: 0,
        pendingRefundChequesOut: 0,
        openingBalance: 0,
        totalAdjustments: 0,
      });
      const result = await service.getSummary();
      expect(result.assets.current.chequesInHand).toBe('25000.00');
      expect(result.assets.current.accountsReceivable).toBe('90000.00'); // unchanged — no double count
      expect(result.assets.current.totalCurrentAssets).toBe('655000.00'); // 500,000+90,000+25,000+40,000
    });

    it('maps CreditBalanceService.pendingChequeSettlements into liabilities.current.supplierChequesIssued', async () => {
      wireCleanFixture();
      creditBalanceService.getSummary.mockResolvedValue({
        balance: 120_000,
        totalPurchases: 200_000,
        totalTransportCharges: 5_000,
        totalReturns: 10_000,
        totalSettled: 65_000,
        pendingChequeSettlements: 15_000,
      });
      const result = await service.getSummary();
      expect(result.liabilities.current.supplierChequesIssued).toBe('15000.00');
      expect(result.liabilities.current.totalCurrentLiabilities).toBe(
        '135000.00',
      );
    });
  });

  describe('Liquid Cash remediation items (LC-08/LC-12/LC-15)', () => {
    // The clean fixture has rawDifference 80,000 (see wireCleanFixture).
    const liquid = (over: Record<string, number>) => ({
      balance: 500_000,
      totalInvestments: 400_000,
      totalCollected: 300_000,
      totalPaidToSuppliers: 150_000,
      totalExpensesPaid: 50_000,
      pendingDealerCheques: 0,
      pendingSupplierCheques: 0,
      pendingRefundChequesIn: 0,
      pendingRefundChequesOut: 0,
      openingBalance: 0,
      totalAdjustments: 0,
      ...over,
    });

    it('names transport charges deducted from payables as a known difference, with a warning', async () => {
      wireCleanFixture();
      creditBalanceService.getSummary.mockResolvedValue({
        balance: 120_000,
        totalTransportCharges: 80_000,
        pendingChequeSettlements: 0,
      });
      const result = await service.getSummary();
      expect(result.summary.rawDifference).toBe('80000.00');
      expect(result.reconciliation.knownTransportChargeDifference).toBe(
        '80000.00',
      );
      expect(result.reconciliation.unexplainedDifference).toBe('0.00');
      expect(result.reconciliation.status).toBe(
        'BALANCED_WITH_KNOWN_TIMING_DIFFERENCE',
      );
      expect(result.accountingWarnings.join(' ')).toMatch(/transport charges/);
    });

    it('puts opening balance and cash adjustments in equity', async () => {
      wireCleanFixture();
      liquidCashService.getSummary.mockResolvedValue(
        liquid({ openingBalance: 50_000, totalAdjustments: 30_000 }),
      );
      const result = await service.getSummary();
      expect(result.equity.investorEquity).toBe('430000.00');
      expect(result.equity.cashAdjustments).toBe('80000.00');
      expect(result.equity.totalEquity).toBe('510000.00');
      expect(result.summary.rawDifference).toBe('0.00');
      expect(result.reconciliation.status).toBe('BALANCED');
    });

    it('carries refund cheques in transit on both sides without changing the difference', async () => {
      wireCleanFixture();
      liquidCashService.getSummary.mockResolvedValue(
        liquid({
          pendingRefundChequesIn: 7_000,
          pendingRefundChequesOut: 3_000,
        }),
      );
      const result = await service.getSummary();
      expect(result.assets.current.refundChequesReceivable).toBe('7000.00');
      expect(result.liabilities.current.refundChequesIssued).toBe('3000.00');
      expect(result.assets.current.totalCurrentAssets).toBe('637000.00');
      expect(result.liabilities.current.totalCurrentLiabilities).toBe(
        '123000.00',
      );
      expect(result.summary.rawDifference).toBe('84000.00');
    });
  });

  describe('unsupported categories', () => {
    it('reports every unsupported category as null, never as a summed 0', async () => {
      wireCleanFixture();
      const result = await service.getSummary();
      expect(result.assets.current.supplierAdvances).toBeNull();
      expect(result.assets.current.prepaidExpenses).toBeNull();
      expect(result.assets.nonCurrent.fixedAssets).toBeNull();
      expect(result.assets.nonCurrent.accumulatedDepreciation).toBeNull();
      expect(result.liabilities.current.taxPayable).toBeNull();
      expect(result.liabilities.current.accruedExpenses).toBeNull();
      expect(result.liabilities.current.customerAdvances).toBeNull();
      expect(result.liabilities.nonCurrent.loans).toBeNull();
      expect(result.unsupported).toEqual(
        expect.arrayContaining([
          'assets.current.supplierAdvances',
          'liabilities.nonCurrent.loans',
        ]),
      );
    });
  });
});
