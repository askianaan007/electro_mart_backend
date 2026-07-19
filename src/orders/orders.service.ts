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
import { UpdateOrderDto } from './dto/update-order.dto';
import { paginate } from '../common/utils/paginate';
import {
  isLatestSequenceNumber,
  nextSequenceNumber,
  resetSequenceCounter,
} from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { isForeignKeyViolation } from '../common/utils/prisma-errors';
import { derivePaymentStatus } from '../common/utils/invoice-financials';

type TransactionClient = Prisma.TransactionClient;

const INVOICE_DUE_DAYS = 15;

// Orders in any of these statuses already have (or are about to get) real
// financial weight against the dealer's credit line, even before they
// reach COMPLETED (the only point outstandingBalance itself is touched) —
// so credit-limit checks must count them, not just outstandingBalance.
const IN_FLIGHT_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_APPROVAL,
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
];

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

/**
 * Takes a date-only value (e.g. a historical sale date entered while
 * migrating past data) and stamps it with the current time-of-day, so
 * records backfilled for the same past date still get distinct, sortable
 * createdAt timestamps instead of all collapsing to midnight.
 */
function withCurrentTime(date: Date): Date {
  const now = new Date();
  const combined = new Date(date);
  combined.setUTCHours(
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  );
  return combined;
}

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
    salesReturns: { select: { totalAmount: true } },
  } satisfies Prisma.OrderInclude;

  private async buildItemsAndSubtotal(
    items: OrderItemDto[],
    client: TransactionClient | PrismaService = this.prisma,
  ) {
    const seenProductIds = new Set<string>();
    for (const item of items) {
      if (seenProductIds.has(item.productId)) {
        throw new BadRequestException(
          `Product ${item.productId} appears more than once in this order — combine it into a single line`,
        );
      }
      seenProductIds.add(item.productId);
    }

    const productIds = items.map((item) => item.productId);
    const products = await client.product.findMany({
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
        // Placeholder until the order's discount is finalized (see
        // allocateItemDiscounts) — no discount is known yet at this point
        // for a dealer-submitted order still awaiting approval.
        allocatedDiscount: new Prisma.Decimal(0),
        netLineTotal: lineTotal,
        netUnitPrice: product.wholesalePrice,
      };
    });

    return { itemsData, subtotal };
  }

  /**
   * Distributes an order's total discount across its items proportionally
   * by each line's share of the subtotal, and derives the net (post-discount)
   * unit price a returned unit is actually refunded from. Called once,
   * whenever an order's discount is finalized (order creation/approval, or a
   * full edit) — per the "store it, never recompute" rule sales returns rely
   * on. Rounds each line to 2 decimal places independently, matching how the
   * discount itself is entered.
   */
  private allocateItemDiscounts<
    T extends { lineTotal: Prisma.Decimal; quantity: number },
  >(items: T[], subtotal: Prisma.Decimal, discountTotal: Prisma.Decimal) {
    const ratio =
      subtotal.isZero() || discountTotal.isZero()
        ? new Prisma.Decimal(0)
        : discountTotal.div(subtotal);

    return items.map((item) => {
      const allocatedDiscount = item.lineTotal.mul(ratio).toDecimalPlaces(2);
      const netLineTotal = item.lineTotal.sub(allocatedDiscount);
      const netUnitPrice =
        item.quantity > 0
          ? netLineTotal.div(item.quantity).toDecimalPlaces(2)
          : netLineTotal;
      return { ...item, allocatedDiscount, netLineTotal, netUnitPrice };
    });
  }

  /**
   * Admin-only alternative to a single order-wide discount: lets each line
   * carry its own discount (e.g. one product marked down, the rest at full
   * price) instead of one discount spread across the whole order. Returns
   * null when no item carries a discount, so callers fall back to the
   * order-wide resolveDiscount()/allocateItemDiscounts() path — the two
   * modes are mutually exclusive, enforced by the caller. Unlike
   * allocateItemDiscounts (which derives each line's share from an
   * already-known total), this derives the total from each line's own
   * explicit discount — the definitive figures are computed here, once, and
   * never recomputed, per the same "store it, never recompute" rule sales
   * returns rely on.
   */
  private applyItemLevelDiscounts<
    T extends { lineTotal: Prisma.Decimal; quantity: number },
  >(itemsData: T[], items: OrderItemDto[]) {
    const usesItemDiscounts = items.some(
      (item) =>
        item.discountPercentage !== undefined ||
        item.discountAmount !== undefined,
    );
    if (!usesItemDiscounts) return null;

    let discountTotal = new Prisma.Decimal(0);
    let discountedLineCount = 0;

    const discountedItems = itemsData.map((itemData, index) => {
      const dto = items[index];
      if (
        dto.discountPercentage !== undefined &&
        dto.discountAmount !== undefined
      ) {
        throw new BadRequestException(
          'Provide either a discount percentage or a fixed discount amount for a product, not both',
        );
      }

      let allocatedDiscount = new Prisma.Decimal(0);
      if (dto.discountAmount !== undefined) {
        allocatedDiscount = new Prisma.Decimal(dto.discountAmount);
        if (allocatedDiscount.greaterThan(itemData.lineTotal)) {
          throw new BadRequestException(
            "A product's discount cannot exceed its own line total",
          );
        }
      } else if (dto.discountPercentage !== undefined) {
        allocatedDiscount = itemData.lineTotal
          .mul(dto.discountPercentage)
          .div(100)
          .toDecimalPlaces(2);
      }

      if (allocatedDiscount.greaterThan(0)) discountedLineCount += 1;
      discountTotal = discountTotal.add(allocatedDiscount);

      const netLineTotal = itemData.lineTotal.sub(allocatedDiscount);
      const netUnitPrice =
        itemData.quantity > 0
          ? netLineTotal.div(itemData.quantity).toDecimalPlaces(2)
          : netLineTotal;

      return { ...itemData, allocatedDiscount, netLineTotal, netUnitPrice };
    });

    const discountDescription =
      discountedLineCount > 0
        ? `product-level discounts on ${discountedLineCount} item${discountedLineCount > 1 ? 's' : ''}`
        : null;

    return { itemsData: discountedItems, discountTotal, discountDescription };
  }

  /**
   * Shared by approve() and the admin-create-order path: reserves stock,
   * generates the invoice, marks the order APPROVED, and logs the action.
   *
   * When `completionDate` is set (admin-create-order path only, for
   * recording a walk-in/offline sale after the fact), the order is instead
   * created directly as COMPLETED — approvedAt/packedAt/deliveredAt/
   * completedAt all set to that date — and the dealer's outstanding balance
   * is incremented immediately, mirroring what stepping through
   * Packed/Delivered/Completed one at a time would have done.
   */
  private async applyApproval(
    tx: TransactionClient,
    order: {
      id: string;
      orderNumber: string;
      dealerId: string;
      subtotal: Prisma.Decimal;
      items: {
        id: string;
        productId: string;
        quantity: number;
        lineTotal: Prisma.Decimal;
      }[];
    },
    adminId: string,
    options: {
      discountTotal: Prisma.Decimal;
      discountDescription: string | null;
      activityAction: string;
      completionDate?: Date;
      createdAt?: Date;
      // Set when the items already carry their own explicit per-product
      // discounts (applyItemLevelDiscounts), persisted at creation — the
      // proportional order-wide allocation below would overwrite them
      // incorrectly, so it's skipped entirely in that case.
      skipItemDiscountAllocation?: boolean;
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

    if (!options.skipItemDiscountAllocation) {
      // The discount is only known now — allocate each item's share and
      // persist it, since sales returns will refund from these stored
      // figures rather than ever recomputing them.
      const allocatedItems = this.allocateItemDiscounts(
        order.items,
        order.subtotal,
        options.discountTotal,
      );
      for (const item of allocatedItems) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            allocatedDiscount: item.allocatedDiscount,
            netLineTotal: item.netLineTotal,
            netUnitPrice: item.netUnitPrice,
          },
        });
      }
    }

    const invoiceNumber = await nextSequenceNumber(tx, 'invoice', 'INV');
    const dueDate = new Date(options.createdAt ?? new Date());
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
        ...(options.createdAt && { createdAt: options.createdAt }),
      },
    });

    const completionDate = options.completionDate;

    if (completionDate) {
      await tx.dealer.update({
        where: { id: order.dealerId },
        data: { outstandingBalance: { increment: grandTotal } },
      });
    }

    const savedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        status: completionDate ? OrderStatus.COMPLETED : OrderStatus.APPROVED,
        approvedByAdminId: adminId,
        approvedAt: completionDate ?? new Date(),
        ...(completionDate && {
          packedAt: completionDate,
          deliveredAt: completionDate,
          completedAt: completionDate,
        }),
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

  /**
   * Sums the totalAmount of every order still "in flight" for a dealer —
   * i.e. not yet completed (which is when outstandingBalance itself picks
   * it up) but also not rejected. A dealer can have several such orders at
   * once, none of which show up in outstandingBalance yet, so a credit-limit
   * check that only looks at outstandingBalance can be satisfied by every
   * one of them individually while their combined total blows past the
   * limit once they're all approved.
   */
  private async sumInFlightOrderTotals(
    tx: TransactionClient,
    dealerId: string,
    excludeOrderId?: string,
  ): Promise<Prisma.Decimal> {
    const agg = await tx.order.aggregate({
      where: {
        dealerId,
        status: { in: IN_FLIGHT_ORDER_STATUSES },
        ...(excludeOrderId && { id: { not: excludeOrderId } }),
      },
      _sum: { totalAmount: true },
    });
    return agg._sum.totalAmount ?? new Prisma.Decimal(0);
  }

  /**
   * The single credit-limit gate used by every order-creating/-editing path.
   * Locks the dealer row for the rest of this transaction first — without
   * it, two concurrent orders against the same dealer could both read the
   * same pre-write outstanding/in-flight totals and both pass, jointly
   * exceeding the limit (the same TOCTOU shape as the stock-reservation
   * race). `excludeOrderId` lets an edit path exclude the order being
   * edited from its own "already in flight" total before adding its new
   * amount back in.
   */
  private async assertWithinCreditLimit(
    tx: TransactionClient,
    dealerId: string,
    additionalAmount: Prisma.Decimal,
    excludeOrderId: string | undefined,
    errorMessage: string,
  ) {
    await tx.$queryRaw`SELECT id FROM "Dealer" WHERE id = ${dealerId} FOR UPDATE`;

    const dealer = await tx.dealer.findUniqueOrThrow({
      where: { id: dealerId },
    });
    if (dealer.unlimitedCredit) return dealer;

    const inFlightTotal = await this.sumInFlightOrderTotals(
      tx,
      dealerId,
      excludeOrderId,
    );
    const projectedOutstanding = dealer.outstandingBalance
      .add(inFlightTotal)
      .add(additionalAmount);
    if (projectedOutstanding.greaterThan(dealer.creditLimit)) {
      throw new BadRequestException(errorMessage);
    }
    return dealer;
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

  async create(requester: { role: Role; id: string }, dto: CreateOrderDto) {
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

    const { itemsData: builtItems, subtotal } =
      await this.buildItemsAndSubtotal(dto.items);

    let itemsData = builtItems;
    let discountTotal = new Prisma.Decimal(0);
    let discountDescription: string | null = null;
    let usesItemLevelDiscount = false;

    if (requester.role === Role.ADMIN) {
      const itemLevel = this.applyItemLevelDiscounts(builtItems, dto.items);
      if (itemLevel) {
        if (
          dto.discountPercentage !== undefined ||
          dto.discountAmount !== undefined
        ) {
          throw new BadRequestException(
            'Provide either a per-product discount or an order-wide discount, not both',
          );
        }
        itemsData = itemLevel.itemsData;
        discountTotal = itemLevel.discountTotal;
        discountDescription = itemLevel.discountDescription;
        usesItemLevelDiscount = true;
      } else {
        ({ discountTotal, discountDescription } = this.resolveDiscount(
          subtotal,
          dto,
        ));
      }
    }

    const totalAmount = subtotal.sub(discountTotal);
    const creditLimitErrorMessage =
      requester.role === Role.ADMIN
        ? "This order exceeds the dealer's available credit limit"
        : 'This order exceeds your available credit limit';

    if (requester.role === Role.ADMIN) {
      const completionDate = dto.saleDate ? new Date(dto.saleDate) : undefined;
      // Backfilling a historical sale (migrating past data) should not be
      // stamped with today's date — createdAt follows the chosen sale date,
      // just with the actual current time-of-day so same-day backfills stay
      // distinctly ordered.
      const createdAt = completionDate
        ? withCurrentTime(completionDate)
        : undefined;

      const { savedOrder } = await this.prisma.$transaction(async (tx) => {
        await this.assertWithinCreditLimit(
          tx,
          dealerId as string,
          totalAmount,
          undefined,
          creditLimitErrorMessage,
        );

        const orderNumber = await nextSequenceNumber(tx, 'order', 'ORD');
        const order = await tx.order.create({
          data: {
            orderNumber,
            dealerId: dealerId as string,
            subtotal,
            discount: 0,
            totalAmount,
            createdByAdminId: requester.id,
            items: { create: itemsData },
            ...(createdAt && { createdAt }),
          },
          include: { items: true },
        });

        return this.applyApproval(tx, order, requester.id, {
          discountTotal,
          discountDescription,
          activityAction: 'ADMIN_CREATED_ORDER',
          completionDate,
          createdAt,
          skipItemDiscountAllocation: usesItemLevelDiscount,
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
      await this.assertWithinCreditLimit(
        tx,
        dealerId as string,
        totalAmount,
        undefined,
        creditLimitErrorMessage,
      );

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

    const { itemsData, subtotal } = await this.buildItemsAndSubtotal(dto.items);

    return this.prisma.$transaction(async (tx) => {
      await this.assertWithinCreditLimit(
        tx,
        order.dealerId,
        subtotal,
        id,
        "This change exceeds the dealer's available credit limit",
      );

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

  /**
   * Edits any order that already has an invoice (Approved and beyond),
   * fixing a mistake in its dealer/items/discount/date. Reverses and
   * re-applies the stock reservation, and — only for orders that had
   * actually reached Completed, since that's the only point the dealer's
   * balance and completion timeline are touched — the balance impact and
   * the packed/delivered/completed timestamps. Blocked if a sales return or
   * a payment already exists against it, since those reference the order's
   * current state. Orders still Pending Approval (no invoice yet) use
   * updateItems() instead.
   */
  async updateAdminOrder(id: string, dto: UpdateOrderDto, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        invoice: { include: { payments: true } },
        salesReturns: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.invoice) {
      throw new BadRequestException(
        'Only orders that have an invoice (Approved or later) can be edited this way. Use Edit Items while the order is still Pending Approval.',
      );
    }
    if (order.salesReturns.length > 0) {
      throw new BadRequestException(
        'This order has a sales return recorded against it and cannot be edited',
      );
    }
    if (order.invoice.payments.length > 0) {
      throw new BadRequestException(
        "This order's invoice already has payments recorded and cannot be edited",
      );
    }

    const newDealer = await this.prisma.dealer.findUnique({
      where: { id: dto.dealerId },
    });
    if (!newDealer) throw new NotFoundException('Dealer not found');
    if (newDealer.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Dealer account is inactive');
    }

    const wasCompleted = order.status === OrderStatus.COMPLETED;
    const oldGrandTotal = order.invoice.grandTotal;
    const invoiceId = order.invoice.id;
    const saleDate =
      wasCompleted && dto.saleDate ? new Date(dto.saleDate) : undefined;

    return this.prisma.$transaction(async (tx) => {
      // Reverse the original stock reservation (and dealer balance, if this
      // order had actually been completed).
      for (const item of order.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.RELEASE,
          quantityIn: item.quantity,
          reference: `Reversed for edit of order ${order.orderNumber}`,
        });
      }
      if (wasCompleted) {
        await tx.dealer.update({
          where: { id: order.dealerId },
          data: { outstandingBalance: { decrement: oldGrandTotal } },
        });
      }
      await tx.orderItem.deleteMany({ where: { orderId: id } });

      // Rebuilt only now, against post-reversal stock figures.
      const { itemsData, subtotal } = await this.buildItemsAndSubtotal(
        dto.items,
        tx,
      );
      const itemLevel = this.applyItemLevelDiscounts(itemsData, dto.items);
      let discountTotal: Prisma.Decimal;
      let discountDescription: string | null;
      let allocatedItemsData: typeof itemsData;
      if (itemLevel) {
        if (
          dto.discountPercentage !== undefined ||
          dto.discountAmount !== undefined
        ) {
          throw new BadRequestException(
            'Provide either a per-product discount or an order-wide discount, not both',
          );
        }
        discountTotal = itemLevel.discountTotal;
        discountDescription = itemLevel.discountDescription;
        allocatedItemsData = itemLevel.itemsData;
      } else {
        ({ discountTotal, discountDescription } = this.resolveDiscount(
          subtotal,
          dto,
        ));
        allocatedItemsData = this.allocateItemDiscounts(
          itemsData,
          subtotal,
          discountTotal,
        );
      }
      const grandTotal = subtotal.sub(discountTotal);

      await this.assertWithinCreditLimit(
        tx,
        dto.dealerId,
        grandTotal,
        id,
        "This change exceeds the dealer's available credit limit",
      );

      // Re-apply: reserve stock for the corrected items.
      for (const item of itemsData) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.RESERVE,
          quantityOut: item.quantity,
          reference: id,
        });
      }

      if (wasCompleted) {
        await tx.dealer.update({
          where: { id: dto.dealerId },
          data: { outstandingBalance: { increment: grandTotal } },
        });
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          dealerId: dto.dealerId,
          subtotal,
          discountTotal,
          grandTotal,
          // Only reachable with zero payments recorded (checked above), so
          // effectivePaid is always 0 here — but a 100%-discount edit should
          // still resolve to PAID for a ₹0 balance rather than staying
          // PENDING forever.
          paymentStatus: derivePaymentStatus(new Prisma.Decimal(0), grandTotal),
        },
      });

      const savedOrder = await tx.order.update({
        where: { id },
        data: {
          dealerId: dto.dealerId,
          subtotal,
          discount: discountTotal,
          totalAmount: grandTotal,
          items: { create: allocatedItemsData },
          ...(saleDate && {
            approvedAt: saleDate,
            packedAt: saleDate,
            deliveredAt: saleDate,
            completedAt: saleDate,
          }),
        },
        include: this.orderInclude,
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'ADMIN_EDITED_ORDER',
        targetId: id,
        details: discountDescription
          ? `Edited ${order.orderNumber} (${discountDescription}), new total ${grandTotal.toString()}`
          : `Edited ${order.orderNumber}, new total ${grandTotal.toString()}`,
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
   * Deletes an order at any status, including COMPLETED, reversing
   * everything it caused: the stock it reserved, the dealer balance it
   * added (if it had been completed), and its invoice. Blocked outright if
   * the invoice already has payments recorded, so money already collected
   * is never silently unwound, and blocked if a newer invoice has since
   * been issued — deleting anything but the most recent invoice would
   * either leave a permanent gap or force numbers to be reused out of
   * order, so once another invoice exists after this one, this order is
   * locked from deletion. When deletion does go through, the invoice
   * number (and the order number, if it's also still the latest) is handed
   * back to its sequence so the next one created reuses it instead of
   * leaving a gap.
   */
  async remove(id: string, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true, invoice: { include: { payments: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.invoice && order.invoice.payments.length > 0) {
      throw new BadRequestException(
        'This order has payments recorded against its invoice and cannot be deleted',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (order.invoice) {
          const isLatestInvoice = await isLatestSequenceNumber(
            tx,
            'invoice',
            order.invoice.invoiceNumber,
          );
          if (!isLatestInvoice) {
            throw new BadRequestException(
              'A newer invoice has already been issued. Only the most recently issued invoice can be deleted, so invoice numbers stay sequential.',
            );
          }

          for (const item of order.items) {
            await this.inventoryService.recordMovement(tx, {
              productId: item.productId,
              type: InventoryLogType.RELEASE,
              quantityIn: item.quantity,
              reference: `Reversal of deleted order ${order.orderNumber}`,
            });
          }

          if (order.status === OrderStatus.COMPLETED) {
            await tx.dealer.update({
              where: { id: order.dealerId },
              data: {
                outstandingBalance: { decrement: order.invoice.grandTotal },
              },
            });
          }

          await tx.invoice.delete({ where: { id: order.invoice.id } });

          const remainingInvoices = await tx.invoice.findMany({
            select: { invoiceNumber: true },
          });
          await resetSequenceCounter(
            tx,
            'invoice',
            remainingInvoices.map((i) => i.invoiceNumber),
          );
        }

        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.order.delete({ where: { id } });

        const remainingOrders = await tx.order.findMany({
          select: { orderNumber: true },
        });
        await resetSequenceCounter(
          tx,
          'order',
          remainingOrders.map((o) => o.orderNumber),
        );

        await this.activityLogService.log(tx, {
          adminId,
          action: 'DELETED_ORDER',
          targetId: id,
          details: order.invoice
            ? `Deleted order ${order.orderNumber} and invoice ${order.invoice.invoiceNumber} (counters realigned), reversed its stock reservation${order.status === OrderStatus.COMPLETED ? ' and dealer balance' : ''}`
            : `Deleted order ${order.orderNumber} (counter realigned)`,
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

  /**
   * Realigns the order-number counter with what's actually in the table —
   * for after a bulk clear (e.g. clearing a dealer's data) leaves it stuck
   * high with no orders left to justify it. Next order issued will be one
   * past the highest orderNumber still on record, or ORD-<year>-00001 if
   * there are none.
   */
  async resetOrderCounter(adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const orders = await tx.order.findMany({ select: { orderNumber: true } });
      const newValue = await resetSequenceCounter(
        tx,
        'order',
        orders.map((o) => o.orderNumber),
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RESET_ORDER_COUNTER',
        details: `Reset order counter — next order will be ORD-${new Date().getFullYear()}-${String(newValue + 1).padStart(5, '0')}`,
      });

      return { message: 'Order counter reset', nextSerial: newValue + 1 };
    }, TRANSACTION_OPTIONS);
  }
}
