import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuerySalesAnalysisDto } from './dto/query-sales-analysis.dto';
import { paginate } from '../common/utils/paginate';

const ZERO = new Prisma.Decimal(0);

const ORDER_INCLUDE = {
  items: { include: { product: true } },
  dealer: { select: { id: true, businessName: true } },
  invoice: { select: { invoiceNumber: true } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

type RangeFilter = { dateFrom?: string; dateTo?: string; dealerId?: string };

@Injectable()
export class SalesAnalysisService {
  constructor(private prisma: PrismaService) {}

  private buildWhere(query: RangeFilter): Prisma.OrderWhereInput {
    return {
      status: OrderStatus.COMPLETED,
      ...(query.dealerId && { dealerId: query.dealerId }),
      ...((query.dateFrom || query.dateTo) && {
        completedAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
    };
  }

  private toRow(order: OrderWithRelations) {
    const buyingPrice = order.items.reduce(
      (sum, item) => sum.add(item.product.costPrice.mul(item.quantity)),
      ZERO,
    );
    const sellingPrice = order.totalAmount;
    const profit = sellingPrice.sub(buyingPrice);
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      invoiceNumber: order.invoice?.invoiceNumber ?? null,
      dealerId: order.dealer.id,
      dealerName: order.dealer.businessName,
      date: order.completedAt,
      sellingPrice,
      buyingPrice,
      profit,
    };
  }

  async findAll(query: QuerySalesAnalysisDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildWhere(query);

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { completedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(
      orders.map((o) => this.toRow(o)),
      total,
      page,
      limit,
    );
  }

  async getSummary(query: RangeFilter) {
    const where = this.buildWhere(query);

    const orders = await this.prisma.order.findMany({
      where,
      include: ORDER_INCLUDE,
    });

    const rows = orders.map((o) => this.toRow(o));
    const totalSales = rows.reduce((sum, r) => sum.add(r.sellingPrice), ZERO);
    const totalBuying = rows.reduce((sum, r) => sum.add(r.buyingPrice), ZERO);
    const totalProfit = rows.reduce((sum, r) => sum.add(r.profit), ZERO);

    const expenseWhere: Prisma.ExpenseWhereInput = {
      ...((query.dateFrom || query.dateTo) && {
        expenseDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
    };
    const expenseAgg = await this.prisma.expense.aggregate({
      where: expenseWhere,
      _sum: { amount: true },
    });
    const totalExpenses = expenseAgg._sum.amount ?? ZERO;
    const netProfit = totalProfit.sub(totalExpenses);

    return {
      orderCount: rows.length,
      totalSales,
      totalBuying,
      totalProfit,
      totalExpenses,
      netProfit,
    };
  }
}
