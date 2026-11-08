import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type RepVisibleProduct<
  T extends { currentStock: number; costPrice?: unknown },
> = Omit<T, 'currentStock' | 'costPrice' | 'isOutOfStock'> & {
  stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK';
};

/**
 * Shared by the Rep Portal's own catalog reads (RepHomeService) and the
 * existing Products/Categories controllers' read routes once REPRESENTATIVE
 * is added to them (version2_changes_backend.md §6, §8). Centralized here so
 * both call sites resolve product-assignment scoping and stock visibility
 * identically — never duplicated, never drifting apart.
 */
@Injectable()
export class RepCatalogVisibilityService {
  constructor(private prisma: PrismaService) {}

  /**
   * A representative's catalog is opt-in (§6) — if any ProductAssignment
   * rows exist for them, the returned where-clause restricts to exactly
   * those scopes; if none exist, returns an empty clause (no restriction),
   * so a newly-created representative with nothing assigned yet isn't
   * silently shown an empty catalog before an admin has configured anything.
   */
  async buildAssignedProductWhereClause(
    representativeId: string,
  ): Promise<Prisma.ProductWhereInput> {
    const assignments = await this.prisma.productAssignment.findMany({
      where: { representativeId },
    });
    if (assignments.length === 0) return {};

    const productIds = assignments
      .filter((a) => a.scopeType === 'PRODUCT')
      .map((a) => a.scopeValue);
    const categories = assignments
      .filter((a) => a.scopeType === 'CATEGORY')
      .map((a) => a.scopeValue);
    const brands = assignments
      .filter((a) => a.scopeType === 'BRAND')
      .map((a) => a.scopeValue);
    // CAMPAIGN scope is resolved via CommissionRule.campaignName rather than
    // a direct product field — a campaign assignment shows every product
    // that currently has an active campaign commission rule under that name.
    const campaigns = assignments
      .filter((a) => a.scopeType === 'CAMPAIGN')
      .map((a) => a.scopeValue);

    const or: Prisma.ProductWhereInput[] = [];
    if (productIds.length > 0) or.push({ id: { in: productIds } });
    if (categories.length > 0) or.push({ category: { in: categories } });
    if (brands.length > 0) or.push({ brand: { in: brands } });
    if (campaigns.length > 0) {
      or.push({
        commissionRules: {
          some: { isCampaign: true, campaignName: { in: campaigns } },
        },
      });
    }

    return { OR: or };
  }

  /**
   * Write-path counterpart of buildAssignedProductWhereClause — rejects any
   * productId that doesn't exist (404) or falls outside the representative's
   * assigned catalog (403), so a rep can't order/draft products they can't
   * see. Returns the matched products (deduplicated by id) for any further
   * caller-specific checks.
   */
  async assertProductsInRepScope(
    representativeId: string,
    productIds: string[],
  ): Promise<{ id: string; name: string; status: AccountStatus }[]> {
    const uniqueIds = [...new Set(productIds)];
    if (uniqueIds.length === 0) return [];

    const scopeWhere =
      await this.buildAssignedProductWhereClause(representativeId);
    const [existing, inScope] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, name: true, status: true },
      }),
      this.prisma.product.findMany({
        where: { AND: [{ id: { in: uniqueIds } }, scopeWhere] },
        select: { id: true },
      }),
    ]);

    const existingIds = new Set(existing.map((p) => p.id));
    const missing = uniqueIds.find((id) => !existingIds.has(id));
    if (missing) throw new NotFoundException(`Product ${missing} not found`);

    const inScopeIds = new Set(inScope.map((p) => p.id));
    const outOfScope = existing.find((p) => !inScopeIds.has(p.id));
    if (outOfScope) {
      throw new ForbiddenException(
        `Product "${outOfScope.name}" is not in your assigned catalog`,
      );
    }

    return existing;
  }

  /**
   * §8 — a representative must never see or infer the real warehouse
   * quantity. Resolves the same real currentStock check every other role
   * already uses, unless an admin has set an explicit override.
   */
  async resolveStockStatus(
    productId: string,
    currentStock: number,
  ): Promise<'IN_STOCK' | 'OUT_OF_STOCK'> {
    const override = await this.prisma.productAvailabilityOverride.findUnique({
      where: { productId },
    });
    if (override) return override.forceAvailable ? 'IN_STOCK' : 'OUT_OF_STOCK';
    return currentStock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
  }

  async resolveStockStatusMany(
    products: { id: string; currentStock: number }[],
  ): Promise<Map<string, 'IN_STOCK' | 'OUT_OF_STOCK'>> {
    const overrides = await this.prisma.productAvailabilityOverride.findMany({
      where: { productId: { in: products.map((p) => p.id) } },
    });
    const overrideMap = new Map(
      overrides.map((o) => [o.productId, o.forceAvailable]),
    );
    const result = new Map<string, 'IN_STOCK' | 'OUT_OF_STOCK'>();
    for (const product of products) {
      const forced = overrideMap.get(product.id);
      const status: 'IN_STOCK' | 'OUT_OF_STOCK' =
        forced !== undefined
          ? forced
            ? 'IN_STOCK'
            : 'OUT_OF_STOCK'
          : product.currentStock > 0
            ? 'IN_STOCK'
            : 'OUT_OF_STOCK';
      result.set(product.id, status);
    }
    return result;
  }

  /** Strips costPrice and the raw currentStock/isOutOfStock fields, replacing them with a resolved stockStatus. */
  async serializeForRep<
    T extends {
      id: string;
      currentStock: number;
      costPrice?: unknown;
      isOutOfStock?: boolean;
    },
  >(product: T): Promise<RepVisibleProduct<T>> {
    const stockStatus = await this.resolveStockStatus(
      product.id,
      product.currentStock,
    );
    const rest: Partial<T> = { ...product };
    delete rest.currentStock;
    delete rest.costPrice;
    delete rest.isOutOfStock;
    return { ...rest, stockStatus } as RepVisibleProduct<T>;
  }

  async serializeManyForRep<
    T extends {
      id: string;
      currentStock: number;
      costPrice?: unknown;
      isOutOfStock?: boolean;
    },
  >(products: T[]): Promise<RepVisibleProduct<T>[]> {
    const statusMap = await this.resolveStockStatusMany(products);
    return products.map((product) => {
      const rest: Partial<T> = { ...product };
      delete rest.currentStock;
      delete rest.costPrice;
      delete rest.isOutOfStock;
      return {
        ...rest,
        stockStatus: statusMap.get(product.id) ?? 'OUT_OF_STOCK',
      } as RepVisibleProduct<T>;
    });
  }

  /** §7 — a rep's homepage banners are their own assignments if any exist, else the existing global active list. */
  async getVisibleBanners(representativeId: string) {
    const now = new Date();
    const assigned = await this.prisma.bannerAssignment.findMany({
      where: {
        representativeId,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      },
      include: { banner: true },
      orderBy: { priority: 'desc' },
    });

    const activeAssigned = assigned
      .map((a) => a.banner)
      .filter((b) => b.status === AccountStatus.ACTIVE);
    if (activeAssigned.length > 0) return activeAssigned;

    return this.prisma.banner.findMany({
      where: { status: AccountStatus.ACTIVE },
      orderBy: { sortOrder: 'asc' },
    });
  }
}
