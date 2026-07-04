import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';

type TransactionClient = Prisma.TransactionClient;

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

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.activityLog.findMany({
        include: { admin: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.activityLog.count(),
    ]);

    return paginate(data, total, page, limit);
  }
}
