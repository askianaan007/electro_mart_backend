import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  InventoryLogType,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { QueryOrderDto } from './dto/query-order.dto';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const INVOICE_DUE_DAYS = 15;

const NEXT_STATUS: Record<string, OrderStatus> = {
  PACKED: OrderStatus.APPROVED,
  DELIVERED: OrderStatus.PACKED,
  COMPLETED: OrderStatus.DELIVERED,
};

const TIMESTAMP_FIELD: Record<
  string,
  'packedAt' | 'deliveredAt' | 'completedAt'
> = {
  PACKED: 'packedAt',
  DELIVERED: 'deliveredAt',
  COMPLETED: 'completedAt',
};

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
  ) {}

  private readonly orderInclude = {
    items: { include: { product: true } },
    dealer: { omit: { password: true } },
    invoice: true,
  } satisfies Prisma.OrderInclude;

  async create(dealerId: string, dto: CreateOrderDto) {
    const dealer = await this.prisma.dealer.findUnique({
      where: { id: dealerId },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    if (dealer.status !== AccountStatus.ACTIVE)
      throw new ForbiddenException('Dealer account is inactive');

    const productIds = dto.items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );
    let subtotal = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product)
        throw new NotFoundException(`Product ${item.productId} not found`);
      if (product.status !== AccountStatus.ACTIVE) {
        throw new BadRequestException(
          `Product "${product.name}" is not available`,
        );
      }
      if (product.currentStock < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for "${product.name}"`,
        );
      }

      const lineTotal = product.wholesalePrice.mul(item.quantity);
      subtotal = subtotal.add(lineTotal);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: product.wholesalePrice,
        lineTotal,
      };
    });

    const totalAmount = subtotal;
    const projectedOutstanding = dealer.outstandingBalance.add(totalAmount);
    if (
      !dealer.unlimitedCredit &&
      projectedOutstanding.greaterThan(dealer.creditLimit)
    ) {
      throw new BadRequestException(
        'This order exceeds your available credit limit',
      );
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await nextSequenceNumber(tx, 'order', 'ORD');
      return tx.order.create({
        data: {
          orderNumber,
          dealerId,
          subtotal,
          discount: 0,
          totalAmount,
          items: { create: itemsData },
        },
        include: this.orderInclude,
      });
    }, TRANSACTION_OPTIONS);

    const admins = await this.prisma.admin.findMany({
      select: { email: true },
    });
    await Promise.all(
      admins.map((admin) =>
        this.mailer.notifyAdminNewOrder(
          admin.email,
          order.orderNumber,
          dealer.businessName,
        ),
      ),
    );

    return order;
  }

  async findAllForAdmin(query: QueryOrderDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      status: query.status,
      dealerId: query.dealerId,
      ...(query.search && {
        OR: [
          { orderNumber: { contains: query.search, mode: 'insensitive' } },
          {
            dealer: {
              businessName: { contains: query.search, mode: 'insensitive' },
            },
          },
        ],
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: this.orderInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForDealer(dealerId: string, query: QueryOrderDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = { dealerId, status: query.status };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: this.orderInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(
    id: string,
    requester: { role: 'ADMIN' | 'DEALER'; id: string },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: this.orderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (requester.role === 'DEALER' && order.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this order');
    }
    return order;
  }

  async approve(id: string, adminId: string, dto?: ApproveOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, dealer: { omit: { password: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only pending orders can be approved');
    }

    if (dto?.discountPercentage !== undefined && dto?.discountAmount !== undefined) {
      throw new BadRequestException(
        'Provide either a discount percentage or a fixed discount amount, not both',
      );
    }

    let discountTotal = new Prisma.Decimal(0);
    let discountDescription: string | null = null;
    if (dto?.discountAmount !== undefined) {
      if (dto.discountAmount < 0) {
        throw new BadRequestException('Discount amount cannot be negative');
      }
      discountTotal = new Prisma.Decimal(dto.discountAmount);
      if (discountTotal.greaterThan(order.subtotal)) {
        throw new BadRequestException(
          'Discount amount cannot exceed the order subtotal',
        );
      }
      if (discountTotal.greaterThan(0)) {
        discountDescription = `a fixed discount of ${discountTotal.toString()}`;
      }
    } else if (dto?.discountPercentage !== undefined) {
      if (dto.discountPercentage < 0 || dto.discountPercentage > 100) {
        throw new BadRequestException('Discount percentage must be between 0 and 100');
      }
      discountTotal = order.subtotal.mul(dto.discountPercentage).div(100);
      if (dto.discountPercentage > 0) {
        discountDescription = `${dto.discountPercentage}% discount`;
      }
    }
    const grandTotal = order.subtotal.sub(discountTotal);

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.RESERVE,
          quantityOut: item.quantity,
          reference: order.id,
        });
      }

      const invoiceNumber = await nextSequenceNumber(tx, 'invoice', 'INV');
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + INVOICE_DUE_DAYS);

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: order.id,
          dealerId: order.dealerId,
          subtotal: order.subtotal,
          discountTotal,
          grandTotal,
          dueDate,
        },
      });

      const savedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.APPROVED,
          approvedByAdminId: adminId,
          approvedAt: new Date(),
          discount: discountTotal,
          totalAmount: grandTotal,
        },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'APPROVED_ORDER',
        targetId: order.id,
        details: discountDescription
          ? `Approved ${order.orderNumber} with ${discountDescription}, generated invoice ${invoice.invoiceNumber}`
          : `Approved ${order.orderNumber}, generated invoice ${invoice.invoiceNumber}`,
      });

      return savedOrder;
    }, TRANSACTION_OPTIONS);

    if (order.dealer.email) {
      await this.mailer.notifyDealerOrderApproved(
        order.dealer.email,
        order.orderNumber,
        updated.invoice?.invoiceNumber ?? '',
        grandTotal.toString(),
        discountDescription ?? undefined,
      );
    }

    for (const item of order.items) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (product && product.currentStock <= 0) {
        const admins = await this.prisma.admin.findMany({
          select: { email: true },
        });
        await Promise.all(
          admins.map((a) =>
            this.mailer.notifyAdminOutOfStock(a.email, product.name),
          ),
        );
      }
    }

    return updated;
  }

  async reject(id: string, adminId: string, reason: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { dealer: { omit: { password: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Only pending orders can be rejected');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const savedOrder = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.REJECTED,
          rejectReason: reason,
          rejectedAt: new Date(),
        },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REJECTED_ORDER',
        targetId: id,
        details: reason,
      });

      return savedOrder;
    }, TRANSACTION_OPTIONS);

    if (order.dealer.email) {
      await this.mailer.notifyDealerOrderRejected(
        order.dealer.email,
        order.orderNumber,
        reason,
      );
    }

    return updated;
  }

  async advanceStatus(
    id: string,
    adminId: string,
    nextStatus: 'PACKED' | 'DELIVERED' | 'COMPLETED',
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { invoice: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const requiredCurrentStatus = NEXT_STATUS[nextStatus];
    if (order.status !== requiredCurrentStatus) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${nextStatus}. Expected current status ${requiredCurrentStatus}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const timestampField = TIMESTAMP_FIELD[nextStatus];

      if (nextStatus === 'COMPLETED' && order.invoice) {
        await tx.dealer.update({
          where: { id: order.dealerId },
          data: { outstandingBalance: { increment: order.invoice.grandTotal } },
        });
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: nextStatus,
          [timestampField]: new Date(),
        },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: `ORDER_${nextStatus}`,
        targetId: id,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }
}
