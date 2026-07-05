import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { QueryInvestmentDto } from './dto/query-investment.dto';
import { paginate } from '../common/utils/paginate';

@Injectable()
export class InvestmentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInvestmentDto) {
    const investor = await this.prisma.investor.findUnique({
      where: { id: dto.investorId },
    });
    if (!investor) throw new NotFoundException('Investor not found');

    return this.prisma.investment.create({
      data: {
        investorId: dto.investorId,
        amount: dto.amount,
        mode: dto.mode,
        investmentDate: new Date(dto.investmentDate),
        reason: dto.reason,
        remarks: dto.remarks,
      },
      include: { investor: true },
    });
  }

  async findAll(query: QueryInvestmentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvestmentWhereInput = {
      investorId: query.investorId,
      ...(query.search && {
        reason: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.investment.findMany({
        where,
        include: { investor: true },
        orderBy: { investmentDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.investment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const investment = await this.prisma.investment.findUnique({
      where: { id },
      include: { investor: true },
    });
    if (!investment) throw new NotFoundException('Investment not found');
    return investment;
  }

  async update(id: string, dto: UpdateInvestmentDto) {
    await this.findOne(id);

    if (dto.investorId) {
      const investor = await this.prisma.investor.findUnique({
        where: { id: dto.investorId },
      });
      if (!investor) throw new NotFoundException('Investor not found');
    }

    return this.prisma.investment.update({
      where: { id },
      data: {
        investorId: dto.investorId,
        amount: dto.amount,
        mode: dto.mode,
        investmentDate: dto.investmentDate
          ? new Date(dto.investmentDate)
          : undefined,
        reason: dto.reason,
        remarks: dto.remarks,
      },
      include: { investor: true },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.investment.delete({ where: { id } });
    return { message: 'Investment deleted' };
  }
}
