import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditsService } from '../credits/credits.service';
import { SalesAnalysisService } from '../sales-analysis/sales-analysis.service';

// Liquid Cash tracks actual bank balance: cash/bank-transfer payments move
// money immediately, but a cheque doesn't until it actually clears — while
// PENDING (or if it later bounces) the money hasn't left/entered the bank
// yet. Applies symmetrically to money going out (supplier payments) and
// money coming in (dealer payments/collections).
const SUPPLIER_CLEARED_FILTER: Prisma.SupplierPaymentWhereInput = {
  OR: [
    { mode: { not: 'CHEQUE' } },
    { mode: 'CHEQUE', chequeStatus: 'CLEARED' },
  ],
};
const DEALER_CLEARED_FILTER: Prisma.PaymentWhereInput = {
  OR: [
    { mode: { not: 'CHEQUE' } },
    { mode: 'CHEQUE', chequeStatus: 'CLEARED' },
  ],
};

const FULFILLMENT_STATUSES: OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

function pctChange(curr: number, prev: number): number {
  if (prev === 0) return curr === 0 ? 0 : 100;
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
  ) {}

  private async computeMonthlyFinancials(rangeStart: Date, rangeEnd: Date) {
    const [
      salesAnalysis,
      salesReturnAgg,
      purchaseAgg,
      purchaseReturnAgg,
      duePaymentsAgg,
      supplierPaymentsAgg,
    ] = await Promise.all([
      // Single source of truth for Net Sales/Profit: cost-of-goods-sold based
      // on completed orders in this range, shared with the Sales Analysis page.
      this.salesAnalysisService.getSummary({
        dateFrom: rangeStart.toISOString(),
        dateTo: rangeEnd.toISOString(),
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
      this.prisma.payment.aggregate({
        where: {
          paymentDate: { gte: rangeStart, lt: rangeEnd },
          ...DEALER_CLEARED_FILTER,
        },
        _sum: { amount: true },
      }),
      this.prisma.supplierPayment.aggregate({
        where: {
          paymentDate: { gte: rangeStart, lt: rangeEnd },
          ...SUPPLIER_CLEARED_FILTER,
        },
        _sum: { amount: true },
      }),
    ]);

    const netSales = toNumber(salesAnalysis.totalSales);
    const totalSalesReturn = toNumber(salesReturnAgg._sum.totalAmount);
    const grossPurchase = toNumber(purchaseAgg._sum.totalValue);
    const totalPurchaseReturn = toNumber(purchaseReturnAgg._sum.totalAmount);
    const netPurchase = grossPurchase - totalPurchaseReturn;
    const totalExpenses = toNumber(salesAnalysis.totalExpenses);
    const invoiceDuePayments = toNumber(duePaymentsAgg._sum.amount);
    const supplierPayments = toNumber(supplierPaymentsAgg._sum.amount);

    const netCashFlow = invoiceDuePayments - supplierPayments - totalExpenses;
    const profit = toNumber(salesAnalysis.netProfit);

    return {
      netSales,
      totalSalesReturn,
      totalPurchaseReturn,
      netPurchase,
      totalExpenses,
      invoiceDuePayments,
      netCashFlow,
      profit,
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

    const netSales = toNumber(salesAnalysis.totalSales);
    const totalSalesReturn = toNumber(salesReturnAgg._sum.totalAmount);
    const grossPurchase = toNumber(purchaseAgg._sum.totalValue);
    const totalPurchaseReturn = toNumber(purchaseReturnAgg._sum.totalAmount);
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

  /**
   * All-time cash-on-hand: investor contributions/withdrawals plus dealer
   * payments collected, minus supplier payments and expenses actually paid
   * out. Cheques on either side only count once they've actually cleared
   * (see SUPPLIER_CLEARED_FILTER / DEALER_CLEARED_FILTER) — a pending cheque
   * hasn't moved through the bank yet, and a returned one never will.
   */
  private async computeLiquidCash() {
    const [investmentAgg, paymentAgg, supplierPaymentAgg, expenseAgg] =
      await Promise.all([
        this.prisma.investment.aggregate({ _sum: { amount: true } }),
        this.prisma.payment.aggregate({
          where: DEALER_CLEARED_FILTER,
          _sum: { amount: true },
        }),
        this.prisma.supplierPayment.aggregate({
          where: SUPPLIER_CLEARED_FILTER,
          _sum: { amount: true },
        }),
        this.prisma.expense.aggregate({ _sum: { amount: true } }),
      ]);

    const totalInvestments = toNumber(investmentAgg._sum.amount);
    const totalCollected = toNumber(paymentAgg._sum.amount);
    const totalPaidToSuppliers = toNumber(supplierPaymentAgg._sum.amount);
    const totalExpensesPaid = toNumber(expenseAgg._sum.amount);

    return (
      totalInvestments +
      totalCollected -
      totalPaidToSuppliers -
      totalExpensesPaid
    );
  }

  private async getMonthlyKpis() {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

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
      netCashFlow: current.netCashFlow,
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
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

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
        ? new Date(earliestCompletedAt.getFullYear(), earliestCompletedAt.getMonth(), 1)
        : sixMonthsAgo;

    const [
      todaysSalesAgg,
      todaysReturnsAgg,
      todaysOrders,
      pendingApprovals,
      outOfStockItems,
      outstandingAgg,
      recentOrders,
      monthlyRevenue,
      topProductsGrouped,
      returnedQtyGrouped,
      monthlyKpis,
      liquidCash,
      creditsSummary,
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
      this.prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { dealer: { select: { businessName: true } } },
      }),
      this.prisma.$queryRaw<{ month: string; revenue: Prisma.Decimal }[]>`
        SELECT to_char(date_trunc('month', "completedAt"), 'YYYY-MM') as month, SUM("totalAmount") as revenue
        FROM "Order"
        WHERE status = 'COMPLETED' AND "completedAt" >= ${revenueChartStart}
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
      this.computeLiquidCash(),
      this.creditsService.getSummary(),
      this.creditsService.getUpcomingCheques(),
    ]);

    const returnedQtyByProduct = new Map(
      returnedQtyGrouped.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );
    const netTopProducts = topProductsGrouped
      .map((row) => ({
        productId: row.productId,
        quantitySold: (row._sum.quantity ?? 0) - (returnedQtyByProduct.get(row.productId) ?? 0),
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
      Number(todaysSalesAgg._sum.totalAmount ?? 0) - Number(todaysReturnsAgg._sum.totalAmount ?? 0);

    return {
      todaysSales,
      todaysOrders,
      pendingApprovals,
      outOfStockItems,
      outstandingPayments: outstandingAgg._sum.outstandingBalance ?? 0,
      recentOrders,
      monthlyRevenue,
      topProducts,
      ...monthlyKpis,
      invoiceDue: outstandingAgg._sum.outstandingBalance ?? 0,
      liquidCash,
      creditBalance: creditsSummary.totals.totalCreditBalance,
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
