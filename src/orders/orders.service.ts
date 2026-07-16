import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  InventoryLogType,
  OrderStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { CreateOrderDto, OrderItemDto } from './dto/create-order.dto';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { QueryOrderDto } from './dto/query-order.dto';
import { UpdateOrderItemsDto } from './dto/update-order-items.dto';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';

type TransactionClient = Prisma.TransactionClient;

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

  private async buildItemsAndSubtotal(items: OrderItemDto[]) {
    const productIds = items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );
    let subtotal = new Prisma.Decimal(0);
    const itemsData = items.map((item) => {
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

    return { itemsData, subtotal };
  }

  /**
   * Shared by approve() and the admin-create-order path: reserves stock,
   * generates the invoice, marks the order APPROVED, and logs the action.
   */
  private async applyApproval(
    tx: TransactionClient,
    order: {
      id: string;
      orderNumber: string;
      dealerId: string;
      subtotal: Prisma.Decimal;
      items: { productId: string; quantity: number }[];
    },
    adminId: string,
    options: {
      discountTotal: Prisma.Decimal;
      discountDescription: string | null;
      activityAction: string;
    },
  ) {
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
    const grandTotal = order.subtotal.sub(options.discountTotal);

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        orderId: order.id,
        dealerId: order.dealerId,
        subtotal: order.subtotal,
        discountTotal: options.discountTotal,
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
        discount: options.discountTotal,
        totalAmount: grandTotal,
      },
      include: this.orderInclude,
    });

    await this.activityLogService.log(tx, {
      adminId,
      action: options.activityAction,
      targetId: order.id,
      details: options.discountDescription
        ? `Approved ${order.orderNumber} with ${options.discountDescription}, generated invoice ${invoice.invoiceNumber}`
        : `Approved ${order.orderNumber}, generated invoice ${invoice.invoiceNumber}`,
    });

    return { savedOrder, invoice };
  }

  /** Shared by approve() and the admin-create-order path. */
  private resolveDiscount(
    subtotal: Prisma.Decimal,
    dto?: { discountPercentage?: number; discountAmount?: number },
  ) {
    if (
      dto?.discountPercentage !== undefined &&
      dto?.discountAmount !== undefined
    ) {
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
      if (discountTotal.greaterThan(subtotal)) {
        throw new BadRequestException(
          'Discount amount cannot exceed the order subtotal',
        );
      }
      if (discountTotal.greaterThan(0)) {
        discountDescription = `a fixed discount of ${discountTotal.toString()}`;
      }
    } else if (dto?.discountPercentage !== undefined) {
      if (dto.discountPercentage < 0 || dto.discountPercentage > 100) {
        throw new BadRequestException(
          'Discount percentage must be between 0 and 100',
        );
      }
      discountTotal = subtotal.mul(dto.discountPercentage).div(100);
      if (dto.discountPercentage > 0) {
        discountDescription = `${dto.discountPercentage}% discount`;
      }
    }

    return { discountTotal, discountDescription };
  }

  private async checkAndNotifyOutOfStock(productIds: string[]) {
    const productsAfterReserve = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const outOfStockProducts = productsAfterReserve.filter(
      (product) => product.currentStock <= 0,
    );
    if (outOfStockProducts.length === 0) return;

    const admins = await this.prisma.admin.findMany({
      select: { email: true },
    });
    await Promise.all(
      outOfStockProducts.flatMap((product) =>
        admins.map((a) =>
          this.mailer.notifyAdminOutOfStock(a.email, product.name),
        ),
      ),
    );
  }

  async create(
    requester: { role: Role; id: string },
    dto: CreateOrderDto,
  ) {
    const dealerId =
      requester.role === Role.ADMIN ? dto.dealerId : requester.id;
    if (requester.role === Role.ADMIN && !dealerId) {
      throw new BadRequestException(
        'dealerId is required when an admin creates an order',
      );
    }

    const dealer = await this.prisma.dealer.findUnique({
      where: { id: dealerId },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    if (dealer.status !== AccountStatus.ACTIVE)
      throw new ForbiddenException('Dealer account is inactive');

    const { itemsData, subtotal } = await this.buildItemsAndSubtotal(
      dto.items,
    );

    const { discountTotal, discountDescription } =
      requester.role === Role.ADMIN
        ? this.resolveDiscount(subtotal, dto)
        : { discountTotal: new Prisma.Decimal(0), discountDescription: null };

    const totalAmount = subtotal.sub(discountTotal);
    const projectedOutstanding = dealer.outstandingBalance.add(totalAmount);
    if (
      !dealer.unlimitedCredit &&
      projectedOutstanding.greaterThan(dealer.creditLimit)
    ) {
      throw new BadRequestException(
        requester.role === Role.ADMIN
          ? "This order exceeds the dealer's available credit limit"
          : 'This order exceeds your available credit limit',
      );
    }

    if (requester.role === Role.ADMIN) {
      const { savedOrder } = await this.prisma.$transaction(async (tx) => {
        const orderNumber = await nextSequenceNumber(tx, 'order', 'ORD');
        const order = await tx.order.create({
          data: {
            orderNumber,
            dealerId: dealerId as string,
            subtotal,
            discount: 0,
            totalAmount,
            items: { create: itemsData },
          },
          include: { items: true },
        });

        return this.applyApproval(tx, order, requester.id, {
          discountTotal,
          discountDescription,
          activityAction: 'ADMIN_CREATED_ORDER',
        });
      }, TRANSACTION_OPTIONS);

      if (dealer.email) {
        await this.mailer.notifyDealerOrderApproved(
          dealer.email,
          savedOrder.orderNumber,
          savedOrder.invoice?.invoiceNumber ?? '',
          savedOrder.totalAmount.toString(),
          discountDescription ?? undefined,
        );
      }

      await this.checkAndNotifyOutOfStock(
        itemsData.map((item) => item.productId),
      );

      return savedOrder;
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await nextSequenceNumber(tx, 'order', 'ORD');
      return tx.order.create({
        data: {
          orderNumber,
          dealerId: dealerId as string,
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

  async updateItems(id: string, adminId: string, dto: UpdateOrderItemsDto) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { dealer: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Only pending orders can have their items edited',
      );
    }

    const { itemsData, subtotal } = await this.buildItemsAndSubtotal(
      dto.items,
    );

    const projectedOutstanding = order.dealer.outstandingBalance.add(
      subtotal,
    );
    if (
      !order.dealer.unlimitedCredit &&
      projectedOutstanding.greaterThan(order.dealer.creditLimit)
    ) {
      throw new BadRequestException(
        "This change exceeds the dealer's available credit limit",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      const savedOrder = await tx.order.update({
        where: { id },
        data: { subtotal, totalAmount: subtotal, items: { create: itemsData } },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_ORDER_ITEMS',
        targetId: id,
        details: `Updated line items for ${order.orderNumber}`,
      });

      return savedOrder;
    }, TRANSACTION_OPTIONS);
  }

  async findAllForAdmin(query: QueryOrderDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      status: query.status,
      dealerId: query.dealerId,
      ...((query.dateFrom || query.dateTo) && {
        createdAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
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

    const { discountTotal, discountDescription } = this.resolveDiscount(
      order.subtotal,
      dto,
    );
    const { savedOrder, invoice } = await this.prisma.$transaction(
      (tx) =>
        this.applyApproval(tx, order, adminId, {
          discountTotal,
          discountDescription,
          activityAction: 'APPROVED_ORDER',
        }),
      TRANSACTION_OPTIONS,
    );

    if (order.dealer.email) {
      await this.mailer.notifyDealerOrderApproved(
        order.dealer.email,
        order.orderNumber,
        invoice.invoiceNumber,
        invoice.grandTotal.toString(),
        discountDescription ?? undefined,
      );
    }

    await this.checkAndNotifyOutOfStock(
      order.items.map((item) => item.productId),
    );

    return savedOrder;
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
      include: this.orderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');

    const requiredCurrentStatus = NEXT_STATUS[nextStatus];
    if (order.status !== requiredCurrentStatus) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${nextStatus}. Expected current status ${requiredCurrentStatus}.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const timestampField = TIMESTAMP_FIELD[nextStatus];

      if (nextStatus === 'COMPLETED' && order.invoice) {
        await tx.dealer.update({
          where: { id: order.dealerId },
          data: { outstandingBalance: { increment: order.invoice.grandTotal } },
        });
      }

      const saved = await tx.order.update({
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

      return saved;
    }, TRANSACTION_OPTIONS);

    if (nextStatus === 'DELIVERED' && updated.invoice && updated.dealer.email) {
      await this.mailer.notifyDealerOrderDelivered(updated.dealer.email, {
        orderNumber: updated.orderNumber,
        dealerName: updated.dealer.businessName,
        invoiceNumber: updated.invoice.invoiceNumber,
        invoiceDate: updated.invoice.createdAt,
        items: updated.items.map((item) => ({
          productName: item.product.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          lineTotal: item.lineTotal.toString(),
        })),
        subtotal: updated.invoice.subtotal.toString(),
        discountTotal: updated.invoice.discountTotal.toString(),
        grandTotal: updated.invoice.grandTotal.toString(),
      });
    }

    return updated;
  }

  /**
   * Fast-forwards an approved order straight to COMPLETED, applying
   * whichever intermediate Packed/Delivered timestamps it's still missing
   * and running the same side effects (delivery email, balance increment)
   * as stepping through them one at a time would have.
   */
  async completeDirectly(id: string, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: this.orderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException('Order is already completed');
    }
    if (
      order.status !== OrderStatus.APPROVED &&
      order.status !== OrderStatus.PACKED &&
      order.status !== OrderStatus.DELIVERED
    ) {
      throw new BadRequestException(
        `Cannot complete an order with status ${order.status}. It must be approved first.`,
      );
    }

    const now = new Date();

    const updated = await this.prisma.$transaction(async (tx) => {
      if (order.invoice) {
        await tx.dealer.update({
          where: { id: order.dealerId },
          data: { outstandingBalance: { increment: order.invoice.grandTotal } },
        });
      }

      const saved = await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.COMPLETED,
          packedAt: order.packedAt ?? now,
          deliveredAt: order.deliveredAt ?? now,
          completedAt: now,
        },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'ORDER_DIRECTLY_COMPLETED',
        targetId: id,
        details: `Fast-forwarded order ${order.orderNumber} from ${order.status} to COMPLETED`,
      });

      return saved;
    }, TRANSACTION_OPTIONS);

    if (!order.deliveredAt && updated.invoice && updated.dealer.email) {
      await this.mailer.notifyDealerOrderDelivered(updated.dealer.email, {
        orderNumber: updated.orderNumber,
        dealerName: updated.dealer.businessName,
        invoiceNumber: updated.invoice.invoiceNumber,
        invoiceDate: updated.invoice.createdAt,
        items: updated.items.map((item) => ({
          productName: item.product.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          lineTotal: item.lineTotal.toString(),
        })),
        subtotal: updated.invoice.subtotal.toString(),
        discountTotal: updated.invoice.discountTotal.toString(),
        grandTotal: updated.invoice.grandTotal.toString(),
      });
    }

    return updated;
  }

  /**
   * Deletes an order any time before it's COMPLETED. If it was already
   * approved, that reserved the stock and generated an invoice — both are
   * reversed here. Blocked outright if the invoice already has payments
   * recorded, so money already collected is never silently unwound.
   */
  async remove(id: string, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, invoice: { include: { payments: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.COMPLETED) {
      throw new BadRequestException('Completed orders cannot be deleted');
    }
    if (order.invoice && order.invoice.payments.length > 0) {
      throw new BadRequestException(
        'This order has payments recorded against its invoice and cannot be deleted',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (order.invoice) {
          for (const item of order.items) {
            await this.inventoryService.recordMovement(tx, {
              productId: item.productId,
              type: InventoryLogType.ADJUSTMENT,
              quantityIn: item.quantity,
              reference: `Reversal of deleted order ${order.orderNumber}`,
            });
          }
          await tx.invoice.delete({ where: { id: order.invoice.id } });
        }

        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.order.delete({ where: { id } });

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_ORDER',
          targetId: id,
          details: order.invoice
            ? `Deleted order ${order.orderNumber} and reversed its stock reservation`
            : `Deleted order ${order.orderNumber}`,
        });

        return { message: 'Order deleted' };
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'This order has related records (e.g. a sales return) and cannot be deleted',
        );
      }
      throw error;
    }
  }
}
