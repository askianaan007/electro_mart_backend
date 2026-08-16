import { Injectable } from '@nestjs/common';
import { CommissionLineStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

const ZERO = new Prisma.Decimal(0);

/**
 * A representative's own "My Earnings" view (version2_changes_backend.md
 * §10) — read-only aggregation over CommissionLedgerEntry/
 * RepresentativeSettlement, always scoped to the caller's own
 * representativeId (never a client-supplied id).
 */
@Injectable()
export class RepEarningsService {
  constructor(private prisma: PrismaService) {}

  async getSummary(representativeId: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(
      startOfToday.getFullYear(),
      startOfToday.getMonth(),
      1,
    );

    const [
      totalSalesAgg,
      todaysSalesAgg,
      monthlySalesAgg,
      completedSalesAgg,
      pendingSalesCount,
      pendingCommissionAgg,
      approvedCommissionAgg,
      settledCommissionAgg,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: { createdByRepId: representativeId },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          createdByRepId: representativeId,
          createdAt: { gte: startOfToday },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          createdByRepId: representativeId,
          createdAt: { gte: startOfMonth },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.aggregate({
        where: {
          createdByRepId: representativeId,
          status: OrderStatus.COMPLETED,
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({
        where: {
          createdByRepId: representativeId,
          status: OrderStatus.PENDING_APPROVAL,
        },
      }),
      this.prisma.commissionLedgerEntry.aggregate({
        where: { representativeId, status: CommissionLineStatus.PENDING },
        _sum: { amount: true },
      }),
      this.prisma.commissionLedgerEntry.aggregate({
        where: { representativeId, status: CommissionLineStatus.APPROVED },
        _sum: { amount: true },
      }),
      this.prisma.commissionLedgerEntry.aggregate({
        where: { representativeId, status: CommissionLineStatus.SETTLED },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalSales: totalSalesAgg._sum.totalAmount ?? ZERO,
      todaysSales: todaysSalesAgg._sum.totalAmount ?? ZERO,
      monthlySales: monthlySalesAgg._sum.totalAmount ?? ZERO,
      completedSales: completedSalesAgg._sum.totalAmount ?? ZERO,
      pendingApprovalSalesCount: pendingSalesCount,
      commissionPending: pendingCommissionAgg._sum.amount ?? ZERO,
      commissionApproved: approvedCommissionAgg._sum.amount ?? ZERO,
      commissionPaid: settledCommissionAgg._sum.amount ?? ZERO,
      commissionEarned: [
        pendingCommissionAgg,
        approvedCommissionAgg,
        settledCommissionAgg,
      ].reduce((sum, agg) => sum.add(agg._sum.amount ?? ZERO), ZERO),
    };
  }

  async getLedger(representativeId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CommissionLedgerEntryWhereInput = { representativeId };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.commissionLedgerEntry.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, productCode: true } },
          order: { select: { id: true, orderNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.commissionLedgerEntry.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async getSettlementHistory(
    representativeId: string,
    query: PaginationQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.RepresentativeSettlementWhereInput = {
      representativeId,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.representativeSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representativeSettlement.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  /** CSV export of a period's ledger — no server-side PDF pipeline exists in this codebase to mirror (see CommissionController.receipt). */
  async getStatementCsv(
    representativeId: string,
    from?: string,
    to?: string,
  ): Promise<string> {
    const where: Prisma.CommissionLedgerEntryWhereInput = {
      representativeId,
      ...((from || to) && {
        createdAt: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) }),
        },
      }),
    };

    const lines = await this.prisma.commissionLedgerEntry.findMany({
      where,
      include: {
        product: { select: { name: true, productCode: true } },
        order: { select: { orderNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const header = 'Date,Order,Product,Amount,Status\n';
    const rows = lines.map((line) =>
      [
        line.createdAt.toISOString().slice(0, 10),
        line.order.orderNumber,
        `"${line.product.name.replace(/"/g, '""')}"`,
        line.amount.toString(),
        line.status,
      ].join(','),
    );
    const totalsRow = `Total,,,${lines.reduce((sum, l) => sum.add(l.amount), ZERO).toString()},`;

    return header + rows.join('\n') + (rows.length > 0 ? '\n' : '') + totalsRow;
  }
}
