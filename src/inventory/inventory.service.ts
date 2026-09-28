import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLog, InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { QueryLedgerDto } from './dto/query-ledger.dto';

type TransactionClient = Prisma.TransactionClient;

// `InventoryLog.reference` is heterogeneous by design (see recordMovement
// call sites): sometimes a UUID pointing at the Purchase/Order/SalesReturn/
// PurchaseReturn that caused the movement, sometimes an already-readable
// string ('Opening stock', 'Reversed for edit of purchase INV-123', a
// manual adjustment's admin-supplied reason). Only the UUID case needs a
// lookup to become readable.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async recordMovement(
    tx: TransactionClient,
    params: {
      productId: string;
      type: InventoryLogType;
      quantityIn?: number;
      quantityOut?: number;
      reference?: string;
    },
  ) {
    const quantityIn = params.quantityIn ?? 0;
    const quantityOut = params.quantityOut ?? 0;
    const netDelta = quantityIn - quantityOut;

    // Single atomic conditional UPDATE (check-and-write in one statement)
    // instead of a separate read-then-validate-then-write — two concurrent
    // movements against the same product can no longer both read the same
    // stale currentStock, both pass the non-negative guard, and both commit
    // (which would otherwise let currentStock go negative under Postgres's
    // default read-committed isolation). The WHERE clause re-checks the
    // invariant against the row Postgres is actually about to write, under
    // that row's lock, so a second concurrent update genuinely waits for the
    // first to commit before it can even evaluate the condition.
    const affected = await tx.$executeRaw`
      UPDATE "Product"
      SET "currentStock" = "currentStock" + ${netDelta}, "updatedAt" = NOW()
      WHERE id = ${params.productId} AND "currentStock" + ${netDelta} >= 0
    `;

    if (affected === 0) {
      const product = await tx.product.findUnique({
        where: { id: params.productId },
      });
      if (!product)
        throw new NotFoundException(`Product ${params.productId} not found`);
      throw new BadRequestException(
        `Insufficient stock for product "${product.name}"`,
      );
    }

    const updated = await tx.product.findUniqueOrThrow({
      where: { id: params.productId },
    });

    await tx.inventoryLog.create({
      data: {
        productId: params.productId,
        type: params.type,
        quantityIn,
        quantityOut,
        balanceAfter: updated.currentStock,
        reference: params.reference,
      },
    });

    return updated;
  }

  async listStock(query: QueryInventoryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ProductWhereInput = {
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { productCode: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...(query.status === 'OUT_OF_STOCK' && { currentStock: { lte: 0 } }),
      ...(query.status === 'IN_STOCK' && { currentStock: { gt: 0 } }),
    };

    const [products, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: {
          id: true,
          productCode: true,
          name: true,
          currentStock: true,
          updatedAt: true,
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const data = products.map((product) => ({
      ...product,
      status: product.currentStock <= 0 ? 'OUT_OF_STOCK' : 'IN_STOCK',
    }));

    return paginate(data, total, page, limit);
  }

  async getLedger(productId: string, query: QueryLedgerDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InventoryLogWhereInput = {
      productId,
      ...(query.type && { type: query.type }),
      ...((query.dateFrom || query.dateTo) && {
        createdAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.inventoryLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryLog.count({ where }),
    ]);

    const enriched = await this.enrichLedgerEntries(data);

    return paginate(enriched, total, page, limit);
  }

  /**
   * Resolves each row's raw `reference` (and, where derivable, the admin/
   * dealer/rep behind it) into display-ready fields, without needing a
   * schema change: a UUID reference is looked up against whichever table
   * that movement type could plausibly point to, and the actor for
   * return-driven and manual rows is recovered from ActivityLog — which
   * for returns records the exact same id as `targetId`, and for manual
   * adjustments/opening stock shares the same transaction (hence the same
   * DB-generated `createdAt`) as the InventoryLog row it explains.
   */
  private async enrichLedgerEntries(logs: InventoryLog[]) {
    if (logs.length === 0) return [];

    const uuidRefs = [
      ...new Set(
        logs
          .map((l) => l.reference)
          .filter((r): r is string => !!r && UUID_RE.test(r)),
      ),
    ];
    const productIds = [...new Set(logs.map((l) => l.productId))];

    const [
      purchases,
      orders,
      salesReturns,
      purchaseReturns,
      replacementReceipts,
      activityLogs,
    ] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where: { id: { in: uuidRefs } },
        select: {
          id: true,
          invoiceNumber: true,
          supplier: { select: { name: true } },
          admin: { select: { name: true } },
        },
      }),
      this.prisma.order.findMany({
        where: { id: { in: uuidRefs } },
        select: {
          id: true,
          orderNumber: true,
          dealer: { select: { businessName: true } },
          approvedByAdmin: { select: { name: true } },
          createdByAdmin: { select: { name: true } },
          createdByRep: { select: { name: true } },
        },
      }),
      this.prisma.salesReturn.findMany({
        where: { id: { in: uuidRefs } },
        select: {
          id: true,
          returnNumber: true,
          dealer: { select: { businessName: true } },
          order: { select: { orderNumber: true } },
        },
      }),
      this.prisma.purchaseReturn.findMany({
        where: { id: { in: uuidRefs } },
        select: {
          id: true,
          returnNumber: true,
          supplier: { select: { name: true } },
        },
      }),
      this.prisma.purchaseReturnReplacement.findMany({
        where: { id: { in: uuidRefs } },
        select: {
          id: true,
          replacementNumber: true,
          supplier: { select: { name: true } },
          purchaseReturn: { select: { returnNumber: true } },
          admin: { select: { name: true } },
        },
      }),
      this.prisma.activityLog.findMany({
        where: {
          OR: [
            { targetId: { in: uuidRefs } },
            {
              targetId: { in: productIds },
              action: { in: ['ADJUSTED_INVENTORY', 'CREATED_PRODUCT'] },
            },
          ],
        },
        select: {
          targetId: true,
          createdAt: true,
          admin: { select: { name: true } },
        },
      }),
    ]);

    const purchaseMap = new Map(purchases.map((p) => [p.id, p]));
    const orderMap = new Map(orders.map((o) => [o.id, o]));
    const salesReturnMap = new Map(salesReturns.map((s) => [s.id, s]));
    const purchaseReturnMap = new Map(purchaseReturns.map((p) => [p.id, p]));
    const replacementMap = new Map(replacementReceipts.map((r) => [r.id, r]));

    const activityByTarget = new Map<string, typeof activityLogs>();
    for (const log of activityLogs) {
      if (!log.targetId) continue;
      const list = activityByTarget.get(log.targetId) ?? [];
      list.push(log);
      activityByTarget.set(log.targetId, list);
    }

    // targetId alone isn't unique per movement for returns (fine, resolved
    // directly) or for manual/opening-stock rows (many adjustments share the
    // same product id) — closest-by-time picks the one written in the same
    // transaction as this ledger row.
    const closestActorName = (targetId: string, createdAt: Date) => {
      const candidates = activityByTarget.get(targetId);
      if (!candidates || candidates.length === 0) return null;
      const closest = candidates.reduce((best, cur) =>
        Math.abs(cur.createdAt.getTime() - createdAt.getTime()) <
        Math.abs(best.createdAt.getTime() - createdAt.getTime())
          ? cur
          : best,
      );
      return closest.admin?.name ? `Admin: ${closest.admin.name}` : null;
    };

    return logs.map((log) => {
      const ref = log.reference;
      let description = ref ?? '—';
      let performedBy: string | null = null;

      if (ref && UUID_RE.test(ref)) {
        const purchase = purchaseMap.get(ref);
        const order = orderMap.get(ref);
        const salesReturn = salesReturnMap.get(ref);
        const purchaseReturn = purchaseReturnMap.get(ref);
        const replacement = replacementMap.get(ref);

        if (purchase) {
          description = `Purchase invoice #${purchase.invoiceNumber} — ${purchase.supplier.name}`;
          performedBy = purchase.admin?.name
            ? `Admin: ${purchase.admin.name}`
            : null;
        } else if (order) {
          description = `Order #${order.orderNumber} — ${order.dealer.businessName}`;
          const adminName =
            order.approvedByAdmin?.name ?? order.createdByAdmin?.name;
          performedBy = adminName
            ? `Admin: ${adminName}`
            : order.createdByRep?.name
              ? `Rep: ${order.createdByRep.name}`
              : null;
        } else if (salesReturn) {
          description = `Sales return #${salesReturn.returnNumber} — ${salesReturn.dealer.businessName} (order #${salesReturn.order.orderNumber})`;
          performedBy = closestActorName(ref, log.createdAt);
        } else if (purchaseReturn) {
          description = `Purchase return #${purchaseReturn.returnNumber} — ${purchaseReturn.supplier.name}`;
          performedBy = closestActorName(ref, log.createdAt);
        } else if (replacement) {
          description = `Replacement receipt #${replacement.replacementNumber} — ${replacement.supplier.name} (for return #${replacement.purchaseReturn.returnNumber})`;
          performedBy = replacement.admin?.name
            ? `Admin: ${replacement.admin.name}`
            : null;
        }
      } else if (ref) {
        performedBy = closestActorName(log.productId, log.createdAt);
      }

      return { ...log, description, performedBy };
    });
  }

  async adjustStock(dto: AdjustStockDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const product = await this.recordMovement(tx, {
        productId: dto.productId,
        type: InventoryLogType.ADJUSTMENT,
        quantityIn: dto.direction === 'IN' ? dto.quantity : 0,
        quantityOut: dto.direction === 'OUT' ? dto.quantity : 0,
        reference: dto.reason,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'ADJUSTED_INVENTORY',
        targetId: product.id,
        details: `Stock ${dto.direction === 'IN' ? 'increased' : 'decreased'} by ${dto.quantity} for ${product.name}${dto.reason ? ` (${dto.reason})` : ''}`,
      });

      return product;
    }, TRANSACTION_OPTIONS);
  }
}
