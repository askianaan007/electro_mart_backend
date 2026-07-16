import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { QueryPurchasesDto } from './dto/query-purchases.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreatePurchaseDto, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const totalValue = dto.items.reduce(
        (sum, item) => sum + item.quantity * item.unitCost,
        0,
      );

      const purchase = await tx.purchase.create({
        data: {
          supplierId: dto.supplierId,
          invoiceNumber: dto.invoiceNumber,
          purchaseDate: new Date(dto.purchaseDate),
          totalValue,
          adminId,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitCost: item.unitCost,
              lineTotal: item.quantity * item.unitCost,
            })),
          },
        },
        include: { items: true, supplier: true },
      });

      for (const item of purchase.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.PURCHASE,
          quantityIn: item.quantity,
          reference: purchase.id,
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PURCHASE',
        targetId: purchase.id,
        details: `Purchase ${purchase.invoiceNumber} from ${purchase.supplier.name} for ${totalValue} (${purchase.items.length} item(s))`,
      });

      return purchase;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: QueryPurchasesDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PurchaseWhereInput = {
      ...(query.supplierId && { supplierId: query.supplierId }),
      ...(query.search && {
        invoiceNumber: { contains: query.search, mode: 'insensitive' },
      }),
      ...((query.dateFrom || query.dateTo) && {
        purchaseDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        include: {
          supplier: true,
          items: true,
          purchaseReturns: { select: { totalAmount: true } },
        },
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: {
        supplier: true,
        items: { include: { product: true } },
        admin: { omit: { password: true } },
        purchaseReturns: { select: { totalAmount: true } },
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return purchase;
  }

  /**
   * Replaces a purchase's details and line items. Reverses the stock the
   * original items brought in, then applies the new items, so it fails
   * loudly (via recordMovement's negative-stock guard) if any of that stock
   * has since been sold. Blocked entirely if returns exist against this
   * purchase, since they reference quantities from the original items.
   */
  async update(id: string, dto: UpdatePurchaseDto, adminId: string) {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: { items: true, purchaseReturns: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    if (purchase.purchaseReturns.length > 0) {
      throw new BadRequestException(
        'This purchase has returns recorded against it and cannot be edited. Delete the purchase instead if it needs to be corrected.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      for (const item of purchase.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: `Reversed for edit of purchase ${purchase.invoiceNumber}`,
        });
      }
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });

      const totalValue = dto.items.reduce(
        (sum, item) => sum + item.quantity * item.unitCost,
        0,
      );

      const updated = await tx.purchase.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          invoiceNumber: dto.invoiceNumber,
          purchaseDate: new Date(dto.purchaseDate),
          totalValue,
          items: {
            create: dto.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitCost: item.unitCost,
              lineTotal: item.quantity * item.unitCost,
            })),
          },
        },
        include: { items: true, supplier: true },
      });

      for (const item of updated.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.PURCHASE,
          quantityIn: item.quantity,
          reference: purchase.id,
        });
      }

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PURCHASE',
        targetId: id,
        details: `Updated purchase ${updated.invoiceNumber} from ${updated.supplier.name} (${updated.items.length} item(s), total ${totalValue})`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Deletes a purchase and unwinds everything it caused: any purchase
   * returns recorded against it (restoring the stock that had gone back to
   * the supplier), then the purchase's own stock increase. Each reversal
   * goes through recordMovement, so if stock has since been sold below what
   * the purchase brought in, this fails loudly instead of driving stock
   * negative.
   */
  async remove(id: string, adminId: string) {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: {
        items: true,
        purchaseReturns: { include: { items: true } },
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    return this.prisma.$transaction(async (tx) => {
      for (const purchaseReturn of purchase.purchaseReturns) {
        for (const item of purchaseReturn.items) {
          await this.inventoryService.recordMovement(tx, {
            productId: item.productId,
            type: InventoryLogType.ADJUSTMENT,
            quantityIn: item.quantity,
            reference: `Reversal of deleted return ${purchaseReturn.returnNumber}`,
          });
        }
        await tx.purchaseReturnItem.deleteMany({
          where: { purchaseReturnId: purchaseReturn.id },
        });
        await tx.purchaseReturn.delete({ where: { id: purchaseReturn.id } });
      }

      for (const item of purchase.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: `Reversal of deleted purchase ${purchase.invoiceNumber}`,
        });
      }

      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchase.delete({ where: { id } });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_PURCHASE',
        targetId: id,
        details: `Deleted purchase ${purchase.invoiceNumber} (${purchase.items.length} item(s)) and reversed its stock movements${purchase.purchaseReturns.length ? `, including ${purchase.purchaseReturns.length} return(s)` : ''}`,
      });

      return { message: 'Purchase deleted and stock reversed' };
    }, TRANSACTION_OPTIONS);
  }
}
