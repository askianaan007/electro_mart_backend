import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommissionLineStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const FULFILLMENT_STATUSES: OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

/**
 * Computes commission entirely out-of-band from the order pipeline
 * (version2_changes_backend.md §2 — "the one hard problem"). Only ever
 * reads Order/OrderItem/SalesReturn (already untouched by this project) and
 * writes to the new CommissionLedgerEntry table. Never calls OrdersService.
 */
@Injectable()
export class CommissionReconciliationService {
  private readonly logger = new Logger(CommissionReconciliationService.name);

  constructor(private prisma: PrismaService) {}

  /** Highest-priority match wins: an active campaign rule beats the standing/default rule. */
  private async resolveRule(productId: string, referenceDate: Date) {
    const candidates = await this.prisma.commissionRule.findMany({
      where: {
        productId,
        startDate: { lte: referenceDate },
        OR: [{ endDate: null }, { endDate: { gte: referenceDate } }],
      },
      orderBy: [{ isCampaign: 'desc' }, { startDate: 'desc' }],
      take: 1,
    });
    return candidates[0];
  }

  /** FIXED is interpreted as a fixed amount per unit sold; PERCENTAGE applies to the line's net total. */
  private computeAmount(
    rule: { type: string; value: Prisma.Decimal },
    item: { quantity: number; netLineTotal: Prisma.Decimal },
  ): Prisma.Decimal {
    if (rule.type === 'FIXED') {
      return rule.value.mul(item.quantity);
    }
    return item.netLineTotal.mul(rule.value).div(100);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile() {
    const created = await this.createLedgerEntriesForNewlyEligibleOrders();
    const reversed = await this.reverseEntriesForReturnedOrders();
    if (created > 0 || reversed > 0) {
      this.logger.log(
        `Commission reconciliation: created ${created} ledger entr(y/ies), reversed ${reversed}`,
      );
    }
    return { created, reversed };
  }

  private async createLedgerEntriesForNewlyEligibleOrders(): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: {
        createdByRepId: { not: null },
        status: { in: FULFILLMENT_STATUSES },
        commissionEntries: { none: {} },
      },
      include: { items: true },
      take: 200, // bounded batch per tick — the next tick picks up any remainder
    });

    let createdCount = 0;
    for (const order of orders) {
      if (!order.createdByRepId) continue; // narrows for TS; already filtered above
      const referenceDate = order.approvedAt ?? order.createdAt;

      const entries: Prisma.CommissionLedgerEntryCreateManyInput[] = [];
      for (const item of order.items) {
        const rule = await this.resolveRule(item.productId, referenceDate);
        if (!rule) continue; // no commission configured for this product — skip, not zero

        entries.push({
          representativeId: order.createdByRepId,
          orderId: order.id,
          orderItemId: item.id,
          productId: item.productId,
          commissionRuleId: rule.id,
          amount: this.computeAmount(rule, item),
          status: CommissionLineStatus.PENDING,
        });
      }

      if (entries.length === 0) continue;

      await this.prisma.$transaction(async (tx) => {
        await tx.commissionLedgerEntry.createMany({ data: entries });
      }, TRANSACTION_OPTIONS);
      createdCount += entries.length;
    }

    return createdCount;
  }

  private async reverseEntriesForReturnedOrders(): Promise<number> {
    // Only PENDING/APPROVED lines are eligible for reversal — a SETTLED line
    // has already been paid out and is never retroactively touched here.
    const affected = await this.prisma.commissionLedgerEntry.findMany({
      where: {
        status: {
          in: [CommissionLineStatus.PENDING, CommissionLineStatus.APPROVED],
        },
        order: { salesReturns: { some: {} } },
      },
      select: { id: true },
    });
    if (affected.length === 0) return 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.commissionLedgerEntry.updateMany({
        where: { id: { in: affected.map((e) => e.id) } },
        data: { status: CommissionLineStatus.REVERSED },
      });
    }, TRANSACTION_OPTIONS);

    return affected.length;
  }
}
