import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';

function withLowStockFlag<
  T extends { currentStock: number; minimumStock: number },
>(product: T) {
  return {
    ...product,
    isLowStock: product.currentStock <= product.minimumStock,
  };
}

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

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

  async create(dto: CreateProductDto) {
    await this.assertCodesAreUnique(dto);
    const product = await this.prisma.product.create({
      data: {
        ...dto,
        currentStock: dto.currentStock ?? 0,
        minimumStock: dto.minimumStock ?? 0,
      },
    });
    return withLowStockFlag(product);
  }

  async findAll(query: QueryProductDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    let lowStockIds: string[] | undefined;
    if (query.lowStockOnly) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Product" WHERE "currentStock" <= "minimumStock"
      `;
      lowStockIds = rows.map((r) => r.id);
    }

    const where: Prisma.ProductWhereInput = {
      category: query.category,
      status: query.status,
      ...(lowStockIds && { id: { in: lowStockIds } }),
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

    return paginate(data.map(withLowStockFlag), total, page, limit);
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    return withLowStockFlag(product);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOne(id);
    await this.assertCodesAreUnique(dto, id);
    const product = await this.prisma.product.update({
      where: { id },
      data: dto,
    });
    return withLowStockFlag(product);
  }

  async setStatus(id: string, status: 'ACTIVE' | 'INACTIVE') {
    await this.findOne(id);
    const product = await this.prisma.product.update({
      where: { id },
      data: { status },
    });
    return withLowStockFlag(product);
  }

  async remove(id: string) {
    await this.findOne(id);
    try {
      await this.prisma.product.delete({ where: { id } });
      return { message: 'Product deleted' };
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
