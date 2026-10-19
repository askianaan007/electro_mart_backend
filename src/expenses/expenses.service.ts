import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { QueryExpensesDto } from './dto/query-expenses.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { assertNotFutureBusinessDate } from '../common/utils/business-date';
import { recordLedgerRevision } from '../common/utils/ledger-revision';
import { businessDateRange } from '../common/utils/business-date';

@Injectable()
export class ExpensesService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  create(dto: CreateExpenseDto, adminId: string) {
    assertNotFutureBusinessDate(dto.expenseDate, 'Expense date');
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
        expenseDate: businessDateRange(query.dateFrom, query.dateTo),
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        include: {
          representativeSettlement: {
            select: { id: true, settlementNumber: true, status: true },
          },
        },
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: {
        representativeSettlement: {
          select: { id: true, settlementNumber: true, status: true },
        },
      },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  /**
   * An expense created by paying a commission settlement *is* that payout:
   * editing or deleting it would change Liquid Cash while the settlement
   * stays PAID (LC-07). It's corrected only by reversing the settlement's
   * payment, which keeps the expense and posts an offsetting adjustment.
   */
  private assertNotSettlementPayout(expense: {
    representativeSettlement: { settlementNumber: string } | null;
  }) {
    if (expense.representativeSettlement) {
      throw new BadRequestException(
        `This expense is the payout of commission settlement ${expense.representativeSettlement.settlementNumber} and can't be edited or deleted. Reverse the settlement's payment instead.`,
      );
    }
  }

  async update(id: string, dto: UpdateExpenseDto, adminId: string) {
    const existing = await this.findOne(id);
    this.assertNotSettlementPayout(existing);
    if (dto.expenseDate) {
      assertNotFutureBusinessDate(dto.expenseDate, 'Expense date');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertUnlinked(tx, id);
      await recordLedgerRevision(tx, 'EXPENSE', existing, 'UPDATED', adminId);

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
        details: `Updated expense "${expense.description}": ${existing.amount.toString()} -> ${expense.amount.toString()}`,
      });

      return expense;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const expense = await this.findOne(id);
    this.assertNotSettlementPayout(expense);

    return this.prisma.$transaction(async (tx) => {
      await this.assertUnlinked(tx, id);
      await recordLedgerRevision(tx, 'EXPENSE', expense, 'DELETED', adminId);
      const deleted = await tx.expense.deleteMany({ where: { id } });
      if (deleted.count === 0) {
        throw new ConflictException('This expense was already deleted');
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_EXPENSE',
        targetId: id,
        details: `Deleted expense "${expense.description}" of ${expense.amount.toString()}`,
      });

      return { message: 'Expense deleted' };
    }, TRANSACTION_OPTIONS);
  }

  private async assertUnlinked(
    tx: Prisma.TransactionClient,
    expenseId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${expenseId} FOR UPDATE`;
    const link = await tx.representativeSettlement.findUnique({
      where: { expenseId },
      select: { settlementNumber: true },
    });
    this.assertNotSettlementPayout({ representativeSettlement: link });
  }
}
