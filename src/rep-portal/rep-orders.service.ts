import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DealerSource, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { QueryRepOrderDto } from './dto/query-rep-order.dto';
import { RepCatalogVisibilityService } from '../rep-catalog-visibility/rep-catalog-visibility.service';
import { paginate } from '../common/utils/paginate';
import { REP_SAFE_DEALER_SELECT } from './rep-safe-dealer.select';

/**
 * Thin wrapper over the existing, unmodified-except-for-one-branch
 * OrdersService (Rep_Portal_DOCUMENTATION.md §16). This service never
 * duplicates order-creation logic — create() delegates entirely; list/get
 * are read-only queries scoped to the calling representative.
 */
@Injectable()
export class RepOrdersService {
  private readonly orderInclude = {
    items: { include: { product: true } },
    dealer: { select: REP_SAFE_DEALER_SELECT },
    invoice: true,
  } satisfies Prisma.OrderInclude;

  constructor(
    private prisma: PrismaService,
    private ordersService: OrdersService,
    private repCatalogVisibility: RepCatalogVisibilityService,
  ) {}

  /** Same costPrice/stock-hiding boundary as every other rep-facing product read (§5.3/§8) — an order's embedded product is no exception. */
  private async sanitize<
    T extends { items: { product: Prisma.ProductGetPayload<object> }[] },
  >(order: T) {
    const items = await Promise.all(
      order.items.map(async (item) => ({
        ...item,
        product: await this.repCatalogVisibility.serializeForRep(item.product),
      })),
    );
    return { ...order, items };
  }

  async create(repId: string, dto: CreateOrderDto) {
    // Rep-only guards, kept here so OrdersService's admin/dealer paths are
    // untouched: a rep may only order for a Rep Portal customer (shared pool,
    // so not restricted to createdByRepId) and only products in their scope.
    if (!dto.dealerId) {
      throw new BadRequestException(
        'dealerId is required when a representative creates an order',
      );
    }
    const dealer = await this.prisma.dealer.findUnique({
      where: { id: dto.dealerId },
      select: { source: true },
    });
    if (!dealer) throw new NotFoundException('Customer not found');
    if (dealer.source !== DealerSource.REP_PORTAL) {
      throw new ForbiddenException(
        'Representatives can only place orders for Rep Portal customers',
      );
    }
    await this.repCatalogVisibility.assertProductsInRepScope(
      repId,
      dto.items.map((item) => item.productId),
    );

    const order = await this.ordersService.create(
      { role: Role.REPRESENTATIVE, id: repId },
      dto,
    );
    // Re-read through the rep-safe include/serializer — OrdersService's own
    // include carries the full Dealer row and raw product costPrice/stock.
    return this.findOne(order.id, repId);
  }

  async list(repId: string, query: QueryRepOrderDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.OrderWhereInput = {
      createdByRepId: repId,
      status: query.status,
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

    const sanitized = await Promise.all(
      data.map((order) => this.sanitize(order)),
    );
    return paginate(sanitized, total, page, limit);
  }

  async findOne(id: string, repId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: this.orderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.createdByRepId !== repId) {
      throw new ForbiddenException('You do not have access to this order');
    }
    return this.sanitize(order);
  }
}
