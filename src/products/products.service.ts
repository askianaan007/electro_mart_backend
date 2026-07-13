import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

function withStockFlag<T extends { currentStock: number }>(product: T) {
  return {
    ...product,
    isOutOfStock: product.currentStock <= 0,
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  private async assertCodesAreUnique(
    dto: { productCode?: string; sku?: string; barcode?: string },
    excludeId?: string,
  ) {
    const clauses: Prisma.ProductWhereInput[] = [];
    if (dto.productCode) clauses.push({ productCode: dto.productCode });
    if (dto.sku) clauses.push({ sku: dto.sku });
    if (dto.barcode) clauses.push({ barcode: dto.barcode });
    if (clauses.length === 0) return;

    const conflict = await this.prisma.product.findFirst({
      where: { OR: clauses, ...(excludeId && { id: { not: excludeId } }) },
    });
    if (conflict)
      throw new ConflictException(
        'Product code, SKU, or barcode already in use',
      );
  }

  async create(dto: CreateProductDto, adminId: string) {
    await this.assertCodesAreUnique(dto);

    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          ...dto,
          currentStock: dto.currentStock ?? 0,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_PRODUCT',
        targetId: created.id,
        details: `Created product ${created.name} (${created.productCode})`,
      });

      return created;
    }, TRANSACTION_OPTIONS);

    return withStockFlag(product);
  }

  async findAll(query: QueryProductDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ProductWhereInput = {
      category: query.category,
      status: query.status,
      ...(query.outOfStockOnly && { currentStock: { lte: 0 } }),
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { productCode: { contains: query.search, mode: 'insensitive' } },
          { sku: { contains: query.search, mode: 'insensitive' } },
          { brand: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginate(data.map(withStockFlag), total, page, limit);
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    return withStockFlag(product);
  }

  async update(id: string, dto: UpdateProductDto, adminId: string) {
    await this.findOne(id);
    await this.assertCodesAreUnique(dto, id);

    const product = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: dto,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PRODUCT',
        targetId: updated.id,
        details: `Updated product ${updated.name}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);

    return withStockFlag(product);
  }

  async setStatus(id: string, status: 'ACTIVE' | 'INACTIVE', adminId: string) {
    await this.findOne(id);

    const product = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: { status },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: `PRODUCT_${status}`,
        targetId: updated.id,
        details: `Product ${updated.name} set to ${status}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);

    return withStockFlag(product);
  }

  async remove(id: string, adminId: string) {
    const product = await this.findOne(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.product.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_PRODUCT',
          targetId: id,
          details: `Deleted product ${product.name}`,
        });

        return { message: 'Product deleted' };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This product has order or purchase history and cannot be deleted. Deactivate it instead.',
        );
      }
      throw error;
    }
  }
}
