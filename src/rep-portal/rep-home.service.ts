import { Injectable } from '@nestjs/common';
import { AccountStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RepCatalogVisibilityService } from '../rep-catalog-visibility/rep-catalog-visibility.service';

const FULFILLMENT_STATUSES: OrderStatus[] = [
  OrderStatus.APPROVED,
  OrderStatus.PACKED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
];

/**
 * Rep Portal homepage/search/dashboard (Rep_Portal_DOCUMENTATION.md §4, §6,
 * §18). Every product read here goes through RepCatalogVisibilityService so
 * assignment-scoping and stock-visibility are resolved identically to the
 * extended Products/Categories read routes.
 */
@Injectable()
export class RepHomeService {
  constructor(
    private prisma: PrismaService,
    private repCatalogVisibility: RepCatalogVisibilityService,
  ) {}

  private readonly productImagesInclude = {
    images: { orderBy: { sortOrder: 'asc' } as const },
  } satisfies Prisma.ProductInclude;

  async home(repId: string) {
    const scopeWhere =
      await this.repCatalogVisibility.buildAssignedProductWhereClause(repId);
    const baseWhere: Prisma.ProductWhereInput = {
      status: AccountStatus.ACTIVE,
      ...scopeWhere,
    };

    const [banners, categories, brands, newArrivals, recommended, offersRaw] =
      await Promise.all([
        this.repCatalogVisibility.getVisibleBanners(repId),
        this.prisma.category.findMany({
          where: { isFeatured: true },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.brand.findMany({
          where: { isFeatured: true, status: AccountStatus.ACTIVE },
          orderBy: { sortOrder: 'asc' },
        }),
        this.prisma.product.findMany({
          where: baseWhere,
          include: this.productImagesInclude,
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.prisma.product.findMany({
          where: { ...baseWhere, isFeatured: true },
          include: this.productImagesInclude,
          take: 10,
        }),
        this.prisma.product.findMany({
          where: { ...baseWhere, compareAtPrice: { not: null } },
          include: this.productImagesInclude,
          take: 20,
        }),
      ]);

    // Offers: compareAtPrice must actually exceed the quoted price (retail,
    // falling back to wholesale) to count as a real discount.
    const offers = offersRaw
      .filter((p) => {
        const quoted = Number(p.retailPrice ?? p.wholesalePrice);
        return p.compareAtPrice && Number(p.compareAtPrice) > quoted;
      })
      .slice(0, 10);

    const bestSellers = await this.getBestSellers(baseWhere, 10);

    return {
      banners,
      featuredCategories: categories,
      featuredBrands: brands,
      newArrivals:
        await this.repCatalogVisibility.serializeManyForRep(newArrivals),
      bestSellers:
        await this.repCatalogVisibility.serializeManyForRep(bestSellers),
      offers: await this.repCatalogVisibility.serializeManyForRep(offers),
      recommended: await this.repCatalogVisibility.serializeManyForRep(
        recommended.length > 0 ? recommended : newArrivals.slice(0, 8),
      ),
    };
  }

  private async getBestSellers(
    baseWhere: Prisma.ProductWhereInput,
    take: number,
  ) {
    const grouped = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { status: { in: FULFILLMENT_STATUSES } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: take * 3, // over-fetch, then intersect with the visibility scope below
    });
    if (grouped.length === 0) {
      return this.prisma.product.findMany({
        where: baseWhere,
        include: this.productImagesInclude,
        take,
      });
    }

    const products = await this.prisma.product.findMany({
      where: { ...baseWhere, id: { in: grouped.map((g) => g.productId) } },
      include: this.productImagesInclude,
    });
    const rank = new Map(grouped.map((g, index) => [g.productId, index]));
    return products
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
      .slice(0, take);
  }

  async search(repId: string, query: string) {
    if (!query.trim()) return [];
    const scopeWhere =
      await this.repCatalogVisibility.buildAssignedProductWhereClause(repId);

    const products = await this.prisma.product.findMany({
      where: {
        status: AccountStatus.ACTIVE,
        ...scopeWhere,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { sku: { contains: query, mode: 'insensitive' } },
          { barcode: { contains: query, mode: 'insensitive' } },
          { productCode: { contains: query, mode: 'insensitive' } },
          { brand: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
          { model: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: this.productImagesInclude,
      take: 20,
    });

    return this.repCatalogVisibility.serializeManyForRep(products);
  }

  async dashboard(repId: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(
      startOfToday.getFullYear(),
      startOfToday.getMonth(),
      1,
    );

    const where = { createdByRepId: repId };
    const [
      todaysOrders,
      monthlyOrders,
      pendingOrders,
      completedOrders,
      revenueAgg,
      customersRegistered,
      recentOrders,
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
      this.prisma.dealer.count({ where: { createdByRepId: repId } }),
      this.prisma.order.findMany({
        where,
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          items: { include: { product: true } },
          dealer: { omit: { password: true } },
          invoice: true,
        },
      }),
    ]);

    const sanitizedRecentOrders = await Promise.all(
      recentOrders.map(async (order) => ({
        ...order,
        items: await Promise.all(
          order.items.map(async (item) => ({
            ...item,
            product: await this.repCatalogVisibility.serializeForRep(
              item.product,
            ),
          })),
        ),
      })),
    );

    return {
      todaysOrders,
      monthlyOrders,
      pendingOrders,
      completedOrders,
      revenue: revenueAgg._sum.totalAmount ?? 0,
      customersRegistered,
      recentOrders: sanitizedRecentOrders,
    };
  }
}
