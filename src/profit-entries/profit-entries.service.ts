import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProfitEntryDto } from './dto/create-profit-entry.dto';
import { UpdateProfitEntryDto } from './dto/update-profit-entry.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';

@Injectable()
export class ProfitEntriesService {
  constructor(private prisma: PrismaService) {}

  create(dto: CreateProfitEntryDto) {
    return this.prisma.profitEntry.create({
      data: {
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
        amount: dto.amount,
        remarks: dto.remarks,
      },
    });
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.profitEntry.findMany({
        orderBy: { periodStart: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.profitEntry.count(),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const entry = await this.prisma.profitEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Profit entry not found');
    return entry;
  }

  async update(id: string, dto: UpdateProfitEntryDto) {
    await this.findOne(id);
    return this.prisma.profitEntry.update({
      where: { id },
      data: {
        periodStart: dto.periodStart ? new Date(dto.periodStart) : undefined,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
        amount: dto.amount,
        remarks: dto.remarks,
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.profitEntry.delete({ where: { id } });
    return { message: 'Profit entry deleted' };
  }
}
