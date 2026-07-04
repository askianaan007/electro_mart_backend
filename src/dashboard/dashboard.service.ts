import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const FULFILLMENT_STATUSES: OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getAdminSummary() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const [
      todaysSalesAgg,
      todaysOrders,
      pendingApprovals,
      lowStockRows,
      outstandingAgg,
      recentOrders,
      monthlyRevenue,
      topProductsGrouped,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          status: OrderStatus.COMPLETED,
          completedAt: { gte: startOfToday },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.order.count({
        where: { status: OrderStatus.PENDING_APPROVAL },
      }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM "Product" WHERE "currentStock" <= "minimumStock"
      `,
      this.prisma.dealer.aggregate({ _sum: { outstandingBalance: true } }),
      this.prisma.order.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { dealer: { select: { businessName: true } } },
      }),
      this.prisma.$queryRaw<{ month: string; revenue: Prisma.Decimal }[]>`
        SELECT to_char(date_trunc('month', "completedAt"), 'YYYY-MM') as month, SUM("totalAmount") as revenue
        FROM "Order"
        WHERE status = 'COMPLETED' AND "completedAt" >= ${sixMonthsAgo}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { status: { in: FULFILLMENT_STATUSES } } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
    ]);

    const topProducts = await Promise.all(
      topProductsGrouped.map(async (row) => {
        const product = await this.prisma.product.findUnique({
          where: { id: row.productId },
          select: { id: true, name: true, productCode: true },
        });
        return { product, quantitySold: row._sum.quantity ?? 0 };
      }),
    );

    return {
      todaysSales: todaysSalesAgg._sum.totalAmount ?? 0,
      todaysOrders,
      pendingApprovals,
      lowStockItems: Number(lowStockRows[0]?.count ?? 0),
      outstandingPayments: outstandingAgg._sum.outstandingBalance ?? 0,
      recentOrders,
      monthlyRevenue,
      topProducts,
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
      creditRemaining: dealer.creditLimit.sub(dealer.outstandingBalance),
      pendingOrders,
      recentOrders,
      recentInvoices,
    };
  }
}
