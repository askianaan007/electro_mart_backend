import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

type TransactionClient = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActivityLogService {
  constructor(private prisma: PrismaService) {}

  log(
    tx: TransactionClient,
    params: {
      adminId: string;
      action: string;
      targetId?: string;
      details?: string;
    },
  ) {
    return tx.activityLog.create({ data: params });
  }

  async findAll(query: QueryActivityLogDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const actions = query.action?.split(',').filter(Boolean);

    const where: Prisma.ActivityLogWhereInput = {
      ...(actions &&
        actions.length > 0 && {
          action: actions.length === 1 ? actions[0] : { in: actions },
        }),
      ...(query.adminId && { adminId: query.adminId }),
      ...((query.dateFrom || query.dateTo) && {
        createdAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && {
            lt: new Date(new Date(query.dateTo).getTime() + DAY_MS),
          }),
        },
      }),
      ...(query.search && {
        OR: [
          { details: { contains: query.search, mode: 'insensitive' } },
          { action: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.activityLog.findMany({
        where,
        include: { admin: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.activityLog.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  listAdmins() {
    return this.prisma.admin.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Wipes every existing entry, then writes one fresh entry recording the
   * clear itself (who did it and how many were removed) — so the audit
   * trail isn't left with zero evidence that a clear happened.
   */
  async clearAll(adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.activityLog.deleteMany({});
      await this.log(tx, {
        adminId,
        action: 'CLEARED_ACTIVITY_LOG',
        details: `Cleared ${count} activity log entr${count === 1 ? 'y' : 'ies'}`,
      });
      return { message: 'Activity log cleared', count };
    }, TRANSACTION_OPTIONS);
  }
}
