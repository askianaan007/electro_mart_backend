import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

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

  async listStock(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ProductWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { productCode: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [products, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: {
          id: true,
          productCode: true,
          name: true,
          currentStock: true,
          minimumStock: true,
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
      status:
        product.currentStock <= 0
          ? 'OUT_OF_STOCK'
          : product.currentStock <= product.minimumStock
            ? 'LOW_STOCK'
            : 'IN_STOCK',
    }));

    return paginate(data, total, page, limit);
  }

  async getLedger(productId: string, query: PaginationQueryDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.inventoryLog.findMany({
        where: { productId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryLog.count({ where: { productId } }),
    ]);

    return paginate(data, total, page, limit);
  }

  async adjustStock(dto: AdjustStockDto) {
    return this.prisma.$transaction(
      (tx) =>
        this.recordMovement(tx, {
          productId: dto.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: dto.direction === 'IN' ? dto.quantity : 0,
          quantityOut: dto.direction === 'OUT' ? dto.quantity : 0,
          reference: dto.reason,
        }),
      TRANSACTION_OPTIONS,
    );
  }
}
