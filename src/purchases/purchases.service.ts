import { Injectable, NotFoundException } from '@nestjs/common';
import { InventoryLogType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
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
}
