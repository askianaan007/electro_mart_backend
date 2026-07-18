import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class CategoriesService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreateCategoryDto, adminId: string) {
    const existing = await this.prisma.category.findUnique({
      where: { name: dto.name },
    });
    if (existing) throw new ConflictException('Category already exists');

    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.create({ data: dto });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_CATEGORY',
        targetId: category.id,
        details: `Created category ${category.name}`,
      });

      return category;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.CategoryWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.category.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.category.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto, adminId: string) {
    const existingCategory = await this.findOne(id);
    if (dto.name) {
      const existing = await this.prisma.category.findUnique({
        where: { name: dto.name },
      });
      if (existing && existing.id !== id)
        throw new ConflictException('Category already exists');
    }

    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.update({ where: { id }, data: dto });

      // Product.category is a denormalized free-text copy of the name, not
      // a foreign key — without this, a rename would silently orphan every
      // product still tagged with the old name (they'd drop out of
      // category filtering/browsing with no error and no way to find them).
      if (dto.name && dto.name !== existingCategory.name) {
        await tx.product.updateMany({
          where: { category: existingCategory.name },
          data: { category: dto.name },
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_CATEGORY',
        targetId: category.id,
        details:
          dto.name && dto.name !== existingCategory.name
            ? `Renamed category "${existingCategory.name}" to "${category.name}"`
            : `Updated category ${category.name}`,
      });

      return category;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const category = await this.findOne(id);

    // category is a free-text field on Product, not a foreign key, so this
    // delete would otherwise always "succeed" even with hundreds of
    // products still tagged with it — leaving them orphaned (unreachable
    // via category navigation) with no warning.
    const referencingCount = await this.prisma.product.count({
      where: { category: category.name },
    });
    if (referencingCount > 0) {
      throw new ConflictException(
        `${referencingCount} product(s) are still tagged with this category — reassign or clear their category before deleting it`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.category.delete({ where: { id } });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_CATEGORY',
        targetId: id,
        details: `Deleted category ${category.name}`,
      });

      return { message: 'Category deleted' };
    }, TRANSACTION_OPTIONS);
  }
}
