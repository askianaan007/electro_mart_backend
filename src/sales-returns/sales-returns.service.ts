import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  CreateSalesReturnDto,
  SalesReturnItemDto,
} from './dto/create-sales-return.dto';
import { UpdateSalesReturnDto } from './dto/update-sales-return.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import {
  nextSequenceNumber,
  resetSequenceCounter,
} from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import { recomputeInvoicePaymentStatus } from '../common/utils/invoice-financials';

type TransactionClient = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class SalesReturnsService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
  ) {}

  private readonly include = {
    dealer: { omit: { password: true } as const },
    order: true,
    items: { include: { product: true } },
  } satisfies Prisma.SalesReturnInclude;

  async create(dto: CreateSalesReturnDto, adminId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { items: true, invoice: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== OrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Only completed orders can have items returned — the goods must have actually been delivered first',
      );
    }
    this.assertNoDuplicateProducts(dto.items);

    return this.prisma.$transaction(async (tx) => {
      // Lock the order row so a second concurrent return against the same
      // order can't read the same pre-write "already returned" snapshot in
      // computeItemsData and also pass its remaining-quantity guard.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const { itemsData, totalAmount } = await this.computeItemsData(
        tx,
        order,
        dto.items,
      );

      const returnNumber = await nextSequenceNumber(tx, 'salesReturn', 'RTN');

      const salesReturn = await tx.salesReturn.create({
        data: {
          returnNumber,
          orderId: order.id,
          dealerId: order.dealerId,
          reason: dto.reason,
          totalAmount,
          returnDate: new Date(dto.returnDate),
          items: { create: itemsData },
        },
        include: this.include,
      });

      for (const item of itemsData) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: item.quantity,
          reference: salesReturn.id,
        });
      }

      // Reduces what the dealer owes for this order. If they'd already paid
      // in full (or this pushes past what they now owe once the return is
      // netted in), the balance goes negative — that's store credit, usable
      // against future orders via the same balance the credit-limit check
      // already reads. Never clamped to zero: clamping would silently
      // discard the credit instead of recording it.
      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: order.dealerId },
      });
      await tx.dealer.update({
        where: { id: order.dealerId },
        data: {
          outstandingBalance: dealer.outstandingBalance.sub(totalAmount),
        },
      });

      if (order.invoice) {
        await recomputeInvoicePaymentStatus(tx, order.invoice.id);
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_SALES_RETURN',
        targetId: salesReturn.id,
        details: `Sales return ${returnNumber} of ${totalAmount.toString()} against order ${order.orderNumber}`,
      });

      return salesReturn;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Reverses the old items' stock and applies the new ones, and rebalances
   * the dealer's credit by the delta — the "fix a mistaken entry" edit path.
   * Only allowed within 1 day of the return being recorded, mirroring the
   * same window payments use for edits/reversals.
   */
  async update(id: string, dto: UpdateSalesReturnDto, adminId: string) {
    const salesReturn = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: {
        items: true,
        order: { include: { items: true, invoice: true } },
      },
    });
    if (!salesReturn) throw new NotFoundException('Sales return not found');
    this.assertEditable(salesReturn);

    const order = salesReturn.order;
    if (order.status !== OrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Only completed orders can have items returned — the goods must have actually been delivered first',
      );
    }
    this.assertNoDuplicateProducts(dto.items);

    const oldItems = salesReturn.items;
    const oldTotalAmount = salesReturn.totalAmount;

    return this.prisma.$transaction(async (tx) => {
      // Same row-lock pattern as create() — see comment there.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

      const { itemsData, totalAmount } = await this.computeItemsData(
        tx,
        order,
        dto.items,
        id,
      );

      for (const item of oldItems) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: salesReturn.id,
        });
      }
      for (const item of itemsData) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: item.quantity,
          reference: salesReturn.id,
        });
      }

      const updated = await tx.salesReturn.update({
        where: { id },
        data: {
          reason: dto.reason,
          returnDate: new Date(dto.returnDate),
          totalAmount,
          items: { deleteMany: {}, create: itemsData },
        },
        include: this.include,
      });

      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: order.dealerId },
      });
      await tx.dealer.update({
        where: { id: order.dealerId },
        data: {
          outstandingBalance: dealer.outstandingBalance
            .add(oldTotalAmount)
            .sub(totalAmount),
        },
      });

      if (order.invoice) {
        await recomputeInvoicePaymentStatus(tx, order.invoice.id);
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_SALES_RETURN',
        targetId: id,
        details: `Updated sales return ${salesReturn.returnNumber} against order ${order.orderNumber}: ${oldTotalAmount.toString()} -> ${totalAmount.toString()}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Fully reverses a mistaken return: removes the restocked units, gives
   * back the dealer credit it created, and recomputes the invoice's payment
   * status. Only allowed within 1 day of being recorded.
   */
  async remove(id: string, adminId: string) {
    const salesReturn = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: {
        items: true,
        order: { include: { invoice: true } },
      },
    });
    if (!salesReturn) throw new NotFoundException('Sales return not found');
    this.assertEditable(salesReturn);

    const order = salesReturn.order;

    return this.prisma.$transaction(async (tx) => {
      for (const item of salesReturn.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: salesReturn.id,
        });
      }

      await tx.salesReturnItem.deleteMany({ where: { salesReturnId: id } });
      await tx.salesReturn.delete({ where: { id } });

      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: order.dealerId },
      });
      await tx.dealer.update({
        where: { id: order.dealerId },
        data: {
          outstandingBalance: dealer.outstandingBalance.add(
            salesReturn.totalAmount,
          ),
        },
      });

      if (order.invoice) {
        await recomputeInvoicePaymentStatus(tx, order.invoice.id);
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_SALES_RETURN',
        targetId: id,
        details: `Deleted sales return ${salesReturn.returnNumber} of ${salesReturn.totalAmount.toString()} against order ${order.orderNumber}`,
      });

      return { message: 'Sales return deleted' };
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SalesReturnWhereInput = query.search
      ? { returnNumber: { contains: query.search, mode: 'insensitive' } }
      : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.salesReturn.findMany({
        where,
        include: this.include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.salesReturn.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForOrder(orderId: string) {
    return this.prisma.salesReturn.findMany({
      where: { orderId },
      include: this.include,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const salesReturn = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: this.include,
    });
    if (!salesReturn) throw new NotFoundException('Sales return not found');
    return salesReturn;
  }

  /**
   * Validates requested return quantities against what's still returnable
   * (order quantity minus what other returns already took), and prices the
   * refund off the order item's stored netUnitPrice — never the original
   * unitPrice. A discounted sale means the customer never actually paid
   * unitPrice for these units, so refunding it would hand back more than
   * they paid; netUnitPrice already has this order's discount allocated
   * into it (see OrdersService.allocateItemDiscounts) and is never
   * recomputed here. Shared by create() and update() — update() passes
   * excludeReturnId so the return being edited doesn't count against its
   * own remaining allowance.
   */
  private async computeItemsData(
    tx: TransactionClient,
    order: {
      id: string;
      items: {
        productId: string;
        quantity: number;
        unitPrice: Prisma.Decimal;
        netUnitPrice: Prisma.Decimal;
      }[];
    },
    dtoItems: SalesReturnItemDto[],
    excludeReturnId?: string,
  ) {
    const alreadyReturned = await tx.salesReturnItem.groupBy({
      by: ['productId'],
      where: {
        salesReturn: {
          orderId: order.id,
          ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
        },
      },
      _sum: { quantity: true },
    });
    const returnedMap = new Map(
      alreadyReturned.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );

    let totalAmount = new Prisma.Decimal(0);
    const itemsData = dtoItems.map((item) => {
      const orderItem = order.items.find(
        (oi) => oi.productId === item.productId,
      );
      if (!orderItem) {
        throw new BadRequestException(
          `Product ${item.productId} was not part of this order`,
        );
      }
      const alreadyReturnedQty = returnedMap.get(item.productId) ?? 0;
      const remaining = orderItem.quantity - alreadyReturnedQty;
      if (item.quantity > remaining) {
        throw new BadRequestException(
          `Cannot return ${item.quantity} of product ${item.productId}; only ${remaining} remain returnable`,
        );
      }

      const perUnitDiscount = orderItem.unitPrice.sub(orderItem.netUnitPrice);
      const allocatedDiscount = perUnitDiscount.mul(item.quantity);
      const lineTotal = orderItem.netUnitPrice.mul(item.quantity);
      totalAmount = totalAmount.add(lineTotal);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: orderItem.unitPrice,
        allocatedDiscount,
        lineTotal,
      };
    });

    return { itemsData, totalAmount };
  }

  /**
   * Rejects a request that lists the same product on more than one line —
   * each line is otherwise validated independently against the same
   * "remaining returnable" snapshot, so duplicates could jointly exceed it
   * even though each individual line looks fine.
   */
  private assertNoDuplicateProducts(items: { productId: string }[]) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.productId)) {
        throw new BadRequestException(
          `Product ${item.productId} appears more than once in this return — combine it into a single line`,
        );
      }
      seen.add(item.productId);
    }
  }

  private assertEditable(salesReturn: { createdAt: Date }) {
    if (Date.now() - salesReturn.createdAt.getTime() > DAY_MS) {
      throw new BadRequestException(
        'This return can only be edited or deleted within 1 day of being recorded',
      );
    }
  }

  /**
   * Realigns the return-number counter with what's actually in the table —
   * for after a bulk clear (e.g. clearing a dealer's data) leaves it stuck
   * high with no returns left to justify it. Next return issued will be
   * one past the highest returnNumber still on record, or 1 if there are
   * none.
   */
  async resetSalesReturnCounter(adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const salesReturns = await tx.salesReturn.findMany({
        select: { returnNumber: true },
      });
      const newValue = await resetSequenceCounter(
        tx,
        'salesReturn',
        salesReturns.map((r) => r.returnNumber),
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RESET_SALES_RETURN_COUNTER',
        details: `Reset sales return counter — next return will be RTN-${new Date().getFullYear()}-${String(newValue + 1).padStart(5, '0')}`,
      });

      return {
        message: 'Sales return counter reset',
        nextSerial: newValue + 1,
      };
    }, TRANSACTION_OPTIONS);
  }
}
