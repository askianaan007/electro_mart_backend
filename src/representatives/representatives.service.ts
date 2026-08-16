import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentScopeType,
  OrderStatus,
  Prisma,
  RepresentativeStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { RepActivityLogService } from '../rep-activity-log/rep-activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateRepresentativeDto } from './dto/create-representative.dto';
import { UpdateRepresentativeDto } from './dto/update-representative.dto';
import { QueryRepresentativeDto } from './dto/query-representative.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { generateTempPassword } from '../common/utils/generate-password';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';

const PASSWORD_SALT_ROUNDS = 10;

@Injectable()
export class RepresentativesService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private repActivityLogService: RepActivityLogService,
    private mailer: MailerService,
  ) {}

  async create(dto: CreateRepresentativeDto, adminId: string) {
    const existingEmail = await this.prisma.representative.findUnique({
      where: { email: dto.email },
    });
    if (existingEmail) throw new ConflictException('Email already in use');

    if (dto.nicOrEmployeeId) {
      const existingNic = await this.prisma.representative.findUnique({
        where: { nicOrEmployeeId: dto.nicOrEmployeeId },
      });
      if (existingNic) {
        throw new ConflictException('NIC / Employee ID already in use');
      }
    }

    const tempPassword = dto.password ?? generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, PASSWORD_SALT_ROUNDS);

    const representative = await this.prisma.$transaction(async (tx) => {
      const created = await tx.representative.create({
        data: {
          name: dto.name,
          phone: dto.phone,
          email: dto.email,
          username: dto.email, // email doubles as the login username (§4)
          address: dto.address,
          nicOrEmployeeId: dto.nicOrEmployeeId,
          joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
          password: hashed,
          status: dto.status ?? RepresentativeStatus.ACTIVE,
          mustChangePassword: true,
        },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_REPRESENTATIVE',
        targetId: created.id,
        details: `Created representative ${created.name} (${created.email})`,
      });

      return created;
    }, TRANSACTION_OPTIONS);

    await this.mailer.notifyRepWelcome(
      representative.email,
      representative.name,
      representative.username,
      tempPassword,
    );

    return {
      representative,
      temporaryPassword: dto.password ? undefined : tempPassword,
    };
  }

  async findAll(query: QueryRepresentativeDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.RepresentativeWhereInput = {
      status: query.status,
      ...(query.search && {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
          { username: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.representative.findMany({
        where,
        omit: { password: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representative.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const representative = await this.prisma.representative.findUnique({
      where: { id },
      omit: { password: true },
    });
    if (!representative)
      throw new NotFoundException('Representative not found');

    const [totalCustomers, totalOrders, completedOrdersAgg] =
      await this.prisma.$transaction([
        this.prisma.dealer.count({ where: { createdByRepId: id } }),
        this.prisma.order.count({ where: { createdByRepId: id } }),
        this.prisma.order.aggregate({
          where: { createdByRepId: id, status: OrderStatus.COMPLETED },
          _sum: { totalAmount: true },
        }),
      ]);

    return {
      ...representative,
      summary: {
        totalCustomers,
        totalOrders,
        lifetimeCompletedValue: completedOrdersAgg._sum.totalAmount ?? 0,
      },
    };
  }

  async update(id: string, dto: UpdateRepresentativeDto, adminId: string) {
    await this.findOne(id);

    if (dto.email) {
      const existing = await this.prisma.representative.findUnique({
        where: { email: dto.email },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('Email already in use');
      }
    }
    if (dto.nicOrEmployeeId) {
      const existing = await this.prisma.representative.findUnique({
        where: { nicOrEmployeeId: dto.nicOrEmployeeId },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException('NIC / Employee ID already in use');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const representative = await tx.representative.update({
        where: { id },
        data: {
          name: dto.name,
          phone: dto.phone,
          // email and username are kept in lockstep — email is always the login identifier (§4).
          email: dto.email,
          username: dto.email,
          address: dto.address,
          nicOrEmployeeId: dto.nicOrEmployeeId,
          joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
          status: dto.status,
        },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_REPRESENTATIVE',
        targetId: representative.id,
        details: `Updated representative ${representative.name}`,
      });

      return representative;
    }, TRANSACTION_OPTIONS);
  }

  async setStatus(id: string, status: RepresentativeStatus, adminId: string) {
    const existing = await this.findOne(id);

    const representative = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.representative.update({
        where: { id },
        data: { status },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: `REPRESENTATIVE_${status}`,
        targetId: updated.id,
        details: `Representative ${updated.name} set to ${status}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);

    if (existing.status !== status) {
      await this.mailer.notifyRepStatusChanged(
        representative.email,
        representative.name,
        status,
      );
    }

    return representative;
  }

  async resetPassword(id: string, adminId: string) {
    const representative = await this.findOne(id);

    const temporaryPassword = generateTempPassword();
    const hashed = await bcrypt.hash(temporaryPassword, PASSWORD_SALT_ROUNDS);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.representative.update({
        where: { id },
        data: { password: hashed, mustChangePassword: true },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RESET_REPRESENTATIVE_PASSWORD',
        targetId: result.id,
        details: `Reset password for representative ${result.name} (${result.username})`,
      });

      return result;
    }, TRANSACTION_OPTIONS);

    await this.mailer.notifyRepPasswordReset(
      representative.email,
      updated.name,
      updated.username,
      temporaryPassword,
    );

    return { representative: updated, temporaryPassword };
  }

  async forcePasswordChange(id: string, adminId: string) {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.representative.update({
        where: { id },
        data: { mustChangePassword: true },
        omit: { password: true },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'FORCED_REPRESENTATIVE_PASSWORD_CHANGE',
        targetId: id,
        details: `Forced a password change for representative ${updated.name} on next login`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async unlock(id: string, adminId: string) {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.representative.update({
        where: { id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
        omit: { password: true },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'UNLOCKED_REPRESENTATIVE',
        targetId: id,
        details: `Cleared login lockout for representative ${updated.name}`,
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async remove(id: string, adminId: string) {
    const representative = await this.findOne(id);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.deleteMany({
          where: { userId: id, role: 'REPRESENTATIVE' },
        });
        await tx.representative.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_REPRESENTATIVE',
          targetId: id,
          details: `Deleted representative ${representative.name} (${representative.username})`,
        });
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This representative has customers, orders, or other related records and cannot be deleted. Set their status to Blocked instead.',
        );
      }
      throw error;
    }
    return { message: 'Representative deleted' };
  }

  // -------------------------------------------------------------------
  // Detail-tab sub-endpoints (version2_changes_backend.md §3) — all
  // read-only aggregations, no interaction with the order/payment pipeline.
  // -------------------------------------------------------------------

  async getLoginHistory(id: string, query: PaginationQueryDto) {
    await this.findOne(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { representativeId: id };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.representativeLoginHistory.findMany({
        where,
        orderBy: { loginAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representativeLoginHistory.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  async getActivityLog(id: string, query: PaginationQueryDto) {
    await this.findOne(id);
    return this.repActivityLogService.findAllForRepresentative(id, query);
  }

  async clearActivityLog(id: string, adminId: string) {
    await this.findOne(id);
    return this.repActivityLogService.clearForRepresentative(id, adminId);
  }

  async getSalesStats(id: string) {
    await this.findOne(id);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(
      startOfToday.getFullYear(),
      startOfToday.getMonth(),
      1,
    );

    const where = { createdByRepId: id };
    const [
      todaysOrders,
      monthlyOrders,
      pendingOrders,
      completedOrders,
      revenueAgg,
    ] = await this.prisma.$transaction([
      this.prisma.order.count({
        where: { ...where, createdAt: { gte: startOfToday } },
      }),
      this.prisma.order.count({
        where: { ...where, createdAt: { gte: startOfMonth } },
      }),
      this.prisma.order.count({
        where: { ...where, status: OrderStatus.PENDING_APPROVAL },
      }),
      this.prisma.order.count({
        where: { ...where, status: OrderStatus.COMPLETED },
      }),
      this.prisma.order.aggregate({
        where: { ...where, status: OrderStatus.COMPLETED },
        _sum: { totalAmount: true },
      }),
    ]);

    return {
      todaysOrders,
      monthlyOrders,
      pendingOrders,
      completedOrders,
      revenue: revenueAgg._sum.totalAmount ?? 0,
    };
  }

  async getCommissionStats(id: string) {
    await this.findOne(id);
    const [pendingAgg, approvedAgg, settledAgg] =
      await this.prisma.$transaction([
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId: id, status: 'PENDING' },
          _sum: { amount: true },
        }),
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId: id, status: 'APPROVED' },
          _sum: { amount: true },
        }),
        this.prisma.commissionLedgerEntry.aggregate({
          where: { representativeId: id, status: 'SETTLED' },
          _sum: { amount: true },
        }),
      ]);

    return {
      pendingCommission: pendingAgg._sum.amount ?? 0,
      approvedCommission: approvedAgg._sum.amount ?? 0,
      paidCommission: settledAgg._sum.amount ?? 0,
    };
  }

  async getSettlements(id: string, query: PaginationQueryDto) {
    await this.findOne(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { representativeId: id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.representativeSettlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.representativeSettlement.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }

  async getAssignedProducts(id: string) {
    await this.findOne(id);
    return this.prisma.productAssignment.findMany({
      where: { representativeId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assignProduct(
    id: string,
    scopeType: AssignmentScopeType,
    scopeValue: string,
    adminId: string,
  ) {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.productAssignment.create({
        data: { representativeId: id, scopeType, scopeValue },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'ASSIGNED_PRODUCT_SCOPE',
        targetId: id,
        details: `Assigned ${scopeType} "${scopeValue}" to representative ${id}`,
      });
      return assignment;
    }, TRANSACTION_OPTIONS);
  }

  async removeProductAssignment(
    id: string,
    assignmentId: string,
    adminId: string,
  ) {
    await this.findOne(id);
    const assignment = await this.prisma.productAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment || assignment.representativeId !== id) {
      throw new NotFoundException('Assignment not found');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.productAssignment.delete({ where: { id: assignmentId } });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'REMOVED_PRODUCT_SCOPE',
        targetId: id,
        details: `Removed ${assignment.scopeType} "${assignment.scopeValue}" from representative ${id}`,
      });
      return { message: 'Assignment removed' };
    }, TRANSACTION_OPTIONS);
  }

  async getAssignedBanners(id: string) {
    await this.findOne(id);
    return this.prisma.bannerAssignment.findMany({
      where: { representativeId: id },
      include: { banner: true },
      orderBy: { priority: 'desc' },
    });
  }

  async getAssignedCustomers(id: string, query: PaginationQueryDto) {
    await this.findOne(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.DealerWhereInput = { createdByRepId: id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.dealer.findMany({
        where,
        omit: { password: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.dealer.count({ where }),
    ]);
    return paginate(data, total, page, limit);
  }
}
