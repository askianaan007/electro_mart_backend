import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { QueryExpensesDto } from './dto/query-expenses.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  create(dto: CreateExpenseDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          description: dto.description,
          amount: dto.amount,
          expenseDate: new Date(dto.expenseDate),
          remarks: dto.remarks,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_EXPENSE',
        targetId: expense.id,
        details: `Recorded expense "${expense.description}" of ${expense.amount.toString()}`,
      });

      return expense;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: QueryExpensesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ExpenseWhereInput = {
      ...(query.search && {
        description: { contains: query.search, mode: 'insensitive' },
      }),
      ...((query.dateFrom || query.dateTo) && {
        expenseDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  async update(id: string, dto: UpdateExpenseDto, adminId: string) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.update({
        where: { id },
        data: {
          description: dto.description,
          amount: dto.amount,
          expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : undefined,
          remarks: dto.remarks,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_EXPENSE',
        targetId: expense.id,
        details: `Updated expense "${expense.description}" to ${expense.amount.toString()}`,
      });

      return expense;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const expense = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id } });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_EXPENSE',
        targetId: id,
        details: `Deleted expense "${expense.description}" of ${expense.amount.toString()}`,
      });

      return { message: 'Expense deleted' };
    }, TRANSACTION_OPTIONS);
  }
}
