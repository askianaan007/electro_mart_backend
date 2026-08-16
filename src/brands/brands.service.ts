import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

/**
 * Mirrors CategoriesService exactly (Rep_Portal_DOCUMENTATION.md §8.1) —
 * Product.brand stays a denormalized free-text string, never an FK, for the
 * same reasoning already applied to Category.
 */
@Injectable()
export class BrandsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private uploadsService: UploadsService,
  ) {}

  async create(dto: CreateBrandDto, adminId: string) {
    const existing = await this.prisma.brand.findUnique({
      where: { name: dto.name },
    });
    if (existing) throw new ConflictException('Brand already exists');

    return this.prisma.$transaction(async (tx) => {
      const brand = await tx.brand.create({ data: dto });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_BRAND',
        targetId: brand.id,
        details: `Created brand ${brand.name}`,
      });
      return brand;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.BrandWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.brand.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.brand.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async update(id: string, dto: UpdateBrandDto, adminId: string) {
    const existing = await this.findOne(id);
    if (dto.name) {
      const dup = await this.prisma.brand.findUnique({
        where: { name: dto.name },
      });
      if (dup && dup.id !== id)
        throw new ConflictException('Brand already exists');
    }

    return this.prisma.$transaction(async (tx) => {
      const brand = await tx.brand.update({ where: { id }, data: dto });

      // Product.brand is a denormalized free-text copy, exactly like
      // Category.name — a rename cascades the same way (categories.service.ts).
      if (dto.name && dto.name !== existing.name) {
        await tx.product.updateMany({
          where: { brand: existing.name },
          data: { brand: dto.name },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_BRAND',
        targetId: brand.id,
        details:
          dto.name && dto.name !== existing.name
            ? `Renamed brand "${existing.name}" to "${brand.name}"`
            : `Updated brand ${brand.name}`,
      });

      return brand;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const brand = await this.findOne(id);

    const referencingCount = await this.prisma.product.count({
      where: { brand: brand.name },
    });
    if (referencingCount > 0) {
      throw new ConflictException(
        `${referencingCount} product(s) are still tagged with this brand — reassign or clear their brand before deleting it`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.brand.delete({ where: { id } });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_BRAND',
        targetId: id,
        details: `Deleted brand ${brand.name}`,
      });
    }, TRANSACTION_OPTIONS);

    if (brand.logoPublicId)
      await this.uploadsService.deleteImage(brand.logoPublicId);
    if (brand.imagePublicId)
      await this.uploadsService.deleteImage(brand.imagePublicId);

    return { message: 'Brand deleted' };
  }

  async uploadLogo(id: string, file: Express.Multer.File, adminId: string) {
    const brand = await this.findOne(id);
    const uploaded = await this.uploadsService.uploadImage(
      file.buffer,
      'brands',
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.update({
        where: { id },
        data: { logoUrl: uploaded.url, logoPublicId: uploaded.publicId },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_BRAND_LOGO',
        targetId: id,
        details: `Updated logo for brand ${brand.name}`,
      });
      return result;
    }, TRANSACTION_OPTIONS);

    if (brand.logoPublicId)
      await this.uploadsService.deleteImage(brand.logoPublicId);
    return updated;
  }

  async uploadImage(id: string, file: Express.Multer.File, adminId: string) {
    const brand = await this.findOne(id);
    const uploaded = await this.uploadsService.uploadImage(
      file.buffer,
      'brands',
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.update({
        where: { id },
        data: { imageUrl: uploaded.url, imagePublicId: uploaded.publicId },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_BRAND_IMAGE',
        targetId: id,
        details: `Updated hero image for brand ${brand.name}`,
      });
      return result;
    }, TRANSACTION_OPTIONS);

    if (brand.imagePublicId)
      await this.uploadsService.deleteImage(brand.imagePublicId);
    return updated;
  }
}
