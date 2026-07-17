import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AccountStatus,
  InventoryLogType,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { InventoryService } from '../inventory/inventory.service';
import { CreateDealerDto } from './dto/create-dealer.dto';
import { UpdateDealerDto } from './dto/update-dealer.dto';
import { QueryDealerDto } from './dto/query-dealer.dto';
import { paginate } from '../common/utils/paginate';
import { generateTempPassword } from '../common/utils/generate-password';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';

const PASSWORD_SALT_ROUNDS = 10;

@Injectable()
export class DealersService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
    private inventoryService: InventoryService,
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

  async resetPassword(id: string, adminId: string) {
    const dealer = await this.findOne(id);

    const temporaryPassword = generateTempPassword();
    const hashed = await bcrypt.hash(temporaryPassword, PASSWORD_SALT_ROUNDS);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dealer.update({
        where: { id },
        data: { password: hashed },
        omit: { password: true },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RESET_DEALER_PASSWORD',
        targetId: result.id,
        details: `Reset password for dealer ${result.businessName} (${result.username})`,
      });

      return result;
    }, TRANSACTION_OPTIONS);

    if (dealer.email) {
      await this.mailer.notifyDealerPasswordReset(
        dealer.email,
        updated.businessName,
        updated.username,
        temporaryPassword,
      );
    }

    return { dealer: updated, temporaryPassword };
  }

  async remove(id: string, adminId: string) {
    const dealer = await this.findOne(id);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.deleteMany({
          where: { userId: id, role: Role.DEALER },
        });

        await tx.dealer.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_DEALER',
          targetId: id,
          details: `Deleted dealer ${dealer.businessName} (${dealer.username})`,
        });
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This dealer has orders, invoices, payments, or return records and cannot be deleted. Deactivate it instead.',
        );
      }
      throw error;
    }

    return { message: 'Dealer deleted' };
  }

  /**
   * Wipes every transactional record tied to this dealer — orders, invoices,
   * payments, and sales returns — while keeping the dealer's own profile
   * (name/username/credit terms) intact. Reverses each order's stock
   * reservation and each sales return's stock addition via recordMovement,
   * so product stock ends up exactly where purchases (untouched by this)
   * left it. Never touches suppliers, purchases, investments, or expenses —
   * those have no dealerId and this only ever queries/deletes by dealerId.
   * Requires the admin to re-confirm their own password, since this is
   * irreversible and has no other safety net (unlike single-order deletion,
   * it deliberately does not block on existing payments).
   */
  async clearDealerData(id: string, adminId: string, password: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    const passwordValid = await bcrypt.compare(password, admin.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Incorrect password');
    }

    const dealer = await this.prisma.dealer.findUnique({ where: { id } });
    if (!dealer) throw new NotFoundException('Dealer not found');

    const orders = await this.prisma.order.findMany({
      where: { dealerId: id },
      include: {
        items: true,
        invoice: { include: { payments: true } },
        salesReturns: { include: { items: true } },
      },
    });

    const summary = {
      orders: orders.length,
      invoices: orders.filter((o) => o.invoice).length,
      payments: orders.reduce(
        (sum, o) => sum + (o.invoice?.payments.length ?? 0),
        0,
      ),
      salesReturns: orders.reduce((sum, o) => sum + o.salesReturns.length, 0),
    };

    await this.prisma.$transaction(
      async (tx) => {
        for (const order of orders) {
          for (const salesReturn of order.salesReturns) {
            for (const item of salesReturn.items) {
              await this.inventoryService.recordMovement(tx, {
                productId: item.productId,
                type: InventoryLogType.ADJUSTMENT,
                quantityOut: item.quantity,
                reference: `Reversed for data clear of dealer ${dealer.businessName}`,
              });
            }
            await tx.salesReturnItem.deleteMany({
              where: { salesReturnId: salesReturn.id },
            });
          }
          if (order.salesReturns.length > 0) {
            await tx.salesReturn.deleteMany({ where: { orderId: order.id } });
          }

          if (order.invoice) {
            await tx.payment.deleteMany({
              where: { invoiceId: order.invoice.id },
            });

            for (const item of order.items) {
              await this.inventoryService.recordMovement(tx, {
                productId: item.productId,
                type: InventoryLogType.ADJUSTMENT,
                quantityIn: item.quantity,
                reference: `Reversed for data clear of dealer ${dealer.businessName}`,
              });
            }

            await tx.invoice.delete({ where: { id: order.invoice.id } });
          }

          await tx.orderItem.deleteMany({ where: { orderId: order.id } });
          await tx.order.delete({ where: { id: order.id } });
        }

        await tx.dealer.update({
          where: { id },
          data: { outstandingBalance: 0 },
        });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'CLEARED_DEALER_DATA',
          targetId: id,
          details: `Cleared all transactional data for dealer ${dealer.businessName}: ${summary.orders} order(s), ${summary.invoices} invoice(s), ${summary.payments} payment(s), ${summary.salesReturns} sales return(s)`,
        });
      },
      { maxWait: 15000, timeout: 60000 },
    );

    return { message: 'Dealer data cleared', ...summary };
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
