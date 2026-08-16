import { Injectable } from '@nestjs/common';
import {
  CollectionStatus,
  CommissionLineStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryReportDto } from './dto/query-report.dto';

const ZERO = new Prisma.Decimal(0);

function dateRangeWhere(
  query: QueryReportDto,
): { gte?: Date; lte?: Date } | undefined {
  if (!query.dateFrom && !query.dateTo) return undefined;
  return {
    ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
    ...(query.dateTo && { lte: new Date(query.dateTo) }),
  };
}

/**
 * version2_changes_backend.md §17 — 100% read-only aggregation, reusing the
 * same groupBy/aggregate toolkit DashboardService/SalesAnalysisService
 * already use, pointed at Order.createdByRepId and this document's new
 * tables. No write path anywhere in this service.
 */
@Injectable()
export class RepReportsService {
  constructor(private prisma: PrismaService) {}

  async representativePerformance(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const grouped = await this.prisma.order.groupBy({
      by: ['createdByRepId'],
      where: { createdByRepId: { not: null }, ...(createdAt && { createdAt }) },
      _sum: { totalAmount: true },
      _count: true,
    });

    const reps = await this.prisma.representative.findMany({
      where: {
        id: { in: grouped.map((g) => g.createdByRepId!).filter(Boolean) },
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(reps.map((r) => [r.id, r.name]));

    return grouped
      .map((g) => ({
        representativeId: g.createdByRepId!,
        representativeName: nameById.get(g.createdByRepId!) ?? 'Unknown',
        orderCount: g._count,
        revenue: g._sum.totalAmount ?? ZERO,
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));
  }

  async collectionPerformance(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const grouped = await this.prisma.collectionSubmission.groupBy({
      by: ['representativeId', 'status'],
      where: createdAt ? { createdAt } : undefined,
      _sum: { amount: true },
      _count: true,
    });

    const reps = await this.prisma.representative.findMany({
      where: {
        id: { in: [...new Set(grouped.map((g) => g.representativeId))] },
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(reps.map((r) => [r.id, r.name]));

    const byRep = new Map<
      string,
      {
        representativeId: string;
        representativeName: string;
        confirmed: number;
        rejected: number;
        pending: number;
        confirmedAmount: Prisma.Decimal;
      }
    >();
    for (const g of grouped) {
      if (!byRep.has(g.representativeId)) {
        byRep.set(g.representativeId, {
          representativeId: g.representativeId,
          representativeName: nameById.get(g.representativeId) ?? 'Unknown',
          confirmed: 0,
          rejected: 0,
          pending: 0,
          confirmedAmount: ZERO,
        });
      }
      const row = byRep.get(g.representativeId)!;
      if (g.status === CollectionStatus.CONFIRMED) {
        row.confirmed = g._count;
        row.confirmedAmount = g._sum.amount ?? ZERO;
      } else if (g.status === CollectionStatus.REJECTED) {
        row.rejected = g._count;
      } else {
        row.pending = g._count;
      }
    }

    return [...byRep.values()];
  }

  async outstandingByRepresentative() {
    const grouped = await this.prisma.dealer.groupBy({
      by: ['createdByRepId'],
      where: { createdByRepId: { not: null } },
      _sum: { outstandingBalance: true },
      _count: true,
    });

    const reps = await this.prisma.representative.findMany({
      where: {
        id: { in: grouped.map((g) => g.createdByRepId!).filter(Boolean) },
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(reps.map((r) => [r.id, r.name]));

    return grouped
      .map((g) => ({
        representativeId: g.createdByRepId!,
        representativeName: nameById.get(g.createdByRepId!) ?? 'Unknown',
        customerCount: g._count,
        outstandingBalance: g._sum.outstandingBalance ?? ZERO,
      }))
      .sort(
        (a, b) => Number(b.outstandingBalance) - Number(a.outstandingBalance),
      );
  }

  async commissionSummary(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const grouped = await this.prisma.commissionLedgerEntry.groupBy({
      by: ['representativeId', 'status'],
      where: createdAt ? { createdAt } : undefined,
      _sum: { amount: true },
      _count: true,
    });

    const reps = await this.prisma.representative.findMany({
      where: {
        id: { in: [...new Set(grouped.map((g) => g.representativeId))] },
      },
      select: { id: true, name: true },
    });
    const nameById = new Map(reps.map((r) => [r.id, r.name]));

    const byRep = new Map<
      string,
      {
        representativeId: string;
        representativeName: string;
        pending: Prisma.Decimal;
        approved: Prisma.Decimal;
        settled: Prisma.Decimal;
        reversed: Prisma.Decimal;
      }
    >();
    for (const g of grouped) {
      if (!byRep.has(g.representativeId)) {
        byRep.set(g.representativeId, {
          representativeId: g.representativeId,
          representativeName: nameById.get(g.representativeId) ?? 'Unknown',
          pending: ZERO,
          approved: ZERO,
          settled: ZERO,
          reversed: ZERO,
        });
      }
      const row = byRep.get(g.representativeId)!;
      const amount = g._sum.amount ?? ZERO;
      if (g.status === CommissionLineStatus.PENDING) row.pending = amount;
      else if (g.status === CommissionLineStatus.APPROVED)
        row.approved = amount;
      else if (g.status === CommissionLineStatus.SETTLED) row.settled = amount;
      else if (g.status === CommissionLineStatus.REVERSED)
        row.reversed = amount;
    }

    return [...byRep.values()];
  }

  async settlementSummary(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const grouped = await this.prisma.representativeSettlement.groupBy({
      by: ['status'],
      where: createdAt ? { createdAt } : undefined,
      _sum: { totalCommission: true },
      _count: true,
    });

    return grouped.map((g) => ({
      status: g.status,
      count: g._count,
      totalCommission: g._sum.totalCommission ?? ZERO,
    }));
  }

  /** Same underlying condition as CollectionRemindersService — presented as an on-demand report rather than an email. */
  async overdueCollections() {
    const now = new Date();
    const orders = await this.prisma.order.findMany({
      where: {
        createdByRepId: { not: null },
        status: {
          in: [
            OrderStatus.APPROVED,
            OrderStatus.PACKED,
            OrderStatus.DELIVERED,
            OrderStatus.COMPLETED,
          ],
        },
        invoice: {
          paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
          dueDate: { lt: now },
        },
      },
      include: {
        invoice: {
          select: { invoiceNumber: true, grandTotal: true, dueDate: true },
        },
        dealer: { select: { businessName: true } },
        createdByRep: { select: { id: true, name: true } },
      },
      orderBy: { approvedAt: 'asc' },
    });

    return orders
      .filter((o) => o.invoice)
      .map((o) => ({
        orderId: o.id,
        orderNumber: o.orderNumber,
        customerName: o.dealer.businessName,
        representativeId: o.createdByRep?.id ?? null,
        representativeName: o.createdByRep?.name ?? 'Unknown',
        invoiceNumber: o.invoice!.invoiceNumber,
        outstandingAmount: o.invoice!.grandTotal,
        overdueDays: Math.floor(
          (now.getTime() - o.invoice!.dueDate!.getTime()) /
            (24 * 60 * 60 * 1000),
        ),
      }));
  }

  async returnedCheques(query: QueryReportDto) {
    const paymentDate = dateRangeWhere(query);
    const payments = await this.prisma.payment.findMany({
      where: { chequeStatus: 'RETURNED', ...(paymentDate && { paymentDate }) },
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            order: {
              select: { createdByRep: { select: { id: true, name: true } } },
            },
          },
        },
        dealer: { select: { businessName: true } },
      },
      orderBy: { chequeStatusUpdatedAt: 'desc' },
    });

    return payments.map((p) => ({
      paymentId: p.id,
      customerName: p.dealer.businessName,
      invoiceNumber: p.invoice?.invoiceNumber ?? null,
      representativeId: p.invoice?.order.createdByRep?.id ?? null,
      representativeName: p.invoice?.order.createdByRep?.name ?? null,
      chequeNumber: p.chequeNumber,
      bankName: p.bankName,
      amount: p.amount,
      chequeStatusUpdatedAt: p.chequeStatusUpdatedAt,
    }));
  }

  async salesByProduct(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const grouped = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: createdAt ? { order: { createdAt } } : undefined,
      _sum: { quantity: true, netLineTotal: true },
      _count: true,
    });

    const products = await this.prisma.product.findMany({
      where: { id: { in: grouped.map((g) => g.productId) } },
      select: { id: true, name: true, productCode: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return grouped
      .map((g) => ({
        productId: g.productId,
        productName: byId.get(g.productId)?.name ?? 'Unknown',
        productCode: byId.get(g.productId)?.productCode ?? '',
        quantitySold: g._sum.quantity ?? 0,
        revenue: g._sum.netLineTotal ?? ZERO,
        orderLineCount: g._count,
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue));
  }

  async salesByCategory(query: QueryReportDto) {
    const createdAt = dateRangeWhere(query);
    const items = await this.prisma.orderItem.findMany({
      where: createdAt ? { order: { createdAt } } : undefined,
      select: {
        quantity: true,
        netLineTotal: true,
        product: { select: { category: true } },
      },
    });

    const byCategory = new Map<
      string,
      { category: string; quantitySold: number; revenue: Prisma.Decimal }
    >();
    for (const item of items) {
      const category = item.product.category ?? 'Uncategorized';
      if (!byCategory.has(category)) {
        byCategory.set(category, { category, quantitySold: 0, revenue: ZERO });
      }
      const row = byCategory.get(category)!;
      row.quantitySold += item.quantity;
      row.revenue = row.revenue.add(item.netLineTotal);
    }

    return [...byCategory.values()].sort(
      (a, b) => Number(b.revenue) - Number(a.revenue),
    );
  }

  async salesByRepresentative(query: QueryReportDto) {
    return this.representativePerformance(query);
  }
}
