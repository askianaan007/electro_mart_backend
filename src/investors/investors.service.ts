import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateInvestorDto } from './dto/create-investor.dto';
import { UpdateInvestorDto } from './dto/update-investor.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class InvestorsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  /**
   * Each investor's profitSharePercentage is individually capped at 0-100
   * by the DTO, but nothing stopped the *sum* across investors from
   * exceeding 100% — which double-counts profit/expense allocation in
   * equity.service.ts (e.g. three investors at 40% each = 120%, so 20% of
   * profit gets attributed twice). Under 100% is left valid — a company can
   * legitimately keep a remainder unallocated — only the over-100 direction
   * is an actual bug.
   */
  private async assertProfitShareWithinLimit(
    newPercentage: number,
    excludeId?: string,
  ) {
    const others = await this.prisma.investor.findMany({
      where: excludeId ? { id: { not: excludeId } } : {},
      select: { profitSharePercentage: true },
    });
    const othersTotal = others.reduce(
      (sum, inv) => sum.add(inv.profitSharePercentage),
      new Prisma.Decimal(0),
    );
    const projected = othersTotal.add(newPercentage);
    if (projected.greaterThan(100)) {
      throw new ConflictException(
        `This would bring total investor profit share to ${projected.toString()}%, which exceeds 100%`,
      );
    }
  }

  async create(dto: CreateInvestorDto, adminId: string) {
    await this.assertProfitShareWithinLimit(dto.profitSharePercentage);

    return this.prisma.$transaction(async (tx) => {
      const investor = await tx.investor.create({ data: dto });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_INVESTOR',
        targetId: investor.id,
        details: `Added investor ${investor.name} (${investor.profitSharePercentage.toString()}% share)`,
      });

      return investor;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvestorWhereInput = query.search
      ? { name: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.investor.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.investor.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const investor = await this.prisma.investor.findUnique({ where: { id } });
    if (!investor) throw new NotFoundException('Investor not found');
    return investor;
  }

  async update(id: string, dto: UpdateInvestorDto, adminId: string) {
    await this.findOne(id);
    if (dto.profitSharePercentage !== undefined) {
      await this.assertProfitShareWithinLimit(dto.profitSharePercentage, id);
    }

    return this.prisma.$transaction(async (tx) => {
      const investor = await tx.investor.update({ where: { id }, data: dto });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_INVESTOR',
        targetId: investor.id,
        details: `Updated investor ${investor.name}`,
      });

      return investor;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const investor = await this.findOne(id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.investor.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_INVESTOR',
          targetId: id,
          details: `Deleted investor ${investor.name}`,
        });

        return { message: 'Investor deleted' };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This investor has investment history and cannot be deleted',
        );
      }
      throw error;
    }
  }
}
