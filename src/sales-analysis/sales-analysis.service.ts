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

type RangeFilter = {
  dateFrom?: string;
  dateTo?: string;
  dealerId?: string;
  search?: string;
};

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
      ...(query.search && {
        OR: [
          { orderNumber: { contains: query.search, mode: 'insensitive' } },
          {
            dealer: {
              businessName: { contains: query.search, mode: 'insensitive' },
            },
          },
        ],
      }),
    };
  }

  /**
   * A completed order that later has a sales return recorded against it
   * should no longer show its pre-return selling price/profit here — a
   * return unwinds both the revenue and the cost of the returned units.
   * Batched into one query per call site rather than looked up per-order.
   */
  private async fetchReturnsByOrder(orderIds: string[]) {
    const map = new Map<
      string,
      { returnedSelling: Prisma.Decimal; returnedCost: Prisma.Decimal }
    >();
    if (orderIds.length === 0) return map;

    const returnItems = await this.prisma.salesReturnItem.findMany({
      where: { salesReturn: { orderId: { in: orderIds } } },
      include: {
        product: { select: { costPrice: true } },
        salesReturn: { select: { orderId: true } },
      },
    });

    for (const item of returnItems) {
      const orderId = item.salesReturn.orderId;
      const existing = map.get(orderId) ?? {
        returnedSelling: ZERO,
        returnedCost: ZERO,
      };
      map.set(orderId, {
        returnedSelling: existing.returnedSelling.add(item.lineTotal),
        returnedCost: existing.returnedCost.add(
          item.product.costPrice.mul(item.quantity),
        ),
      });
    }
    return map;
  }

  private toRow(
    order: OrderWithRelations,
    returns?: { returnedSelling: Prisma.Decimal; returnedCost: Prisma.Decimal },
  ) {
    const grossBuyingPrice = order.items.reduce(
      (sum, item) => sum.add(item.product.costPrice.mul(item.quantity)),
      ZERO,
    );
    const sellingPrice = order.totalAmount.sub(
      returns?.returnedSelling ?? ZERO,
    );
    const buyingPrice = grossBuyingPrice.sub(returns?.returnedCost ?? ZERO);
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

    const returnsByOrder = await this.fetchReturnsByOrder(
      orders.map((o) => o.id),
    );

    return paginate(
      orders.map((o) => this.toRow(o, returnsByOrder.get(o.id))),
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

    const returnsByOrder = await this.fetchReturnsByOrder(
      orders.map((o) => o.id),
    );
    const rows = orders.map((o) => this.toRow(o, returnsByOrder.get(o.id)));
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
