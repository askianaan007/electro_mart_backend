import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { QueryInvestmentDto } from './dto/query-investment.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class InvestmentsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreateInvestmentDto, adminId: string) {
    const investor = await this.prisma.investor.findUnique({
      where: { id: dto.investorId },
    });
    if (!investor) throw new NotFoundException('Investor not found');

    return this.prisma.$transaction(async (tx) => {
      const investment = await tx.investment.create({
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

      const isWithdrawal = Number(investment.amount) < 0;
      await this.activityLogService.log(tx, {
        adminId,
        action: isWithdrawal ? 'RECORDED_WITHDRAWAL' : 'RECORDED_INVESTMENT',
        targetId: investment.id,
        details: `${isWithdrawal ? 'Withdrawal' : 'Investment'} of ${Math.abs(Number(investment.amount))} for ${investment.investor.name} (${investment.reason})`,
      });

      return investment;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: QueryInvestmentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvestmentWhereInput = {
      investorId: query.investorId,
      ...(query.type === 'DEPOSIT' && { amount: { gt: 0 } }),
      ...(query.type === 'WITHDRAWAL' && { amount: { lt: 0 } }),
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

  async update(id: string, dto: UpdateInvestmentDto, adminId: string) {
    await this.findOne(id);

    if (dto.investorId) {
      const investor = await this.prisma.investor.findUnique({
        where: { id: dto.investorId },
      });
      if (!investor) throw new NotFoundException('Investor not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const investment = await tx.investment.update({
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

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_INVESTMENT',
        targetId: investment.id,
        details: `Updated ${Number(investment.amount) < 0 ? 'withdrawal' : 'investment'} entry for ${investment.investor.name} to ${Math.abs(Number(investment.amount))}`,
      });

      return investment;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const investment = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.investment.delete({ where: { id } });

      const isWithdrawal = Number(investment.amount) < 0;
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_INVESTMENT',
        targetId: id,
        details: `Deleted ${isWithdrawal ? 'withdrawal' : 'investment'} of ${Math.abs(Number(investment.amount))} for ${investment.investor.name}`,
      });

      return { message: 'Investment deleted' };
    }, TRANSACTION_OPTIONS);
  }
}
