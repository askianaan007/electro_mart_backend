import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

type TransactionClient = Prisma.TransactionClient;

/**
 * Representative Portal v2.1 (version2_changes_backend.md §13) — a dedicated,
 * richer (IP/device) audit trail for representatives, deliberately separate
 * from the existing, unmodified ActivityLogService/ActivityLog (admin-scoped).
 * Reps get read-only access to their own log; only an admin can clear it.
 */
@Injectable()
export class RepActivityLogService {
  constructor(private prisma: PrismaService) {}

  log(
    tx: TransactionClient,
    params: {
      representativeId: string;
      action: string;
      targetId?: string;
      details?: string;
      ipAddress?: string;
      userAgent?: string;
      deviceType?: string;
    },
  ) {
    return tx.representativeActivityLog.create({ data: params });
  }

  async findAllForRepresentative(
    representativeId: string,
    query: PaginationQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 30;

    const where: Prisma.RepresentativeActivityLogWhereInput = {
      representativeId,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.representativeActivityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representativeActivityLog.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async clearForRepresentative(representativeId: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.representativeActivityLog.deleteMany({
        where: { representativeId },
      });
      // Recorded in the existing, unmodified admin ActivityLog — this is an
      // admin action, logged the same way every other admin action already is.
      await tx.activityLog.create({
        data: {
          adminId,
          action: 'CLEARED_REP_ACTIVITY_LOG',
          targetId: representativeId,
          details: `Cleared ${count} activity log entr${count === 1 ? 'y' : 'ies'} for representative ${representativeId}`,
        },
      });
      return { message: 'Activity log cleared', count };
    }, TRANSACTION_OPTIONS);
  }
}
