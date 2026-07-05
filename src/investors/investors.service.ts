import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvestorDto } from './dto/create-investor.dto';
import { UpdateInvestorDto } from './dto/update-investor.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';

@Injectable()
export class InvestorsService {
  constructor(private prisma: PrismaService) {}

  create(dto: CreateInvestorDto) {
    return this.prisma.investor.create({ data: dto });
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

  async update(id: string, dto: UpdateInvestorDto) {
    await this.findOne(id);
    return this.prisma.investor.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id);
    try {
      await this.prisma.investor.delete({ where: { id } });
      return { message: 'Investor deleted' };
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
