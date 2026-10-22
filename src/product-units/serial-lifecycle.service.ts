import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  OrderStatus,
  Prisma,
  ProductUnitCondition,
  ProductUnitEventType,
  ProductUnitSource,
  ProductUnitStatus,
} from '@prisma/client';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { addMonths, NormalizedSerial } from '../common/utils/serial';

type Tx = Prisma.TransactionClient;

/**
 * Every serial state change, run inside the caller's transaction
 * (Bar_code_plan.md §6). Deliberately has no InventoryService: nothing here
 * can move stock. Existing flows keep their own recordMovement() calls
 * untouched and call into this service beside them, so a refusal here rolls
 * the whole document back.
 */

const UNDELIVERED: OrderStatus[] = [OrderStatus.APPROVED, OrderStatus.PACKED];
const DELIVERED: OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED];
const ASSIGNABLE: OrderStatus[] = [...UNDELIVERED, ...DELIVERED];
const ON_SHELF: ProductUnitStatus[] = [
  ProductUnitStatus.IN_STOCK,
  ProductUnitStatus.ALLOCATED,
];

// Events created in one transaction would otherwise share a timestamp; the
// timeline and the "latest event" reversal check need a strict order.
let lastStamp = 0;
function eventStamp(): Date {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp);
}

export interface OrderContext {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  dealerId: string;
  deliveredAt: Date | null;
  completedAt: Date | null;
  dealer: { businessName: string };
  invoice: { invoiceNumber: string } | null;
  items: {
    productId: string;
    quantity: number;
    netUnitPrice: Prisma.Decimal;
  }[];
}

export interface SalesReturnSerialPick {
  serial: NormalizedSerial;
  condition: ProductUnitCondition;
  faultNote?: string;
}

interface EventInput {
  type: ProductUnitEventType;
  adminId: string;
  documentId?: string | null;
  documentRef?: string | null;
  partyName?: string | null;
  reason?: string | null;
  faultNote?: string | null;
  eventDate?: Date;
  amount?: Prisma.Decimal | null;
  details?: string | null;
}

export interface ShelfState {
  productId: string;
  name: string;
  currentStock: number;
  reserved: number;
  held: number;
  serialsHeld: number;
  gap: number;
}

@Injectable()
export class SerialLifecycleService {
  constructor(private activityLogService: ActivityLogService) {}

  // ---------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------

  async addEvent(
    tx: Tx,
    unit: {
      id: string;
      status: ProductUnitStatus;
      condition: ProductUnitCondition;
    },
    input: EventInput,
  ) {
    return tx.productUnitEvent.create({ data: this.eventData(unit, input) });
  }

  /** One round trip for many events — each still gets its own ordered stamp. */
  async addEvents(
    tx: Tx,
    entries: {
      unit: {
        id: string;
        status: ProductUnitStatus;
        condition: ProductUnitCondition;
      };
      input: EventInput;
    }[],
  ) {
    if (entries.length === 0) return;
    await tx.productUnitEvent.createMany({
      data: entries.map((e) => this.eventData(e.unit, e.input)),
    });
  }

  private eventData(
    unit: {
      id: string;
      status: ProductUnitStatus;
      condition: ProductUnitCondition;
    },
    input: EventInput,
  ): Prisma.ProductUnitEventUncheckedCreateInput {
    return {
      unitId: unit.id,
      type: input.type,
      documentId: input.documentId ?? null,
      documentRef: input.documentRef ?? null,
      partyName: input.partyName ?? null,
      reason: input.reason ?? null,
      faultNote: input.faultNote ?? null,
      statusAfter: unit.status,
      conditionAfter: unit.condition,
      eventDate: input.eventDate ?? new Date(),
      amount: input.amount ?? null,
      details: input.details ?? null,
      adminId: input.adminId,
      createdAt: eventStamp(),
    };
  }

  /** Row-locks products in a fixed order (same lock recordMovement's UPDATE takes). */
  async lockProducts(tx: Tx, productIds: string[]) {
    const ids = [...new Set(productIds)].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  }

  async lockUnits(tx: Tx, unitIds: string[]) {
    const ids = [...new Set(unitIds)].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT id FROM "ProductUnit" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  }

  async lockOrder(tx: Tx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  }

  /**
   * Conditional state change: only rows still in one of `fromStatuses` (and
   * matching `extraWhere`) move. A count mismatch means another request got
   * there first, so the whole transaction is refused.
   */
  private async transition(
    tx: Tx,
    unitIds: string[],
    fromStatuses: ProductUnitStatus[],
    data: Prisma.ProductUnitUncheckedUpdateManyInput,
    extraWhere: Prisma.ProductUnitWhereInput = {},
  ) {
    if (unitIds.length === 0) return;
    const result = await tx.productUnit.updateMany({
      where: {
        id: { in: unitIds },
        status: { in: fromStatuses },
        ...extraWhere,
      },
      data,
    });
    if (result.count !== unitIds.length) {
      throw new ConflictException(
        'One or more serials changed while this request was running — reload and try again',
      );
    }
  }

  async loadOrderContext(tx: Tx, orderId: string): Promise<OrderContext> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        dealerId: true,
        deliveredAt: true,
        completedAt: true,
        dealer: { select: { businessName: true } },
        invoice: { select: { invoiceNumber: true } },
        items: {
          select: { productId: true, quantity: true, netUnitPrice: true },
        },
      },
    });
    if (!order) throw new BadRequestException('Order not found');
    return order;
  }

  private orderRef(order: OrderContext) {
    return order.invoice
      ? `${order.orderNumber} / ${order.invoice.invoiceNumber}`
      : order.orderNumber;
  }

  // ---------------------------------------------------------------------
  // Shelf invariant (§6.2): serial units physically here never exceed the
  // units physically here. H = currentStock + reserved on undelivered
  // orders; T = IN_STOCK + ALLOCATED units; gap = H − T.
  // ---------------------------------------------------------------------

  async shelfState(tx: Tx, productId: string): Promise<ShelfState> {
    const [row] = await tx.$queryRaw<
      {
        name: string;
        currentStock: number;
        reserved: number;
        serialsHeld: number;
      }[]
    >`SELECT p.name, p."currentStock",
        COALESCE((SELECT SUM(oi.quantity) FROM "OrderItem" oi
                  JOIN "Order" o ON o.id = oi."orderId"
                  WHERE oi."productId" = p.id
                    AND o.status::text = ANY(${UNDELIVERED}::text[])), 0)::int AS reserved,
        (SELECT COUNT(*) FROM "ProductUnit" u
         WHERE u."productId" = p.id
           AND u.status::text = ANY(${ON_SHELF}::text[]))::int AS "serialsHeld"
      FROM "Product" p WHERE p.id = ${productId}`;
    if (!row) throw new BadRequestException('Product not found');
    const held = row.currentStock + row.reserved;
    return {
      productId,
      name: row.name,
      currentStock: row.currentStock,
      reserved: row.reserved,
      held,
      serialsHeld: row.serialsHeld,
      gap: held - row.serialsHeld,
    };
  }

  /** shelfState().gap for every tracked product in one query; only those still missing serials. */
  async missingCounts(
    tx: Tx,
  ): Promise<{ productId: string; missing: number }[]> {
    return tx.$queryRaw<{ productId: string; missing: number }[]>`
      SELECT id AS "productId", missing FROM (
        SELECT p.id,
          (p."currentStock"
            + COALESCE((SELECT SUM(oi.quantity) FROM "OrderItem" oi
                        JOIN "Order" o ON o.id = oi."orderId"
                        WHERE oi."productId" = p.id
                          AND o.status::text = ANY(${UNDELIVERED}::text[])), 0)
            - (SELECT COUNT(*) FROM "ProductUnit" u
               WHERE u."productId" = p.id
                 AND u.status::text = ANY(${ON_SHELF}::text[])))::int AS missing
        FROM "Product" p WHERE p."trackSerials" = true
      ) t WHERE missing > 0`;
  }

  /**
   * Wraps an existing stock-moving operation. Only products that are tracked
   * or already have units take part — for everything else this is a no-op
   * (no locks, no queries beyond one lookup), so untracked products behave
   * exactly as before. Refuses when the operation leaves more serial units
   * on the shelf than physical units and made that worse.
   */
  async beginShelfGuard(tx: Tx, productIds: string[]) {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return { assert: async () => {} };
    const relevant = await tx.product.findMany({
      where: {
        id: { in: ids },
        OR: [{ trackSerials: true }, { units: { some: {} } }],
      },
      select: { id: true },
    });
    if (relevant.length === 0) return { assert: async () => {} };

    const relevantIds = relevant.map((p) => p.id);
    await this.lockProducts(tx, relevantIds);
    const before = new Map<string, number>();
    for (const id of relevantIds) {
      before.set(id, (await this.shelfState(tx, id)).gap);
    }

    return {
      assert: async () => {
        for (const id of relevantIds) {
          const after = await this.shelfState(tx, id);
          const gapBefore = before.get(id) ?? 0;
          if (after.gap < 0 && after.gap < gapBefore) {
            throw new BadRequestException(
              `${-after.gap} serial number(s) of "${after.name}" would be left in stock with no physical unit behind them — select which serials leave stock with this change`,
            );
          }
        }
      },
    };
  }

  /** For registrations, which add serials with no stock movement: gap must stay ≥ 0. */
  private async assertShelfRoom(tx: Tx, productId: string) {
    const state = await this.shelfState(tx, productId);
    if (state.gap < 0) {
      throw new BadRequestException(
        `"${state.name}" has ${state.held} unit(s) physically in stock (including ones reserved for orders), so at most ${state.held} can carry serials — this would make ${state.serialsHeld}. Record the stock first (purchase or stock adjustment), then register the serials.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  /** Product codes/barcodes a scanned value could be confused with (§4.4). */
  async findModelBarcodeClashes(tx: Tx, keys: string[]) {
    if (keys.length === 0)
      return new Map<string, { id: string; name: string }>();
    const rows = await tx.$queryRaw<
      {
        id: string;
        name: string;
        barcode: string | null;
        sku: string | null;
        productCode: string;
      }[]
    >`SELECT id, name, barcode, sku, "productCode" FROM "Product"
      WHERE upper(replace(coalesce(barcode, ''), ' ', '')) = ANY(${keys}::text[])
         OR upper(replace(coalesce(sku, ''), ' ', '')) = ANY(${keys}::text[])
         OR upper(replace("productCode", ' ', '')) = ANY(${keys}::text[])`;
    const clashes = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      for (const value of [row.barcode, row.sku, row.productCode]) {
        if (!value) continue;
        const key = value.replace(/\s+/g, '').toUpperCase();
        if (keys.includes(key))
          clashes.set(key, { id: row.id, name: row.name });
      }
    }
    return clashes;
  }

  /**
   * Creates IN_STOCK units. Refuses duplicates, model barcodes, and — unless
   * `skipShelfCheck` (a unit going straight onto a delivered order) — more
   * serials than physical units.
   */
  async registerUnits(
    tx: Tx,
    params: {
      productId: string;
      serials: NormalizedSerial[];
      source: ProductUnitSource;
      receivedAt: Date;
      adminId: string;
      purchaseId?: string;
      replacementId?: string;
      replacesUnitId?: string;
      documentRef?: string;
      partyName?: string;
      reason?: string;
      amount?: Prisma.Decimal | null;
      skipShelfCheck?: boolean;
    },
  ) {
    if (params.serials.length === 0) return [];
    await this.lockProducts(tx, [params.productId]);
    const product = await tx.product.findUnique({
      where: { id: params.productId },
      select: { id: true, name: true },
    });
    if (!product) throw new BadRequestException('Product not found');

    const keys = params.serials.map((s) => s.serialKey);
    const existing = await tx.productUnit.findMany({
      where: { productId: params.productId, serialKey: { in: keys } },
      select: { serialNumber: true },
    });
    if (existing.length > 0) {
      throw new BadRequestException(
        `Serial(s) already registered for "${product.name}": ${existing.map((u) => u.serialNumber).join(', ')}`,
      );
    }
    const clashes = await this.findModelBarcodeClashes(tx, keys);
    if (clashes.size > 0) {
      const [key, clash] = [...clashes.entries()][0];
      throw new BadRequestException(
        `${key} is the model barcode/code of "${clash.name}", not a unit serial — scan the serial number label instead`,
      );
    }

    const units = params.serials.map((serial) => ({
      id: randomUUID(),
      serialNumber: serial.serialNumber,
      status: ProductUnitStatus.IN_STOCK,
      condition: ProductUnitCondition.GOOD,
      serialKey: serial.serialKey,
    }));
    await tx.productUnit.createMany({
      data: units.map((unit) => ({
        id: unit.id,
        productId: params.productId,
        serialNumber: unit.serialNumber,
        serialKey: unit.serialKey,
        status: unit.status,
        condition: unit.condition,
        source: params.source,
        receivedAt: params.receivedAt,
        purchaseId: params.purchaseId ?? null,
        replacementId: params.replacementId ?? null,
        replacesUnitId: params.replacesUnitId ?? null,
        createdByAdminId: params.adminId,
      })),
    });
    await this.addEvents(
      tx,
      units.map((unit) => ({
        unit,
        input: {
          type: ProductUnitEventType.REGISTERED,
          adminId: params.adminId,
          documentId: params.purchaseId ?? params.replacementId ?? null,
          documentRef: params.documentRef,
          partyName: params.partyName,
          reason: params.reason,
          eventDate: params.receivedAt,
          amount: params.amount ?? null,
          details: `Source: ${params.source}`,
        },
      })),
    );

    // Registering a serial turns tracking on for the product (orders then ask
    // for serials and coverage counts it). Never turns it off.
    await tx.product.updateMany({
      where: { id: params.productId, trackSerials: false },
      data: { trackSerials: true },
    });

    if (!params.skipShelfCheck)
      await this.assertShelfRoom(tx, params.productId);
    return units;
  }

  // ---------------------------------------------------------------------
  // Purchases
  // ---------------------------------------------------------------------

  /** Registers serials against a purchase; total per product ≤ purchased quantity. */
  async registerForPurchase(
    tx: Tx,
    purchase: {
      id: string;
      invoiceNumber: string;
      purchaseDate: Date;
      supplier: { name: string };
    },
    lines: { productId: string; serials: NormalizedSerial[] }[],
    purchasedQty: Map<string, number>,
    unitCost: Map<string, Prisma.Decimal>,
    adminId: string,
  ) {
    let total = 0;
    for (const line of lines) {
      if (line.serials.length === 0) continue;
      const bought = purchasedQty.get(line.productId);
      if (bought === undefined) {
        throw new BadRequestException(
          `Product ${line.productId} is not on purchase ${purchase.invoiceNumber}`,
        );
      }
      const already = await tx.productUnit.count({
        where: { purchaseId: purchase.id, productId: line.productId },
      });
      if (already + line.serials.length > bought) {
        throw new BadRequestException(
          `Purchase ${purchase.invoiceNumber} has ${bought} unit(s) of this product and ${already} already carry serials — ${line.serials.length} more is too many`,
        );
      }
      await this.registerUnits(tx, {
        productId: line.productId,
        serials: line.serials,
        source: ProductUnitSource.PURCHASE,
        receivedAt: purchase.purchaseDate,
        adminId,
        purchaseId: purchase.id,
        documentRef: purchase.invoiceNumber,
        partyName: purchase.supplier.name,
        amount: unitCost.get(line.productId) ?? null,
      });
      total += line.serials.length;
    }
    return total;
  }

  /** Purchase edit: its units must all still be here and fit the new quantities. */
  async assertPurchaseEditable(
    tx: Tx,
    purchaseId: string,
    newQty: Map<string, number>,
  ) {
    const units = await tx.productUnit.findMany({
      where: { purchaseId },
      select: {
        productId: true,
        status: true,
        serialNumber: true,
        product: { select: { name: true } },
      },
    });
    const moved = units.filter((u) => u.status !== ProductUnitStatus.IN_STOCK);
    if (moved.length > 0) {
      throw new BadRequestException(
        `${moved.length} serial(s) from this purchase are already sold, allocated or returned (e.g. ${moved[0].serialNumber}) — it can no longer be edited`,
      );
    }
    const perProduct = new Map<string, { count: number; name: string }>();
    for (const unit of units) {
      const entry = perProduct.get(unit.productId) ?? {
        count: 0,
        name: unit.product.name,
      };
      entry.count += 1;
      perProduct.set(unit.productId, entry);
    }
    for (const [productId, { count, name }] of perProduct) {
      const qty = newQty.get(productId) ?? 0;
      if (count > qty) {
        throw new BadRequestException(
          `"${name}" has ${count} serial(s) registered on this purchase — the quantity can't go below that (remove serials first)`,
        );
      }
    }
  }

  /** Purchase delete: units must all still be here; they're removed with it. */
  async deletePurchaseUnits(
    tx: Tx,
    purchaseId: string,
    invoiceNumber: string,
    adminId: string,
  ) {
    const units = await tx.productUnit.findMany({
      where: { purchaseId },
      include: { events: true },
    });
    if (units.length === 0) return 0;
    const moved = units.filter((u) => u.status !== ProductUnitStatus.IN_STOCK);
    if (moved.length > 0) {
      throw new BadRequestException(
        `${moved.length} serial(s) from this purchase are already sold, allocated or returned (e.g. ${moved[0].serialNumber}) — it can't be deleted`,
      );
    }
    const withHistory = units.filter((u) =>
      u.events.some(
        (e) =>
          e.type !== ProductUnitEventType.REGISTERED &&
          e.type !== ProductUnitEventType.SERIAL_CORRECTED,
      ),
    );
    if (withHistory.length > 0) {
      throw new BadRequestException(
        `Serial ${withHistory[0].serialNumber} from this purchase has sales/return history — the purchase can't be deleted`,
      );
    }
    await this.activityLogService.log(tx, {
      adminId,
      action: 'DELETED_SERIAL_UNITS',
      targetId: purchaseId,
      details: JSON.stringify({
        reason: `Purchase ${invoiceNumber} deleted`,
        units: units.map(({ events, ...unit }) => ({ ...unit, events })),
      }),
    });
    const ids = units.map((u) => u.id);
    await tx.productUnitEvent.deleteMany({ where: { unitId: { in: ids } } });
    await tx.productUnit.deleteMany({ where: { id: { in: ids } } });
    return units.length;
  }

  // ---------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------

  private warrantyFor(soldAt: Date, months: number | null) {
    return {
      soldAt,
      warrantyStartsAt: soldAt,
      warrantyExpiresAt: months ? addMonths(soldAt, months) : null,
    };
  }

  private saleDateOf(order: {
    deliveredAt: Date | null;
    completedAt: Date | null;
  }) {
    return order.deliveredAt ?? order.completedAt ?? new Date();
  }

  /**
   * Sets the exact serial set for one product line of an order (desired
   * final state). Unknown serials are registered as OPENING_STOCK when the
   * shelf invariant allows. Returns counts for logging.
   */
  async setOrderLineUnits(
    tx: Tx,
    order: OrderContext,
    productId: string,
    desired: NormalizedSerial[],
    adminId: string,
  ) {
    if (!ASSIGNABLE.includes(order.status)) {
      throw new BadRequestException(
        `Serials can only be assigned once the order is approved (order is ${order.status})`,
      );
    }
    const line = order.items.find((item) => item.productId === productId);
    if (!line) {
      throw new BadRequestException(
        `That product is not on order ${order.orderNumber}`,
      );
    }
    // Locks the product row and reads it in one round trip.
    const [product] = await tx.$queryRaw<
      { name: string; warrantyMonths: number | null }[]
    >`SELECT name, "warrantyMonths" FROM "Product" WHERE id = ${productId} FOR UPDATE`;
    if (!product) throw new BadRequestException('Product not found');
    const returned = await tx.salesReturnItem.aggregate({
      where: { productId, salesReturn: { orderId: order.id } },
      _sum: { quantity: true },
    });
    const limit = line.quantity - (returned._sum.quantity ?? 0);
    if (desired.length > limit) {
      throw new BadRequestException(
        `Order ${order.orderNumber} has ${limit} unit(s) of "${product.name}" still with the buyer — ${desired.length} serials is too many`,
      );
    }

    const current = await tx.productUnit.findMany({
      where: { orderId: order.id, productId },
    });
    const desiredKeys = new Set(desired.map((s) => s.serialKey));
    const currentKeys = new Set(current.map((u) => u.serialKey));
    const toRemove = current.filter((u) => !desiredKeys.has(u.serialKey));
    const toAdd = desired.filter((s) => !currentKeys.has(s.serialKey));

    await this.lockUnits(
      tx,
      toRemove.map((u) => u.id),
    );
    await this.unassign(
      tx,
      toRemove,
      order,
      ProductUnitEventType.UNASSIGNED_FROM_ORDER,
      'Removed from order',
      adminId,
    );

    const delivered = DELIVERED.includes(order.status);
    const existing = await tx.productUnit.findMany({
      where: { productId, serialKey: { in: toAdd.map((s) => s.serialKey) } },
      include: { order: { select: { orderNumber: true } } },
    });
    const byKey = new Map(existing.map((u) => [u.serialKey, u]));
    for (const unit of existing) {
      if (unit.status !== ProductUnitStatus.IN_STOCK || unit.orderId) {
        throw new BadRequestException(
          unit.order
            ? `Serial ${unit.serialNumber} is already on order ${unit.order.orderNumber}`
            : `Serial ${unit.serialNumber} is not in stock (${unit.status.replace(/_/g, ' ').toLowerCase()})`,
        );
      }
      if (unit.condition !== ProductUnitCondition.GOOD) {
        throw new BadRequestException(
          `Serial ${unit.serialNumber} is marked defective and can't be sold — mark it good first if it was repaired`,
        );
      }
    }

    const unknown = toAdd.filter((s) => !byKey.has(s.serialKey));
    const registered = await this.registerUnits(tx, {
      productId,
      serials: unknown,
      source: ProductUnitSource.OPENING_STOCK,
      receivedAt: new Date(),
      adminId,
      reason: `Registered while scanning order ${order.orderNumber}`,
      skipShelfCheck: true,
    });

    const addIds = [
      ...existing.map((u) => u.id),
      ...registered.map((u) => u.id),
    ];
    // No separate lock: transition() only moves rows still IN_STOCK and off
    // any order, and refuses the whole transaction if any row moved first.
    const now = new Date();
    const data: Prisma.ProductUnitUncheckedUpdateManyInput = delivered
      ? {
          status: ProductUnitStatus.SOLD,
          orderId: order.id,
          allocatedAt: now,
          warrantyManual: false,
          ...this.warrantyFor(this.saleDateOf(order), product.warrantyMonths),
        }
      : {
          status: ProductUnitStatus.ALLOCATED,
          orderId: order.id,
          allocatedAt: now,
          soldAt: null,
          warrantyStartsAt: null,
          warrantyExpiresAt: null,
          warrantyManual: false,
        };
    await this.transition(tx, addIds, [ProductUnitStatus.IN_STOCK], data, {
      orderId: null,
      condition: ProductUnitCondition.GOOD,
    });
    await this.addEvents(
      tx,
      addIds.map((id) => ({
        unit: {
          id,
          status: data.status as ProductUnitStatus,
          condition: ProductUnitCondition.GOOD,
        },
        input: {
          type: ProductUnitEventType.ASSIGNED_TO_ORDER,
          adminId,
          documentId: order.id,
          documentRef: this.orderRef(order),
          partyName: order.dealer.businessName,
          amount: line.netUnitPrice,
          eventDate: delivered ? this.saleDateOf(order) : now,
        },
      })),
    );

    // Unknown serials on an undelivered order are on our shelf: they must
    // fit the physical stock.
    if (!delivered && registered.length > 0)
      await this.assertShelfRoom(tx, productId);

    return {
      added: addIds.length,
      removed: toRemove.length,
      registered: registered.length,
    };
  }

  private async unassign(
    tx: Tx,
    units: {
      id: string;
      status: ProductUnitStatus;
      condition: ProductUnitCondition;
    }[],
    order: OrderContext,
    type: ProductUnitEventType,
    reason: string,
    adminId: string,
  ) {
    if (units.length === 0) return;
    const ids = units.map((u) => u.id);
    await this.transition(
      tx,
      ids,
      [ProductUnitStatus.ALLOCATED, ProductUnitStatus.SOLD],
      {
        status: ProductUnitStatus.IN_STOCK,
        orderId: null,
        allocatedAt: null,
        soldAt: null,
        warrantyStartsAt: null,
        warrantyExpiresAt: null,
        warrantyManual: false,
      },
      { orderId: order.id },
    );
    await this.addEvents(
      tx,
      units.map((unit) => ({
        unit: {
          id: unit.id,
          status: ProductUnitStatus.IN_STOCK,
          condition: unit.condition,
        },
        input: {
          type,
          adminId,
          documentId: order.id,
          documentRef: this.orderRef(order),
          partyName: order.dealer.businessName,
          reason,
        },
      })),
    );
  }

  /** Order delete / dealer data-clear: everything on the order goes back on the shelf. */
  async releaseOrderUnits(
    tx: Tx,
    orderId: string,
    adminId: string,
    type: ProductUnitEventType = ProductUnitEventType.UNASSIGNED_FROM_ORDER,
    reason = 'Order deleted',
  ) {
    const units = await tx.productUnit.findMany({ where: { orderId } });
    if (units.length === 0) return 0;
    const order = await this.loadOrderContext(tx, orderId);
    await this.lockUnits(
      tx,
      units.map((u) => u.id),
    );
    await this.unassign(tx, units, order, type, reason, adminId);
    return units.length;
  }

  /** ALLOCATED → SOLD when the order is delivered/completed; stamps warranty. */
  async markOrderUnitsSold(
    tx: Tx,
    orderId: string,
    soldAt: Date,
    adminId: string,
  ) {
    const units = await tx.productUnit.findMany({
      where: { orderId, status: ProductUnitStatus.ALLOCATED },
      include: { product: { select: { warrantyMonths: true } } },
    });
    if (units.length === 0) return 0;
    const order = await this.loadOrderContext(tx, orderId);
    await this.lockUnits(
      tx,
      units.map((u) => u.id),
    );
    // Units sharing a warranty length (and manual flag) move in one update.
    const groups = new Map<string, typeof units>();
    for (const unit of units) {
      const key = unit.warrantyManual
        ? 'manual'
        : `months:${unit.product.warrantyMonths ?? 'none'}`;
      groups.set(key, [...(groups.get(key) ?? []), unit]);
    }
    for (const group of groups.values()) {
      const [first] = group;
      await this.transition(
        tx,
        group.map((u) => u.id),
        [ProductUnitStatus.ALLOCATED],
        first.warrantyManual
          ? { status: ProductUnitStatus.SOLD, soldAt }
          : {
              status: ProductUnitStatus.SOLD,
              ...this.warrantyFor(soldAt, first.product.warrantyMonths),
            },
        { orderId },
      );
    }
    await this.addEvents(
      tx,
      units.map((unit) => ({
        unit: {
          id: unit.id,
          status: ProductUnitStatus.SOLD,
          condition: unit.condition,
        },
        input: {
          type: ProductUnitEventType.MARKED_SOLD,
          adminId,
          documentId: orderId,
          documentRef: this.orderRef(order),
          partyName: order.dealer.businessName,
          eventDate: soldAt,
          details: 'Order delivered',
        },
      })),
    );
    return units.length;
  }

  /** A completed order's sale date was edited: restamp units nobody edited by hand. */
  async restampOrderWarranty(tx: Tx, orderId: string, soldAt: Date) {
    const units = await tx.productUnit.findMany({
      where: { orderId, status: ProductUnitStatus.SOLD, warrantyManual: false },
      include: { product: { select: { warrantyMonths: true } } },
    });
    for (const unit of units) {
      await tx.productUnit.update({
        where: { id: unit.id },
        data: this.warrantyFor(soldAt, unit.product.warrantyMonths),
      });
    }
  }

  /** After an order's items are rebuilt: every product with serials still fits. */
  async assertOrderUnitsFit(tx: Tx, orderId: string) {
    const groups = await tx.productUnit.groupBy({
      by: ['productId'],
      where: { orderId },
      _count: { _all: true },
    });
    if (groups.length === 0) return;
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const group of groups) {
      const qty = items
        .filter((i) => i.productId === group.productId)
        .reduce((sum, i) => sum + i.quantity, 0);
      if (group._count._all > qty) {
        const product = await tx.product.findUnique({
          where: { id: group.productId },
          select: { name: true },
        });
        throw new BadRequestException(
          `${group._count._all} serial(s) of "${product?.name ?? group.productId}" are assigned to this order — unassign ${group._count._all - qty} first, then edit`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Sales returns (customer returns)
  // ---------------------------------------------------------------------

  async applySalesReturnUnits(
    tx: Tx,
    params: {
      order: OrderContext;
      salesReturn: {
        id: string;
        returnNumber: string;
        reason: string;
        returnDate: Date;
      };
      items: {
        productId: string;
        quantity: number;
        serials: SalesReturnSerialPick[];
      }[];
      adminId: string;
    },
  ) {
    const { order, salesReturn, adminId } = params;
    let total = 0;
    for (const item of params.items) {
      const line = order.items.find((i) => i.productId === item.productId);
      if (!line) continue;
      const onOrder = await tx.productUnit.findMany({
        where: {
          orderId: order.id,
          productId: item.productId,
          status: ProductUnitStatus.SOLD,
        },
      });
      const returnedOther = await tx.salesReturnItem.aggregate({
        where: {
          productId: item.productId,
          salesReturn: { orderId: order.id, id: { not: salesReturn.id } },
        },
        _sum: { quantity: true },
      });
      const stillWithBuyer = line.quantity - (returnedOther._sum.quantity ?? 0);
      const unserialized = Math.max(0, stillWithBuyer - onOrder.length);
      const required = Math.max(0, item.quantity - unserialized);
      if (item.serials.length > item.quantity) {
        throw new BadRequestException(
          `${item.serials.length} serials picked but only ${item.quantity} unit(s) are being returned`,
        );
      }
      if (item.serials.length < required) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { name: true },
        });
        throw new BadRequestException(
          `Select which ${required} serial(s) of "${product?.name ?? 'this product'}" came back — every unit still with the buyer carries a serial`,
        );
      }
      const byKey = new Map(onOrder.map((u) => [u.serialKey, u]));
      const picked = item.serials.map((pick) => {
        const unit = byKey.get(pick.serial.serialKey);
        if (!unit) {
          throw new BadRequestException(
            `Serial ${pick.serial.serialNumber} is not a sold unit on order ${order.orderNumber}`,
          );
        }
        return { unit, pick };
      });
      await this.lockUnits(
        tx,
        picked.map((p) => p.unit.id),
      );
      for (const { unit, pick } of picked) {
        // orderId cleared, sale dates kept: a reversal restores the sale as it was.
        await this.transition(
          tx,
          [unit.id],
          [ProductUnitStatus.SOLD],
          {
            status: ProductUnitStatus.IN_STOCK,
            orderId: null,
            condition: pick.condition,
          },
          { orderId: order.id },
        );
        await this.addEvent(
          tx,
          {
            id: unit.id,
            status: ProductUnitStatus.IN_STOCK,
            condition: pick.condition,
          },
          {
            type: ProductUnitEventType.RETURNED_BY_DEALER,
            adminId,
            documentId: salesReturn.id,
            documentRef: `${salesReturn.returnNumber} / ${this.orderRef(order)}`,
            partyName: order.dealer.businessName,
            reason: salesReturn.reason,
            faultNote: pick.faultNote?.trim() || null,
            eventDate: salesReturn.returnDate,
            amount: line.netUnitPrice,
            details: `orderId:${order.id}`,
          },
        );
      }
      total += picked.length;
    }
    return total;
  }

  /** §6.4 reversal: only units whose latest event is this return go back to the buyer. */
  async reverseSalesReturnUnits(
    tx: Tx,
    salesReturn: { id: string; returnNumber: string; orderId: string },
    adminId: string,
  ) {
    const events = await tx.productUnitEvent.findMany({
      where: {
        documentId: salesReturn.id,
        type: ProductUnitEventType.RETURNED_BY_DEALER,
      },
      select: { unitId: true },
    });
    const unitIds = [...new Set(events.map((e) => e.unitId))];
    if (unitIds.length === 0) return 0;
    await this.lockUnits(tx, unitIds);
    const order = await this.loadOrderContext(tx, salesReturn.orderId);

    for (const unitId of unitIds) {
      const history = await tx.productUnitEvent.findMany({
        where: { unitId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      });
      const unit = await tx.productUnit.findUniqueOrThrow({
        where: { id: unitId },
      });
      const [latest, previous] = history;
      if (
        !latest ||
        latest.type !== ProductUnitEventType.RETURNED_BY_DEALER ||
        latest.documentId !== salesReturn.id ||
        unit.status !== ProductUnitStatus.IN_STOCK
      ) {
        throw new BadRequestException(
          `Serial ${unit.serialNumber} from return ${salesReturn.returnNumber} has moved on since (${latest?.type.replace(/_/g, ' ').toLowerCase() ?? 'unknown'}) — the return can't be changed`,
        );
      }
      const condition = previous?.conditionAfter ?? ProductUnitCondition.GOOD;
      await this.transition(
        tx,
        [unitId],
        [ProductUnitStatus.IN_STOCK],
        {
          status: ProductUnitStatus.SOLD,
          orderId: salesReturn.orderId,
          condition,
          soldAt: unit.soldAt ?? this.saleDateOf(order),
        },
        { orderId: null },
      );
      await this.addEvent(
        tx,
        { id: unitId, status: ProductUnitStatus.SOLD, condition },
        {
          type: ProductUnitEventType.DEALER_RETURN_REVERSED,
          adminId,
          documentId: salesReturn.id,
          documentRef: `${salesReturn.returnNumber} / ${this.orderRef(order)}`,
          partyName: order.dealer.businessName,
          reason: 'Customer return edited or deleted',
        },
      );
    }
    return unitIds.length;
  }

  /** Serials each sales return took back (excluding reversed ones) — for display/edit. */
  async serialsForSalesReturns(tx: Tx, salesReturnIds: string[]) {
    const result = new Map<
      string,
      {
        productId: string;
        unitId: string;
        serialNumber: string;
        condition: ProductUnitCondition;
        faultNote: string | null;
      }[]
    >();
    if (salesReturnIds.length === 0) return result;
    const events = await tx.productUnitEvent.findMany({
      where: {
        documentId: { in: salesReturnIds },
        type: {
          in: [
            ProductUnitEventType.RETURNED_BY_DEALER,
            ProductUnitEventType.DEALER_RETURN_REVERSED,
          ],
        },
      },
      include: { unit: { select: { productId: true, serialNumber: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const live = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      const key = `${event.documentId}:${event.unitId}`;
      if (event.type === ProductUnitEventType.RETURNED_BY_DEALER)
        live.set(key, event);
      else live.delete(key);
    }
    for (const event of live.values()) {
      const list = result.get(event.documentId!) ?? [];
      list.push({
        productId: event.unit.productId,
        unitId: event.unitId,
        serialNumber: event.unit.serialNumber,
        condition: event.conditionAfter,
        faultNote: event.faultNote,
      });
      result.set(event.documentId!, list);
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Purchase returns (back to supplier)
  // ---------------------------------------------------------------------

  async applySupplierReturnUnits(
    tx: Tx,
    params: {
      purchaseReturn: {
        id: string;
        returnNumber: string;
        reason: string;
        returnDate: Date;
        purchaseId: string | null;
      };
      supplierName: string;
      items: {
        productId: string;
        quantity: number;
        unitCost: Prisma.Decimal;
        serials?: NormalizedSerial[];
      }[];
      adminId: string;
      /** Cancellation: take this purchase's in-stock units automatically. */
      autoPick?: boolean;
    },
  ) {
    const { purchaseReturn, adminId } = params;
    let total = 0;
    for (const item of params.items) {
      let units: {
        id: string;
        serialNumber: string;
        condition: ProductUnitCondition;
      }[];
      if (params.autoPick) {
        if (!purchaseReturn.purchaseId) continue;
        units = await tx.productUnit.findMany({
          where: {
            productId: item.productId,
            purchaseId: purchaseReturn.purchaseId,
            status: ProductUnitStatus.IN_STOCK,
          },
          orderBy: [{ condition: 'desc' }, { createdAt: 'asc' }],
          take: item.quantity,
        });
      } else {
        const serials = item.serials ?? [];
        if (serials.length === 0) continue;
        if (serials.length > item.quantity) {
          throw new BadRequestException(
            `${serials.length} serials picked but only ${item.quantity} unit(s) are being returned`,
          );
        }
        const found = await tx.productUnit.findMany({
          where: {
            productId: item.productId,
            serialKey: { in: serials.map((s) => s.serialKey) },
          },
        });
        const byKey = new Map(found.map((u) => [u.serialKey, u]));
        units = serials.map((serial) => {
          const unit = byKey.get(serial.serialKey);
          if (!unit) {
            throw new BadRequestException(
              `Serial ${serial.serialNumber} is not registered for this product`,
            );
          }
          if (unit.status !== ProductUnitStatus.IN_STOCK) {
            throw new BadRequestException(
              `Serial ${unit.serialNumber} is not in stock (${unit.status.replace(/_/g, ' ').toLowerCase()})`,
            );
          }
          if (
            purchaseReturn.purchaseId &&
            unit.purchaseId &&
            unit.purchaseId !== purchaseReturn.purchaseId
          ) {
            throw new BadRequestException(
              `Serial ${unit.serialNumber} came from a different purchase than the one this return is against`,
            );
          }
          return unit;
        });
      }
      if (units.length === 0) continue;
      await this.lockUnits(
        tx,
        units.map((u) => u.id),
      );
      await this.transition(
        tx,
        units.map((u) => u.id),
        [ProductUnitStatus.IN_STOCK],
        {
          status: ProductUnitStatus.RETURNED_TO_SUPPLIER,
          purchaseReturnId: purchaseReturn.id,
        },
        { orderId: null },
      );
      for (const unit of units) {
        await this.addEvent(
          tx,
          {
            id: unit.id,
            status: ProductUnitStatus.RETURNED_TO_SUPPLIER,
            condition: unit.condition,
          },
          {
            type: ProductUnitEventType.RETURNED_TO_SUPPLIER,
            adminId,
            documentId: purchaseReturn.id,
            documentRef: purchaseReturn.returnNumber,
            partyName: params.supplierName,
            reason: purchaseReturn.reason,
            eventDate: purchaseReturn.returnDate,
            amount: item.unitCost,
          },
        );
      }
      total += units.length;
    }
    return total;
  }

  /** §6.4 reversal for a purchase return being edited, deleted or reinstated. */
  async reverseSupplierReturnUnits(
    tx: Tx,
    purchaseReturn: { id: string; returnNumber: string },
    adminId: string,
  ) {
    const units = await tx.productUnit.findMany({
      where: { purchaseReturnId: purchaseReturn.id },
      include: { replacedBy: { select: { serialNumber: true } } },
    });
    if (units.length === 0) return 0;
    await this.lockUnits(
      tx,
      units.map((u) => u.id),
    );
    for (const unit of units) {
      if (unit.replacedBy) {
        throw new BadRequestException(
          `Serial ${unit.serialNumber} on return ${purchaseReturn.returnNumber} already has supplier replacement ${unit.replacedBy.serialNumber} — the return can't be changed`,
        );
      }
      const latest = await tx.productUnitEvent.findFirst({
        where: { unitId: unit.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const relinkOnly =
        latest?.type === ProductUnitEventType.SUPPLIER_RETURN_RELINKED &&
        latest.documentId === purchaseReturn.id;
      if (
        !latest ||
        !(
          (latest.type === ProductUnitEventType.RETURNED_TO_SUPPLIER &&
            latest.documentId === purchaseReturn.id) ||
          relinkOnly
        )
      ) {
        throw new BadRequestException(
          `Serial ${unit.serialNumber} on return ${purchaseReturn.returnNumber} has moved on since — the return can't be changed`,
        );
      }
    }
    await this.transition(
      tx,
      units.map((u) => u.id),
      [ProductUnitStatus.RETURNED_TO_SUPPLIER],
      { status: ProductUnitStatus.IN_STOCK, purchaseReturnId: null },
      { purchaseReturnId: purchaseReturn.id },
    );
    for (const unit of units) {
      await this.addEvent(
        tx,
        {
          id: unit.id,
          status: ProductUnitStatus.IN_STOCK,
          condition: unit.condition,
        },
        {
          type: ProductUnitEventType.SUPPLIER_RETURN_REVERSED,
          adminId,
          documentId: purchaseReturn.id,
          documentRef: purchaseReturn.returnNumber,
          reason: 'Supplier return edited, deleted or purchase reinstated',
        },
      );
    }
    return units.length;
  }

  /** Link/unlink of a return to a purchase: serials must have come from it. */
  async relinkSupplierReturnUnits(
    tx: Tx,
    purchaseReturn: { id: string; returnNumber: string },
    purchase: { id: string; invoiceNumber: string } | null,
    adminId: string,
  ) {
    const units = await tx.productUnit.findMany({
      where: { purchaseReturnId: purchaseReturn.id },
    });
    if (purchase) {
      const foreign = units.find(
        (u) => u.purchaseId && u.purchaseId !== purchase.id,
      );
      if (foreign) {
        throw new BadRequestException(
          `Serial ${foreign.serialNumber} on this return came from a different purchase than ${purchase.invoiceNumber}`,
        );
      }
    }
    for (const unit of units) {
      await this.addEvent(tx, unit, {
        type: ProductUnitEventType.SUPPLIER_RETURN_RELINKED,
        adminId,
        documentId: purchaseReturn.id,
        documentRef: purchaseReturn.returnNumber,
        details: purchase
          ? `Linked to purchase ${purchase.invoiceNumber}`
          : 'Unlinked from its purchase',
      });
    }
  }

  // ---------------------------------------------------------------------
  // Stock adjustments
  // ---------------------------------------------------------------------

  async writeOffUnits(
    tx: Tx,
    productId: string,
    serials: NormalizedSerial[],
    reason: string,
    adminId: string,
  ) {
    if (serials.length === 0) return 0;
    const units = await tx.productUnit.findMany({
      where: { productId, serialKey: { in: serials.map((s) => s.serialKey) } },
    });
    const byKey = new Map(units.map((u) => [u.serialKey, u]));
    const picked = serials.map((serial) => {
      const unit = byKey.get(serial.serialKey);
      if (!unit)
        throw new BadRequestException(
          `Serial ${serial.serialNumber} is not registered for this product`,
        );
      if (unit.status !== ProductUnitStatus.IN_STOCK) {
        throw new BadRequestException(
          `Serial ${unit.serialNumber} is not in stock`,
        );
      }
      return unit;
    });
    await this.lockUnits(
      tx,
      picked.map((u) => u.id),
    );
    await this.transition(
      tx,
      picked.map((u) => u.id),
      [ProductUnitStatus.IN_STOCK],
      { status: ProductUnitStatus.WRITTEN_OFF },
      { orderId: null },
    );
    for (const unit of picked) {
      await this.addEvent(
        tx,
        {
          id: unit.id,
          status: ProductUnitStatus.WRITTEN_OFF,
          condition: unit.condition,
        },
        { type: ProductUnitEventType.WRITTEN_OFF, adminId, reason },
      );
    }
    return picked.length;
  }
}
