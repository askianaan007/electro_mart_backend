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

type TransactionClient = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PurchaseReturnsService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
  ) {}

  private readonly include = {
    supplier: true,
    purchase: true,
    items: { include: { product: true } },
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
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    return this.prisma.$transaction(async (tx) => {
      // Lock the purchase row so a second concurrent return against the
      // same purchase can't read the same pre-write "already returned"
      // snapshot in computeItemsAgainstPurchase and also pass its
      // remaining-quantity guard.
      await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${purchaseId} FOR UPDATE`;

      const { itemsData, totalAmount } = await this.computeItemsAgainstPurchase(
        tx,
        purchase,
        dto.items,
      );

      const returnNumber = await nextSequenceNumber(
        tx,
        'purchaseReturn',
        'PRTN',
      );

      const purchaseReturn = await tx.purchaseReturn.create({
        data: {
          returnNumber,
          purchaseId: purchase.id,
          supplierId: purchase.supplierId,
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

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PURCHASE_RETURN',
        targetId: purchaseReturn.id,
        details: `Purchase return ${returnNumber} of ${totalAmount.toString()} against purchase invoice ${purchase.invoiceNumber}`,
      });

      return purchaseReturn;
    }, TRANSACTION_OPTIONS);
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

    return this.prisma.$transaction(async (tx) => {
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

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PURCHASE_RETURN',
        targetId: purchaseReturn.id,
        details: `Standalone purchase return ${returnNumber} of ${totalAmount.toString()} to ${supplier.name} (${dto.reason})`,
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
      ...(query.search && {
        OR: [
          { returnNumber: { contains: query.search, mode: 'insensitive' } },
          { reason: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...((query.dateFrom || query.dateTo) && {
        returnDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
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

    const oldItems = purchaseReturn.items;
    const oldTotalAmount = purchaseReturn.totalAmount;

    return this.prisma.$transaction(async (tx) => {
      let itemsData: {
        productId: string;
        quantity: number;
        unitCost: Prisma.Decimal;
        lineTotal: Prisma.Decimal;
      }[];
      let totalAmount: Prisma.Decimal;

      if (purchaseReturn.purchase) {
        await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${purchaseReturn.purchase.id} FOR UPDATE`;
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
      include: { items: true },
    });
    if (!purchaseReturn)
      throw new NotFoundException('Purchase return not found');
    this.assertEditable(purchaseReturn);

    return this.prisma.$transaction(async (tx) => {
      for (const item of purchaseReturn.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: item.quantity,
          reference: purchaseReturn.id,
        });
      }

      await tx.purchaseReturnItem.deleteMany({
        where: { purchaseReturnId: id },
      });
      await tx.purchaseReturn.delete({ where: { id } });

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
        targetId: id,
        details: `Deleted purchase return ${purchaseReturn.returnNumber} of ${purchaseReturn.totalAmount.toString()}`,
      });

      return { message: 'Purchase return deleted' };
    }, TRANSACTION_OPTIONS);
  }

  private assertEditable(purchaseReturn: { createdAt: Date }) {
    if (Date.now() - purchaseReturn.createdAt.getTime() > DAY_MS) {
      throw new BadRequestException(
        'This return can only be edited or deleted within 1 day of being recorded',
      );
    }
  }
}
