import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, OrderStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateDealerDto } from './dto/create-dealer.dto';
import { UpdateDealerDto } from './dto/update-dealer.dto';
import { QueryDealerDto } from './dto/query-dealer.dto';
import { paginate } from '../common/utils/paginate';
import { generateTempPassword } from '../common/utils/generate-password';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const PASSWORD_SALT_ROUNDS = 10;

@Injectable()
export class DealersService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
  ) {}

  async create(dto: CreateDealerDto, adminId: string) {
    const existingUsername = await this.prisma.dealer.findUnique({
      where: { username: dto.username },
    });
    if (existingUsername)
      throw new ConflictException('Username already in use');

    if (dto.email) {
      const existingEmail = await this.prisma.dealer.findUnique({
        where: { email: dto.email },
      });
      if (existingEmail) throw new ConflictException('Email already in use');
    }

    const tempPassword = dto.password ?? generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, PASSWORD_SALT_ROUNDS);

    const dealer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dealer.create({
        data: {
          businessName: dto.businessName,
          ownerName: dto.ownerName,
          phone: dto.phone,
          email: dto.email,
          address: dto.address,
          district: dto.district,
          username: dto.username,
          password: hashed,
          creditLimit: dto.creditLimit ?? 0,
          unlimitedCredit: dto.unlimitedCredit ?? false,
          status: dto.status ?? AccountStatus.ACTIVE,
        },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_DEALER',
        targetId: created.id,
        details: `Created dealer ${created.businessName} (${created.username})`,
      });

      return created;
    }, TRANSACTION_OPTIONS);

    if (dealer.email) {
      await this.mailer.notifyDealerWelcome(
        dealer.email,
        dealer.businessName,
        dealer.username,
        tempPassword,
      );
    }

    return {
      dealer,
      temporaryPassword: dto.password ? undefined : tempPassword,
    };
  }

  async findAll(query: QueryDealerDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.DealerWhereInput = {
      status: query.status,
      ...(query.search && {
        OR: [
          { businessName: { contains: query.search, mode: 'insensitive' } },
          { ownerName: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
          { username: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

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

  async findOne(id: string) {
    const dealer = await this.prisma.dealer.findUnique({
      where: { id },
      omit: { password: true },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');

    const [totalOrders, completedOrdersAgg, totalInvoices] =
      await this.prisma.$transaction([
        this.prisma.order.count({ where: { dealerId: id } }),
        this.prisma.order.aggregate({
          where: { dealerId: id, status: OrderStatus.COMPLETED },
          _sum: { totalAmount: true },
        }),
        this.prisma.invoice.count({ where: { dealerId: id } }),
      ]);

    return {
      ...dealer,
      summary: {
        totalOrders,
        totalInvoices,
        lifetimeCompletedValue: completedOrdersAgg._sum.totalAmount ?? 0,
      },
    };
  }

  async update(id: string, dto: UpdateDealerDto, adminId: string) {
    await this.findOne(id);

    if (dto.username) {
      const existing = await this.prisma.dealer.findUnique({
        where: { username: dto.username },
      });
      if (existing && existing.id !== id)
        throw new ConflictException('Username already in use');
    }

    if (dto.email) {
      const existingEmail = await this.prisma.dealer.findUnique({
        where: { email: dto.email },
      });
      if (existingEmail && existingEmail.id !== id)
        throw new ConflictException('Email already in use');
    }

    const data: Prisma.DealerUpdateInput = {
      businessName: dto.businessName,
      ownerName: dto.ownerName,
      phone: dto.phone,
      email: dto.email,
      address: dto.address,
      district: dto.district,
      username: dto.username,
      creditLimit: dto.creditLimit,
      unlimitedCredit: dto.unlimitedCredit,
      status: dto.status,
    };

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    }

    return this.prisma.$transaction(async (tx) => {
      const dealer = await tx.dealer.update({
        where: { id },
        data,
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_DEALER',
        targetId: dealer.id,
        details: `Updated dealer ${dealer.businessName}`,
      });

      return dealer;
    }, TRANSACTION_OPTIONS);
  }

  async setStatus(id: string, status: AccountStatus, adminId: string) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      const dealer = await tx.dealer.update({
        where: { id },
        data: { status },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: `DEALER_${status}`,
        targetId: dealer.id,
        details: `Dealer ${dealer.businessName} set to ${status}`,
      });

      return dealer;
    }, TRANSACTION_OPTIONS);
  }
}
