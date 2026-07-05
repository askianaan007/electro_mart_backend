import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateSalesReturnDto } from './dto/create-sales-return.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { nextSequenceNumber } from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

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
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const alreadyReturned = await this.prisma.salesReturnItem.groupBy({
      by: ['productId'],
      where: { salesReturn: { orderId: order.id } },
      _sum: { quantity: true },
    });
    const returnedMap = new Map(
      alreadyReturned.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );

    let totalAmount = new Prisma.Decimal(0);
    const itemsData = dto.items.map((item) => {
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

      const lineTotal = orderItem.unitPrice.mul(item.quantity);
      totalAmount = totalAmount.add(lineTotal);

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: orderItem.unitPrice,
        lineTotal,
      };
    });

    return this.prisma.$transaction(async (tx) => {
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

      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: order.dealerId },
      });
      const newOutstanding = Prisma.Decimal.max(
        0,
        dealer.outstandingBalance.sub(totalAmount),
      );
      await tx.dealer.update({
        where: { id: order.dealerId },
        data: { outstandingBalance: newOutstanding },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_SALES_RETURN',
        targetId: salesReturn.id,
        details: `Sales return ${returnNumber} of ${totalAmount.toString()} against order ${order.orderNumber}`,
      });

      return salesReturn;
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

  async findOne(id: string) {
    const salesReturn = await this.prisma.salesReturn.findUnique({
      where: { id },
      include: this.include,
    });
    if (!salesReturn) throw new NotFoundException('Sales return not found');
    return salesReturn;
  }
}
