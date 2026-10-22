import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  CreatePurchaseReturnDto,
  PurchaseReturnItemDto,
} from './dto/create-purchase-return.dto';
import { UpdatePurchaseReturnDto } from './dto/update-purchase-return.dto';
import { QueryPurchaseReturnsDto } from './dto/query-purchase-returns.dto';
import { paginate } from '../common/utils/paginate';
import {
  nextSequenceNumber,
  resetSequenceCounter,
} from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { businessDateRange } from '../common/utils/business-date';
import { SerialLifecycleService } from '../product-units/serial-lifecycle.service';
import { NormalizedSerial, normalizeSerialList } from '../common/utils/serial';

type TransactionClient = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PurchaseReturnsService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
    private serials: SerialLifecycleService,
  ) {}

  /** Normalized serial picks per product (one line per product per return). */
  private serialPicks(items: { productId: string; serials?: string[] }[]) {
    const picks = new Map<string, NormalizedSerial[]>();
    for (const item of items) {
      if (!item.serials?.length) continue;
      picks.set(item.productId, [
        ...(picks.get(item.productId) ?? []),
        ...normalizeSerialList(item.serials),
      ]);
    }
    for (const list of picks.values())
      normalizeSerialList(list.map((s) => s.serialNumber));
    return picks;
  }

  /** Moves the picked (or, for a cancellation, this purchase's) units to the supplier. */
  private async applyUnits(
    tx: TransactionClient,
    purchaseReturn: {
      id: string;
      returnNumber: string;
      reason: string;
      returnDate: Date;
      purchaseId: string | null;
      supplier: { name: string };
    },
    itemsData: {
      productId: string;
      quantity: number;
      unitCost: Prisma.Decimal;
    }[],
    picks: Map<string, NormalizedSerial[]>,
    adminId: string,
    autoPick = false,
  ) {
    return this.serials.applySupplierReturnUnits(tx, {
      purchaseReturn,
      supplierName: purchaseReturn.supplier.name,
      items: itemsData.map((item) => ({
        ...item,
        serials: picks.get(item.productId),
      })),
      adminId,
      autoPick,
    });
  }

  private readonly include = {
    supplier: true,
    purchase: true,
    items: { include: { product: true } },
    units: {
      select: {
        id: true,
        productId: true,
        serialNumber: true,
        condition: true,
      },
      orderBy: { serialKey: 'asc' },
    },
  } satisfies Prisma.PurchaseReturnInclude;

  async create(dto: CreatePurchaseReturnDto, adminId: string) {
    if (dto.purchaseId) {
      return this.createAgainstPurchase(dto.purchaseId, dto, adminId);
    }
    return this.createStandalone(dto, adminId);
  }

  private async createAgainstPurchase(
    purchaseId: string,
    dto: CreatePurchaseReturnDto,
    adminId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.lockPurchase(tx, purchaseId);
      if (purchase.cancelledAt) {
        throw new BadRequestException(
          `Purchase ${purchase.invoiceNumber} is cancelled — every unit has already been returned`,
        );
      }
      const shelfGuard = await this.serials.beginShelfGuard(
        tx,
        dto.items.map((item) => item.productId),
      );
      const created = await this.insertAgainstPurchase(
        tx,
        purchase,
        dto,
        adminId,
      );
      await shelfGuard.assert();
      return created;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Locks the purchase row so a concurrent return (or cancellation) against
   * it can't read the same pre-write "already returned" snapshot in
   * computeItemsAgainstPurchase and also pass its remaining-quantity guard.
   */
  async lockPurchase(tx: TransactionClient, purchaseId: string) {
    await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${purchaseId} FOR UPDATE`;
    const purchase = await tx.purchase.findUnique({
      where: { id: purchaseId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return purchase;
  }

  /**
   * Records a return against a purchase the caller has locked (lockPurchase).
   * PurchasesService.cancel() uses it with isCancellation for the return
   * that sends back everything still held.
   */
  async insertAgainstPurchase(
    tx: TransactionClient,
    purchase: Awaited<ReturnType<PurchaseReturnsService['lockPurchase']>>,
    dto: Pick<CreatePurchaseReturnDto, 'reason' | 'returnDate' | 'items'>,
    adminId: string,
    isCancellation = false,
  ) {
    const { itemsData, totalAmount } = await this.computeItemsAgainstPurchase(
      tx,
      purchase,
      dto.items,
    );

    const returnNumber = await nextSequenceNumber(tx, 'purchaseReturn', 'PRTN');

    const purchaseReturn = await tx.purchaseReturn.create({
      data: {
        returnNumber,
        purchaseId: purchase.id,
        supplierId: purchase.supplierId,
        reason: dto.reason,
        totalAmount,
        returnDate: new Date(dto.returnDate),
        isCancellation,
        items: { create: itemsData },
      },
      include: this.include,
    });

    for (const item of itemsData) {
      await this.inventoryService.recordMovement(tx, {
        productId: item.productId,
        type: InventoryLogType.ADJUSTMENT,
        quantityOut: item.quantity,
        reference: purchaseReturn.id,
      });
    }

    const serialCount = await this.applyUnits(
      tx,
      purchaseReturn,
      itemsData,
      this.serialPicks(dto.items),
      adminId,
      isCancellation,
    );

    await this.activityLogService.log(tx, {
      adminId,
      action: 'RECORDED_PURCHASE_RETURN',
      targetId: purchaseReturn.id,
      details:
        `Purchase return ${returnNumber} of ${totalAmount.toString()} against purchase invoice ${purchase.invoiceNumber}` +
        (isCancellation ? ' (order cancelled)' : '') +
        (serialCount > 0 ? `, ${serialCount} serial(s) sent back` : ''),
    });

    return purchaseReturn;
  }

  /** Per product, how many units of the purchase haven't been returned yet. */
  async remainingQuantities(
    tx: TransactionClient,
    purchase: { id: string; items: { productId: string; quantity: number }[] },
  ) {
    const alreadyReturned = await tx.purchaseReturnItem.groupBy({
      by: ['productId'],
      where: { purchaseReturn: { purchaseId: purchase.id } },
      _sum: { quantity: true },
    });
    const remaining = new Map<string, number>();
    for (const item of purchase.items) {
      remaining.set(
        item.productId,
        (remaining.get(item.productId) ?? 0) + item.quantity,
      );
    }
    for (const row of alreadyReturned) {
      const bought = remaining.get(row.productId);
      if (bought !== undefined) {
        remaining.set(row.productId, bought - (row._sum.quantity ?? 0));
      }
    }
    return remaining;
  }

  // For returns not tied to a specific purchase invoice — e.g. a damaged unit
  // found in stock — the admin supplies the cost per item directly since
  // there's no purchase line to look it up from.
  private async createStandalone(
    dto: CreatePurchaseReturnDto,
    adminId: string,
  ) {
    if (!dto.supplierId) {
      throw new BadRequestException(
        'supplierId is required when the return is not tied to a purchase',
      );
    }
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: dto.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const { itemsData, totalAmount } = this.computeStandaloneItems(dto.items);
    const picks = this.serialPicks(dto.items);

    return this.prisma.$transaction(async (tx) => {
      const shelfGuard = await this.serials.beginShelfGuard(
        tx,
        itemsData.map((item) => item.productId),
      );
      const returnNumber = await nextSequenceNumber(
        tx,
        'purchaseReturn',
        'PRTN',
      );

      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          returnNumber,
          supplierId: supplier.id,
          reason: dto.reason,
          totalAmount,
          returnDate: new Date(dto.returnDate),
          items: { create: itemsData },
        },
        include: this.include,
      });

      for (const item of itemsData) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: purchaseReturn.id,
        });
      }

      const serialCount = await this.applyUnits(
        tx,
        purchaseReturn,
        itemsData,
        picks,
        adminId,
      );
      await shelfGuard.assert();

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PURCHASE_RETURN',
        targetId: purchaseReturn.id,
        details:
          `Standalone purchase return ${returnNumber} of ${totalAmount.toString()} to ${supplier.name} (${dto.reason})` +
          (serialCount > 0 ? `, ${serialCount} serial(s) sent back` : ''),
      });

      return purchaseReturn;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Validates requested return quantities against what's still returnable
   * from a purchase (quantity minus what other returns already took), and
   * prices each line from the purchase's own unitCost. Shared by
   * createAgainstPurchase() and update() (for purchase-tied returns);
   * update() passes excludeReturnId so the return being edited doesn't
   * count against its own remaining allowance.
   */
  private async computeItemsAgainstPurchase(
    tx: TransactionClient,
    purchase: {
      id: string;
      items: {
        productId: string;
        quantity: number;
        unitCost: Prisma.Decimal;
      }[];
    },
    dtoItems: PurchaseReturnItemDto[],
    excludeReturnId?: string,
  ) {
    const alreadyReturned = await tx.purchaseReturnItem.groupBy({
      by: ['productId'],
      where: {
        purchaseReturn: {
          purchaseId: purchase.id,
          ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
        },
      },
      _sum: { quantity: true },
    });
    const returnedMap = new Map(
      alreadyReturned.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );

    let totalAmount = new Prisma.Decimal(0);
    const itemsData = dtoItems.map((item) => {
      const purchaseItem = purchase.items.find(
        (pi) => pi.productId === item.productId,
      );
      if (!purchaseItem) {
        throw new BadRequestException(
          `Product ${item.productId} was not part of this purchase`,
        );
      }
      const alreadyReturnedQty = returnedMap.get(item.productId) ?? 0;
      const remaining = purchaseItem.quantity - alreadyReturnedQty;
      if (item.quantity > remaining) {
        throw new BadRequestException(
          `Cannot return ${item.quantity} of product ${item.productId}; only ${remaining} remain returnable`,
        );
      }
      // Track this line's quantity so a second line for the same product in
      // the same request is checked against the reduced remaining, not the
      // stale pre-request value.
      returnedMap.set(item.productId, alreadyReturnedQty + item.quantity);

      const lineTotal = purchaseItem.unitCost.mul(item.quantity);
      totalAmount = totalAmount.add(lineTotal);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitCost: purchaseItem.unitCost,
        lineTotal,
      };
    });

    return { itemsData, totalAmount };
  }

  private computeStandaloneItems(dtoItems: PurchaseReturnItemDto[]) {
    let totalAmount = new Prisma.Decimal(0);
    const itemsData = dtoItems.map((item) => {
      if (item.unitCost === undefined) {
        throw new BadRequestException(
          `unitCost is required for product ${item.productId} since this return isn't tied to a purchase`,
        );
      }
      const unitCost = new Prisma.Decimal(item.unitCost);
      const lineTotal = unitCost.mul(item.quantity);
      totalAmount = totalAmount.add(lineTotal);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitCost,
        lineTotal,
      };
    });

    return { itemsData, totalAmount };
  }

  async findAll(query: QueryPurchaseReturnsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PurchaseReturnWhereInput = {
      ...(query.supplierId && { supplierId: query.supplierId }),
      ...(query.linked === 'true' && { purchaseId: { not: null } }),
      ...(query.linked === 'false' && { purchaseId: null }),
      ...(query.search && {
        OR: [
          { returnNumber: { contains: query.search, mode: 'insensitive' } },
          { reason: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...((query.dateFrom || query.dateTo) && {
        returnDate: businessDateRange(query.dateFrom, query.dateTo),
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchaseReturn.findMany({
        where,
        include: this.include,
        orderBy: [{ returnDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.purchaseReturn.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForPurchase(purchaseId: string) {
    return this.prisma.purchaseReturn.findMany({
      where: { purchaseId },
      include: this.include,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: this.include,
    });
    if (!purchaseReturn)
      throw new NotFoundException('Purchase return not found');
    return purchaseReturn;
  }

  /**
   * Edits a mistaken return's items/reason/date. Reverses the old items'
   * stock (undoing the "sent back to supplier" deduction) and re-applies
   * the corrected ones — re-validated against the purchase's remaining
   * ceiling if this return is tied to one, with the same row-lock used by
   * createAgainstPurchase(). Only allowed within 1 day of being recorded,
   * mirroring sales-returns' edit window.
   */
  async update(id: string, dto: UpdatePurchaseReturnDto, adminId: string) {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { items: true, purchase: { include: { items: true } } },
    });
    if (!purchaseReturn)
      throw new NotFoundException('Purchase return not found');
    this.assertEditable(purchaseReturn);
    this.assertNotCancellation(purchaseReturn);

    const oldItems = purchaseReturn.items;
    const oldTotalAmount = purchaseReturn.totalAmount;
    const picks = this.serialPicks(dto.items);

    return this.prisma.$transaction(async (tx) => {
      const shelfGuard = await this.serials.beginShelfGuard(tx, [
        ...oldItems.map((item) => item.productId),
        ...dto.items.map((item) => item.productId),
      ]);
      // §6.4: the old serial set goes back on the shelf first (refused if
      // any of those units moved on since), then the corrected set leaves.
      await this.serials.reverseSupplierReturnUnits(
        tx,
        purchaseReturn,
        adminId,
      );
      let itemsData: {
        productId: string;
        quantity: number;
        unitCost: Prisma.Decimal;
        lineTotal: Prisma.Decimal;
      }[];
      let totalAmount: Prisma.Decimal;

      if (purchaseReturn.purchase) {
        const purchase = await this.lockPurchase(
          tx,
          purchaseReturn.purchase.id,
        );
        this.assertPurchaseActive(purchase);
        const computed = await this.computeItemsAgainstPurchase(
          tx,
          purchaseReturn.purchase,
          dto.items,
          id,
        );
        itemsData = computed.itemsData;
        totalAmount = computed.totalAmount;
      } else {
        const computed = this.computeStandaloneItems(dto.items);
        itemsData = computed.itemsData;
        totalAmount = computed.totalAmount;
      }

      for (const item of oldItems) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: item.quantity,
          reference: purchaseReturn.id,
        });
      }
      for (const item of itemsData) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: purchaseReturn.id,
        });
      }

      const updated = await tx.purchaseReturn.update({
        where: { id },
        data: {
          reason: dto.reason,
          returnDate: new Date(dto.returnDate),
          totalAmount,
          items: { deleteMany: {}, create: itemsData },
        },
        include: this.include,
      });

      await this.applyUnits(tx, updated, itemsData, picks, adminId);
      await shelfGuard.assert();

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PURCHASE_RETURN',
        targetId: id,
        details: `Updated purchase return ${purchaseReturn.returnNumber}: ${oldTotalAmount.toString()} -> ${totalAmount.toString()}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Fully reverses a mistaken return: restores the stock that had gone back
   * to the supplier, and realigns the PRTN counter if this was the most
   * recently issued return. Only allowed within 1 day of being recorded.
   */
  async remove(id: string, adminId: string) {
    const purchaseReturn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { items: true, purchase: true },
    });
    if (!purchaseReturn)
      throw new NotFoundException('Purchase return not found');
    this.assertEditable(purchaseReturn);
    this.assertNotCancellation(purchaseReturn);

    return this.prisma.$transaction(async (tx) => {
      if (purchaseReturn.purchaseId) {
        this.assertPurchaseActive(
          await this.lockPurchase(tx, purchaseReturn.purchaseId),
        );
      }
      await this.deleteWithin(tx, purchaseReturn, adminId);
      return { message: 'Purchase return deleted' };
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Deletes a return inside the caller's transaction: puts its stock back,
   * removes it and realigns the PRTN counter. Also used by
   * PurchasesService.reinstate() for the cancellation return.
   */
  async deleteWithin(
    tx: TransactionClient,
    purchaseReturn: {
      id: string;
      returnNumber: string;
      totalAmount: Prisma.Decimal;
      items: { productId: string; quantity: number }[];
    },
    adminId: string,
  ) {
    const replacements = await tx.purchaseReturnReplacement.count({
      where: { purchaseReturnId: purchaseReturn.id },
    });
    if (replacements > 0) {
      throw new BadRequestException(
        `Return ${purchaseReturn.returnNumber} has replacement goods recorded against it and cannot be removed.`,
      );
    }

    await this.serials.reverseSupplierReturnUnits(tx, purchaseReturn, adminId);

    for (const item of purchaseReturn.items) {
      await this.inventoryService.recordMovement(tx, {
        productId: item.productId,
        type: InventoryLogType.ADJUSTMENT,
        quantityIn: item.quantity,
        reference: purchaseReturn.id,
      });
    }

    await tx.purchaseReturnItem.deleteMany({
      where: { purchaseReturnId: purchaseReturn.id },
    });
    await tx.purchaseReturn.delete({ where: { id: purchaseReturn.id } });

    const remaining = await tx.purchaseReturn.findMany({
      select: { returnNumber: true },
    });
    await resetSequenceCounter(
      tx,
      'purchaseReturn',
      remaining.map((r) => r.returnNumber),
    );

    await this.activityLogService.log(tx, {
      adminId,
      action: 'DELETED_PURCHASE_RETURN',
      targetId: purchaseReturn.id,
      details: `Deleted purchase return ${purchaseReturn.returnNumber} of ${purchaseReturn.totalAmount.toString()}`,
    });
  }

  /**
   * Ties a standalone return to the purchase its goods came from — for a
   * return recorded from the supplier's page that was really against one
   * invoice. Nothing financial moves (the supplier credit was taken when
   * the return was recorded); the purchase just starts counting it, so the
   * same units can't be returned against it a second time.
   */
  async link(id: string, purchaseId: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.lockPurchase(tx, purchaseId);
      this.assertPurchaseActive(purchase);
      await tx.$queryRaw`SELECT id FROM "PurchaseReturn" WHERE id = ${id} FOR UPDATE`;
      const purchaseReturn = await tx.purchaseReturn.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!purchaseReturn)
        throw new NotFoundException('Purchase return not found');
      if (purchaseReturn.purchaseId) {
        throw new BadRequestException(
          `Return ${purchaseReturn.returnNumber} is already linked to a purchase`,
        );
      }
      if (purchaseReturn.supplierId !== purchase.supplierId) {
        throw new BadRequestException(
          'That return was made to a different supplier',
        );
      }

      const remaining = await this.remainingQuantities(tx, purchase);
      for (const item of purchaseReturn.items) {
        const left = remaining.get(item.productId);
        if (left === undefined) {
          throw new BadRequestException(
            `Return ${purchaseReturn.returnNumber} includes a product that isn't on purchase ${purchase.invoiceNumber}`,
          );
        }
        if (item.quantity > left) {
          throw new BadRequestException(
            `Return ${purchaseReturn.returnNumber} sends back ${item.quantity} of a product, but only ${left} remain returnable on purchase ${purchase.invoiceNumber}`,
          );
        }
        remaining.set(item.productId, left - item.quantity);
      }

      await this.serials.relinkSupplierReturnUnits(
        tx,
        purchaseReturn,
        purchase,
        adminId,
      );

      const updated = await tx.purchaseReturn.update({
        where: { id },
        data: { purchaseId: purchase.id },
        include: this.include,
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'LINKED_PURCHASE_RETURN',
        targetId: id,
        details: `Linked return ${purchaseReturn.returnNumber} to purchase invoice ${purchase.invoiceNumber}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /** Undoes link(): the return becomes standalone again. */
  async unlink(id: string, adminId: string) {
    const existing = await this.prisma.purchaseReturn.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Purchase return not found');
    if (!existing.purchaseId) {
      throw new BadRequestException('This return is not linked to a purchase');
    }
    const purchaseId = existing.purchaseId;
    this.assertNotCancellation(existing);

    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.lockPurchase(tx, purchaseId);
      this.assertPurchaseActive(purchase);
      await this.serials.relinkSupplierReturnUnits(tx, existing, null, adminId);

      const updated = await tx.purchaseReturn.update({
        where: { id },
        data: { purchaseId: null },
        include: this.include,
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UNLINKED_PURCHASE_RETURN',
        targetId: id,
        details: `Unlinked return ${existing.returnNumber} from purchase invoice ${purchase.invoiceNumber}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  private assertNotCancellation(purchaseReturn: {
    isCancellation: boolean;
    returnNumber: string;
  }) {
    if (purchaseReturn.isCancellation) {
      throw new BadRequestException(
        `Return ${purchaseReturn.returnNumber} was created by cancelling its purchase — reinstate the purchase to undo it.`,
      );
    }
  }

  private assertPurchaseActive(purchase: {
    cancelledAt: Date | null;
    invoiceNumber: string;
  }) {
    if (purchase.cancelledAt) {
      throw new BadRequestException(
        `Purchase ${purchase.invoiceNumber} is cancelled — reinstate it before changing its returns.`,
      );
    }
  }

  private assertEditable(purchaseReturn: { createdAt: Date }) {
    if (Date.now() - purchaseReturn.createdAt.getTime() > DAY_MS) {
      throw new BadRequestException(
        'This return can only be edited or deleted within 1 day of being recorded',
      );
    }
  }
}
