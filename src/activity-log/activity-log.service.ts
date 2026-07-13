import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { paginate } from '../common/utils/paginate';

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
}
