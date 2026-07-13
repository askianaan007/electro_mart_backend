import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePurchaseReturnDto } from './dto/create-purchase-return.dto';
import { QueryPurchaseReturnsDto } from './dto/query-purchase-returns.dto';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

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
    const purchase = await this.prisma.purchase.findUnique({
      where: { id: dto.purchaseId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    const alreadyReturned = await this.prisma.purchaseReturnItem.groupBy({
      by: ['productId'],
      where: { purchaseReturn: { purchaseId: purchase.id } },
      _sum: { quantity: true },
    });
    const returnedMap = new Map(
      alreadyReturned.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );

    let totalAmount = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
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

    return this.prisma.$transaction(async (tx) => {
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
}
