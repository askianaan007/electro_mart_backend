import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { QueryLedgerDto } from './dto/query-ledger.dto';

type TransactionClient = Prisma.TransactionClient;

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

    const product = await tx.product.findUnique({
      where: { id: params.productId },
    });
    if (!product)
      throw new NotFoundException(`Product ${params.productId} not found`);

    if (netDelta < 0 && product.currentStock + netDelta < 0) {
      throw new BadRequestException(
        `Insufficient stock for product "${product.name}"`,
      );
    }

    const updated = await tx.product.update({
      where: { id: params.productId },
      data: { currentStock: { increment: netDelta } },
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

    return paginate(data, total, page, limit);
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
