import { Injectable, NotFoundException } from '@nestjs/common';
import { InventoryLogType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
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

      return purchase;
    }, TRANSACTION_OPTIONS);
  }

  async findAll(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        include: { supplier: true, items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.purchase.count(),
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
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return purchase;
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
