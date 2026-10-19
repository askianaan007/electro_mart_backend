import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { SalesAnalysisService } from '../sales-analysis/sales-analysis.service';
import { LiquidCashService } from '../liquid-cash/liquid-cash.service';
import { CreditBalanceService } from '../credit-balance/credit-balance.service';
import {
  BUSINESS_TIME_ZONE,
  businessDateOf,
  startOfBusinessDay,
  startOfBusinessMonth,
} from '../common/utils/business-date';
import { sqlUtc } from '../common/utils/sql-time';

// Cash figures (collections, cash flow) come from LiquidCashService's one
// ledger: a cheque counts on the day it cleared, not the day it was written,
// and corrections count on the day they were made — the same rows the
// Liquid Cash page shows (LC-14).

const FULFILLMENT_STATUSES: OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

// A percentage-change ratio only means something when the previous period
// was non-negative and the two periods share the same sign — e.g.
// pctChange(500, -1000) would naively compute -150%, reading as "profit
// down 150%" in a month that actually swung from a 1000 loss to a 500
// profit. Returns null (frontend renders "N/A") for any base/sign
// combination where the ratio wouldn't be a meaningful comparison.
function pctChange(curr: number, prev: number): number | null {
  if (prev < 0) return null;
  if (prev === 0) return curr > 0 ? 100 : curr === 0 ? 0 : null;
  if (curr < 0) return null;
  return ((curr - prev) / prev) * 100;
}

function toNumber(value: Prisma.Decimal | null | undefined): number {
  return value ? Number(value) : 0;
}

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private creditsService: CreditsService,
    private salesAnalysisService: SalesAnalysisService,
    private liquidCashService: LiquidCashService,
    private creditBalanceService: CreditBalanceService,
  ) {}

  /**
   * The five headline financial figures shared by computeMonthlyFinancials
   * and computeAllTimeFinancials — factored out so the two can never drift
   * into slightly different formulas for the same numbers (which is exactly
   * the class of bug a prior fix addressed for dashboard/sales-analysis
   * agreement).
   */
  private deriveFinancials(
    salesAnalysis: {
      totalSales: Prisma.Decimal;
      totalExpenses: Prisma.Decimal;
      netProfit: Prisma.Decimal;
    },
    salesReturnTotal: Prisma.Decimal | null,
    purchaseTotal: Prisma.Decimal | null,
    purchaseReturnTotal: Prisma.Decimal | null,
  ) {
    const netSales = toNumber(salesAnalysis.totalSales);
    const totalSalesReturn = toNumber(salesReturnTotal);
    const grossPurchase = toNumber(purchaseTotal);
    const totalPurchaseReturn = toNumber(purchaseReturnTotal);
    const netPurchase = grossPurchase - totalPurchaseReturn;
    const totalExpenses = toNumber(salesAnalysis.totalExpenses);
    const profit = toNumber(salesAnalysis.netProfit);

    return {
      netSales,
      totalSalesReturn,
      totalPurchaseReturn,
      netPurchase,
      totalExpenses,
      profit,
    };
  }

  private async computeMonthlyFinancials(rangeStart: Date, rangeEnd: Date) {
    const [
      salesAnalysis,
      salesReturnAgg,
      purchaseAgg,
      purchaseReturnAgg,
      cash,
    ] = await Promise.all([
      // Single source of truth for Net Sales/Profit: cost-of-goods-sold based
      // on completed orders in this range, shared with the Sales Analysis page.
      // Whole Colombo days, inclusive: the range's first and last dates.
      this.salesAnalysisService.getSummary({
        dateFrom: businessDateOf(rangeStart),
        dateTo: businessDateOf(new Date(rangeEnd.getTime() - 1)),
      }),
      this.prisma.salesReturn.aggregate({
        where: { returnDate: { gte: rangeStart, lt: rangeEnd } },
        _sum: { totalAmount: true },
      }),
      this.prisma.purchase.aggregate({
        where: { purchaseDate: { gte: rangeStart, lt: rangeEnd } },
        _sum: { totalValue: true },
      }),
      this.prisma.purchaseReturn.aggregate({
        where: { returnDate: { gte: rangeStart, lt: rangeEnd } },
        _sum: { totalAmount: true },
      }),
      this.liquidCashService.getPeriodTotals(rangeStart, rangeEnd),
    ]);

    const shared = this.deriveFinancials(
      salesAnalysis,
      salesReturnAgg._sum.totalAmount,
      purchaseAgg._sum.totalValue,
      purchaseReturnAgg._sum.totalAmount,
    );
    return {
      ...shared,
      invoiceDuePayments: cash.collected,
      netCashFlow: cash.netCashFlow,
      operatingCashFlow: cash.operatingCashFlow,
    };
  }

  /**
   * All-time totals — the same scope Sales Analysis and Equity use. A sale
   * recorded by an admin with a backdated sale date (e.g. entering a past
   * walk-in sale) has a completedAt outside the current calendar month, so
   * it would otherwise vanish from Net Sales/Profit here while still
   * counting everywhere else. These headline figures stay all-time so they
   * always agree with Sales Analysis/Equity; only their *ChangePct badges
   * (below) compare this month against last.
   */
  private async computeAllTimeFinancials() {
    const [salesAnalysis, salesReturnAgg, purchaseAgg, purchaseReturnAgg] =
      await Promise.all([
        this.salesAnalysisService.getSummary({}),
        this.prisma.salesReturn.aggregate({ _sum: { totalAmount: true } }),
        this.prisma.purchase.aggregate({ _sum: { totalValue: true } }),
        this.prisma.purchaseReturn.aggregate({ _sum: { totalAmount: true } }),
      ]);

    return this.deriveFinancials(
      salesAnalysis,
      salesReturnAgg._sum.totalAmount,
      purchaseAgg._sum.totalValue,
      purchaseReturnAgg._sum.totalAmount,
    );
  }

  private async getMonthlyKpis() {
    const now = new Date();
    const startOfThisMonth = startOfBusinessMonth(now);
    const startOfNextMonth = startOfBusinessMonth(now, 1);
    const startOfLastMonth = startOfBusinessMonth(now, -1);

    const [current, previous, allTime] = await Promise.all([
      this.computeMonthlyFinancials(startOfThisMonth, startOfNextMonth),
      this.computeMonthlyFinancials(startOfLastMonth, startOfThisMonth),
      this.computeAllTimeFinancials(),
    ]);

    return {
      netSales: allTime.netSales,
      netSalesChangePct: pctChange(current.netSales, previous.netSales),
      totalSalesReturn: allTime.totalSalesReturn,
      totalSalesReturnChangePct: pctChange(
        current.totalSalesReturn,
        previous.totalSalesReturn,
      ),
      totalPurchaseReturn: allTime.totalPurchaseReturn,
      totalPurchaseReturnChangePct: pctChange(
        current.totalPurchaseReturn,
        previous.totalPurchaseReturn,
      ),
      netPurchase: allTime.netPurchase,
      netPurchaseChangePct: pctChange(
        current.netPurchase,
        previous.netPurchase,
      ),
      // Change in Liquid Cash this month — equals the Liquid Cash page's
      // movement over the same dates. operatingCashFlow excludes capital.
      netCashFlow: current.netCashFlow,
      operatingCashFlow: current.operatingCashFlow,
      profit: allTime.profit,
      profitChangePct: pctChange(current.profit, previous.profit),
      totalExpenses: allTime.totalExpenses,
      totalExpensesChangePct: pctChange(
        current.totalExpenses,
        previous.totalExpenses,
      ),
      invoiceDuePayments: current.invoiceDuePayments,
      invoiceDuePaymentsChangePct: pctChange(
        current.invoiceDuePayments,
        previous.invoiceDuePayments,
      ),
    };
  }

  async getAdminSummary() {
    const startOfToday = startOfBusinessDay(new Date());
    const sixMonthsAgo = startOfBusinessMonth(new Date(), -5);

    // Extend the revenue chart's window back far enough to include any
    // admin-recorded sale with a backdated sale date older than 6 months —
    // otherwise it silently drops off the trend the same way Profit/Net
    // Sales used to when they were scoped to the current calendar month.
    const earliestCompleted = await this.prisma.order.aggregate({
      where: { status: OrderStatus.COMPLETED },
      _min: { completedAt: true },
    });
    const earliestCompletedAt = earliestCompleted._min.completedAt;
    const revenueChartStart =
      earliestCompletedAt && earliestCompletedAt < sixMonthsAgo
        ? startOfBusinessMonth(earliestCompletedAt)
        : sixMonthsAgo;

    const [
      todaysSalesAgg,
      todaysReturnsAgg,
      todaysOrders,
      pendingApprovals,
      outOfStockItems,
      outstandingAgg,
      outstandingByDealer,
      recentOrders,
      monthlyRevenue,
      topProductsGrouped,
      returnedQtyGrouped,
      monthlyKpis,
      liquidCashSummary,
      creditBalance,
      upcomingCheques,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          status: OrderStatus.COMPLETED,
          completedAt: { gte: startOfToday },
        },
        _sum: { totalAmount: true },
      }),
      // Goods returned today net against today's sales — a same-day return
      // shouldn't still count toward "Today's Sales".
      this.prisma.salesReturn.aggregate({
        where: { returnDate: { gte: startOfToday } },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.order.count({
        where: { status: OrderStatus.PENDING_APPROVAL },
      }),
      this.prisma.product.count({ where: { currentStock: { lte: 0 } } }),
      this.prisma.dealer.aggregate({ _sum: { outstandingBalance: true } }),
      // Per-dealer breakdown backing the "Outstanding Payments" drill-down —
      // who actually owes money, not just the aggregate total.
      this.prisma.dealer.findMany({
        where: { outstandingBalance: { gt: 0 } },
        orderBy: { outstandingBalance: 'desc' },
        select: {
          id: true,
          businessName: true,
          ownerName: true,
          phone: true,
          outstandingBalance: true,
          creditLimit: true,
          unlimitedCredit: true,
        },
      }),
      this.prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { dealer: { select: { businessName: true } } },
      }),
      this.prisma.$queryRaw<{ month: string; revenue: Prisma.Decimal }[]>`
        SELECT to_char(date_trunc('month', ("completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${BUSINESS_TIME_ZONE}), 'YYYY-MM') as month, SUM("totalAmount") as revenue
        FROM "Order"
        WHERE status = 'COMPLETED' AND "completedAt" >= ${sqlUtc(revenueChartStart)}
        GROUP BY 1 ORDER BY 1
      `,
      // Over-fetch by gross quantity, then net against returns and re-rank
      // below — a product's true top-5 rank can shift once returns count.
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { status: { in: FULFILLMENT_STATUSES } } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 20,
      }),
      this.prisma.salesReturnItem.groupBy({
        by: ['productId'],
        _sum: { quantity: true },
      }),
      this.getMonthlyKpis(),
      this.liquidCashService.getSummary(),
      this.creditBalanceService.getCurrentBalance(),
      this.creditsService.getUpcomingCheques(),
    ]);

    const returnedQtyByProduct = new Map(
      returnedQtyGrouped.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );
    const netTopProducts = topProductsGrouped
      .map((row) => ({
        productId: row.productId,
        quantitySold:
          (row._sum.quantity ?? 0) -
          (returnedQtyByProduct.get(row.productId) ?? 0),
      }))
      .sort((a, b) => b.quantitySold - a.quantitySold)
      .slice(0, 5);

    const topProductRecords = await this.prisma.product.findMany({
      where: { id: { in: netTopProducts.map((row) => row.productId) } },
      select: { id: true, name: true, productCode: true },
    });
    const topProductById = new Map(
      topProductRecords.map((product) => [product.id, product]),
    );
    const topProducts = netTopProducts.map((row) => ({
      product: topProductById.get(row.productId) ?? null,
      quantitySold: row.quantitySold,
    }));

    const todaysSales =
      Number(todaysSalesAgg._sum.totalAmount ?? 0) -
      Number(todaysReturnsAgg._sum.totalAmount ?? 0);

    return {
      todaysSales,
      todaysOrders,
      pendingApprovals,
      outOfStockItems,
      outstandingPayments: outstandingAgg._sum.outstandingBalance ?? 0,
      outstandingByDealer,
      recentOrders,
      monthlyRevenue,
      topProducts,
      ...monthlyKpis,
      invoiceDue: outstandingAgg._sum.outstandingBalance ?? 0,
      liquidCash: liquidCashSummary.balance,
      // All-time cleared dealer collections (cash/bank-transfer immediately,
      // cheque only once CLEARED) — same formula LiquidCashService already
      // uses for the Liquid Cash page, reused here rather than recomputed so
      // the two can never drift apart.
      totalCollected: liquidCashSummary.totalCollected,
      // Dealer cheques already recorded as payments (so no longer counted in
      // Outstanding Payments) but not yet cleared by the bank, so not yet
      // counted in Total Collected either — see LiquidCashService.getSummary.
      pendingDealerCheques: liquidCashSummary.pendingDealerCheques,
      creditBalance,
      upcomingCheques: upcomingCheques.cheques,
      chequesDueCount: upcomingCheques.dueCount,
      chequesDueTotal: upcomingCheques.dueTotal,
      chequesUpcomingCount: upcomingCheques.upcomingCount,
    };
  }

  async getDealerSummary(dealerId: string) {
    const dealer = await this.prisma.dealer.findUnique({
      where: { id: dealerId },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');

    const [pendingOrders, recentOrders, recentInvoices] = await Promise.all([
      this.prisma.order.count({
        where: { dealerId, status: OrderStatus.PENDING_APPROVAL },
      }),
      this.prisma.order.findMany({
        where: { dealerId },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.invoice.findMany({
        where: { dealerId },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      outstandingBalance: dealer.outstandingBalance,
      creditLimit: dealer.creditLimit,
      unlimitedCredit: dealer.unlimitedCredit,
      creditRemaining: dealer.creditLimit.sub(dealer.outstandingBalance),
      pendingOrders,
      recentOrders,
      recentInvoices,
    };
  }
}
