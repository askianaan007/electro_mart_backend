import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class SuppliersService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  create(dto: CreateSupplierDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: dto });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_SUPPLIER',
        targetId: supplier.id,
        details: `Created supplier ${supplier.name}`,
      });

      return supplier;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SupplierWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  async update(id: string, dto: UpdateSupplierDto, adminId: string) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({ where: { id }, data: dto });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_SUPPLIER',
        targetId: supplier.id,
        details: `Updated supplier ${supplier.name}`,
      });

      return supplier;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const supplier = await this.findOne(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.supplier.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_SUPPLIER',
          targetId: id,
          details: `Deleted supplier ${supplier.name}`,
        });

        return { message: 'Supplier deleted' };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This supplier has purchase history and cannot be deleted',
        );
      }
      throw error;
    }
  }
}
