import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { InventoryService } from '../inventory/inventory.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

export const MAX_PRODUCT_IMAGES = 5;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

function withStockFlag<T extends { currentStock: number }>(product: T) {
  return {
    ...product,
    isOutOfStock: product.currentStock <= 0,
  };
}

@Injectable()
export class ProductsService {
  private readonly imagesInclude = {
    images: { orderBy: { sortOrder: 'asc' } },
  } satisfies Prisma.ProductInclude;

  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private inventoryService: InventoryService,
    private uploadsService: UploadsService,
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
      let created = await tx.product.create({
        data: {
          ...dto,
          currentStock: 0,
        },
      });

      if (dto.currentStock && dto.currentStock > 0) {
        created = await this.inventoryService.recordMovement(tx, {
          productId: created.id,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: dto.currentStock,
          reference: 'Opening stock',
        });
      }

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
        include: this.imagesInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginate(data.map(withStockFlag), total, page, limit);
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.imagesInclude,
    });
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
    let result: { message: string };
    try {
      result = await this.prisma.$transaction(async (tx) => {
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

    await Promise.all(
      product.images.map((image) => this.uploadsService.deleteImage(image.publicId)),
    );

    return result;
  }

  async addImages(
    id: string,
    files: Express.Multer.File[],
    adminId: string,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.imagesInclude,
    });
    if (!product) throw new NotFoundException('Product not found');
    if (files.length === 0) {
      throw new BadRequestException('No image files were provided');
    }
    if (product.images.length + files.length > MAX_PRODUCT_IMAGES) {
      throw new BadRequestException(
        `A product can have at most ${MAX_PRODUCT_IMAGES} images (${product.images.length} already uploaded)`,
      );
    }

    const uploaded = await Promise.all(
      files.map((file) =>
        this.uploadsService.uploadImage(file.buffer, 'products'),
      ),
    );

    const startOrder = product.images.length;
    return this.prisma.$transaction(async (tx) => {
      const created = await Promise.all(
        uploaded.map((image, index) =>
          tx.productImage.create({
            data: {
              productId: id,
              url: image.url,
              publicId: image.publicId,
              sortOrder: startOrder + index,
            },
          }),
        ),
      );

      if (!product.imageUrl) {
        await tx.product.update({
          where: { id },
          data: { imageUrl: uploaded[0].url },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'ADDED_PRODUCT_IMAGES',
        targetId: id,
        details: `Added ${files.length} image(s) to product ${product.name}`,
      });

      return created;
    }, TRANSACTION_OPTIONS);
  }

  async removeImage(id: string, imageId: string, adminId: string) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });
    if (!image || image.productId !== id) {
      throw new NotFoundException('Image not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: imageId } });

      const remaining = await tx.productImage.findFirst({
        where: { productId: id },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.product.update({
        where: { id },
        data: { imageUrl: remaining?.url ?? null },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REMOVED_PRODUCT_IMAGE',
        targetId: id,
      });
    }, TRANSACTION_OPTIONS);

    await this.uploadsService.deleteImage(image.publicId);

    return { message: 'Image removed' };
  }
}
