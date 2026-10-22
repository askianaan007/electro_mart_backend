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
import { computeSupplierBalance } from '../common/utils/supplier-balance';
import {
  assertNotFutureBusinessDate,
  businessDateRange,
} from '../common/utils/business-date';
import { PurchaseReturnsService } from '../purchase-returns/purchase-returns.service';
import { CancelPurchaseDto } from './dto/cancel-purchase.dto';
import { SerialLifecycleService } from '../product-units/serial-lifecycle.service';
import { normalizeSerialList } from '../common/utils/serial';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
    private purchaseReturnsService: PurchaseReturnsService,
    private serials: SerialLifecycleService,
  ) {}

  /** Serials scanned per purchase line, normalized; one product's lines merged. */
  private serialLines(items: { productId: string; serials?: string[] }[]) {
    const merged = new Map<string, string[]>();
    for (const item of items) {
      if (!item.serials?.length) continue;
      merged.set(item.productId, [
        ...(merged.get(item.productId) ?? []),
        ...item.serials,
      ]);
    }
    return [...merged].map(([productId, raw]) => ({
      productId,
      serials: normalizeSerialList(raw),
    }));
  }

  private quantityByProduct(items: { productId: string; quantity: number }[]) {
    const qty = new Map<string, number>();
    for (const item of items) {
      qty.set(item.productId, (qty.get(item.productId) ?? 0) + item.quantity);
    }
    return qty;
  }

  private costByProduct(
    items: { productId: string; unitCost: Prisma.Decimal | number }[],
  ) {
    return new Map(
      items.map((item) => [item.productId, new Prisma.Decimal(item.unitCost)]),
    );
  }

  private async assertSupplierAndProductsExist(
    supplierId: string,
    items: { productId: string }[],
  ) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const productIds = items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const foundIds = new Set(products.map((p) => p.id));
    for (const productId of productIds) {
      if (!foundIds.has(productId)) {
        throw new NotFoundException(`Product ${productId} not found`);
      }
    }
  }

  async create(dto: CreatePurchaseDto, adminId: string) {
    await this.assertSupplierAndProductsExist(dto.supplierId, dto.items);
    const serialLines = this.serialLines(dto.items);

    return this.prisma.$transaction(async (tx) => {
      let totalValue = new Prisma.Decimal(0);
      const itemsData = dto.items.map((item) => {
        const lineTotal = new Prisma.Decimal(item.unitCost).mul(item.quantity);
        totalValue = totalValue.add(lineTotal);
        return {
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost,
          lineTotal,
        };
      });
      const transportCharges = dto.transportCharges ?? 0;

      const purchase = await tx.purchase.create({
        data: {
          supplierId: dto.supplierId,
          invoiceNumber: dto.invoiceNumber,
          purchaseDate: new Date(dto.purchaseDate),
          totalValue,
          transportCharges,
          adminId,
          items: { create: itemsData },
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

      const serialCount = await this.serials.registerForPurchase(
        tx,
        purchase,
        serialLines,
        this.quantityByProduct(purchase.items),
        this.costByProduct(purchase.items),
        adminId,
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PURCHASE',
        targetId: purchase.id,
        details:
          `Purchase ${purchase.invoiceNumber} from ${purchase.supplier.name} for ${totalValue.toString()} (${purchase.items.length} item(s))` +
          (transportCharges > 0
            ? `, transport charges ${transportCharges} deducted from supplier credit`
            : '') +
          (serialCount > 0 ? `, ${serialCount} serial(s) registered` : ''),
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
        purchaseDate: businessDateRange(query.dateFrom, query.dateTo),
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        include: {
          supplier: true,
          items: { include: { product: true } },
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
        units: {
          select: {
            id: true,
            productId: true,
            serialNumber: true,
            status: true,
            condition: true,
          },
          orderBy: { serialKey: 'asc' },
        },
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

    if (purchase.cancelledAt) {
      throw new BadRequestException(
        'This purchase is cancelled — reinstate it before editing.',
      );
    }
    if (purchase.purchaseReturns.length > 0) {
      throw new BadRequestException(
        'This purchase has returns recorded against it and cannot be edited.',
      );
    }

    await this.assertSupplierAndProductsExist(dto.supplierId, dto.items);
    const serialLines = this.serialLines(dto.items);

    return this.prisma.$transaction(async (tx) => {
      await this.lockSuppliers(tx, [purchase.supplierId, dto.supplierId]);
      const balanceBefore = await this.supplierBalanceOf(
        tx,
        purchase.supplierId,
      );
      await this.serials.assertPurchaseEditable(
        tx,
        id,
        this.quantityByProduct(dto.items),
      );
      const shelfGuard = await this.serials.beginShelfGuard(tx, [
        ...purchase.items.map((item) => item.productId),
        ...dto.items.map((item) => item.productId),
      ]);

      for (const item of purchase.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: `Reversed for edit of purchase ${purchase.invoiceNumber}`,
        });
      }
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });

      let totalValue = new Prisma.Decimal(0);
      const itemsData = dto.items.map((item) => {
        const lineTotal = new Prisma.Decimal(item.unitCost).mul(item.quantity);
        totalValue = totalValue.add(lineTotal);
        return {
          productId: item.productId,
          quantity: item.quantity,
          unitCost: item.unitCost,
          lineTotal,
        };
      });
      const transportCharges = dto.transportCharges ?? 0;

      const updated = await tx.purchase.update({
        where: { id },
        data: {
          supplierId: dto.supplierId,
          invoiceNumber: dto.invoiceNumber,
          purchaseDate: new Date(dto.purchaseDate),
          totalValue,
          transportCharges,
          items: { create: itemsData },
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

      await this.serials.registerForPurchase(
        tx,
        { ...updated, purchaseDate: updated.purchaseDate },
        serialLines,
        this.quantityByProduct(updated.items),
        this.costByProduct(updated.items),
        adminId,
      );
      await shelfGuard.assert();

      // Lowering the value, raising transport, or moving the purchase to
      // another supplier reduces what the original supplier is owed — not
      // below what we've already paid them (LC-20).
      await this.assertSupplierNotOverpaid(
        tx,
        purchase.supplierId,
        balanceBefore,
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_PURCHASE',
        targetId: id,
        details:
          `Updated purchase ${updated.invoiceNumber} from ${updated.supplier.name} (${updated.items.length} item(s), total ${totalValue.toString()})` +
          (transportCharges > 0
            ? `, transport charges ${transportCharges} deducted from supplier credit`
            : ''),
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Deletes a purchase and reverses its stock increase. Refused when returns
   * exist against it — they're separate supplier documents with their own
   * 1-day correction window, and silently deleting (and renumbering) old
   * ones would erase supplier history (LC-20). Also refused when the
   * supplier has already been paid more than they'd be owed without it:
   * that money has to come back as a supplier refund first.
   */
  async remove(id: string, adminId: string) {
    const purchase = await this.prisma.purchase.findUnique({
      where: { id },
      include: {
        items: true,
        purchaseReturns: { select: { returnNumber: true } },
        refunds: { select: { refundNumber: true } },
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.purchaseReturns.length > 0) {
      throw new BadRequestException(
        `This purchase has return(s) ${purchase.purchaseReturns.map((r) => r.returnNumber).join(', ')} recorded against it and cannot be deleted.`,
      );
    }
    if (purchase.refunds.length > 0) {
      throw new BadRequestException(
        `Supplier refund(s) ${purchase.refunds.map((r) => r.refundNumber).join(', ')} are linked to this purchase — unlink them before deleting it.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockSuppliers(tx, [purchase.supplierId]);
      const balanceBefore = await this.supplierBalanceOf(
        tx,
        purchase.supplierId,
      );
      const shelfGuard = await this.serials.beginShelfGuard(
        tx,
        purchase.items.map((item) => item.productId),
      );

      for (const item of purchase.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: `Reversal of deleted purchase ${purchase.invoiceNumber}`,
        });
      }

      await this.serials.deletePurchaseUnits(
        tx,
        id,
        purchase.invoiceNumber,
        adminId,
      );
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchase.delete({ where: { id } });
      await shelfGuard.assert();

      await this.assertSupplierNotOverpaid(
        tx,
        purchase.supplierId,
        balanceBefore,
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_PURCHASE',
        targetId: id,
        details: `Deleted purchase ${purchase.invoiceNumber} (${purchase.items.length} item(s), total ${purchase.totalValue.toString()}) and reversed its stock movements`,
      });

      return { message: 'Purchase deleted and stock reversed' };
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Calls the order off. Everything still held from it (quantity bought minus
   * any earlier returns) goes back to the supplier as one return flagged
   * isCancellation, so stock and the supplier's payable drop by the same
   * value — through the same rules as any other return. Money already paid
   * toward it isn't touched: if the supplier now owes us, that shows as
   * their credit until a supplier refund is recorded (cash/bank when
   * received, or a cheque that counts in Liquid Cash only once cleared).
   * Refused if some of the goods have been sold since — record a partial
   * return instead.
   */
  async cancel(id: string, dto: CancelPurchaseDto, adminId: string) {
    assertNotFutureBusinessDate(dto.cancelDate, 'Cancellation date');

    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.purchaseReturnsService.lockPurchase(tx, id);
      if (purchase.cancelledAt) {
        throw new BadRequestException('This purchase is already cancelled');
      }
      // Same supplier lock as settlements, so one can't be paid against the
      // payable this cancellation is about to reduce.
      await this.lockSuppliers(tx, [purchase.supplierId]);

      const remaining = await this.purchaseReturnsService.remainingQuantities(
        tx,
        purchase,
      );
      const items = [...remaining]
        .filter(([, quantity]) => quantity > 0)
        .map(([productId, quantity]) => ({ productId, quantity }));
      const shelfGuard = await this.serials.beginShelfGuard(
        tx,
        items.map((item) => item.productId),
      );

      let cancellationReturn: { returnNumber: string } | null = null;
      if (items.length > 0) {
        try {
          cancellationReturn =
            await this.purchaseReturnsService.insertAgainstPurchase(
              tx,
              purchase,
              {
                reason: `Order cancelled: ${dto.reason}`,
                returnDate: dto.cancelDate,
                items,
              },
              adminId,
              true,
            );
        } catch (error) {
          if (
            error instanceof BadRequestException &&
            error.message.startsWith('Insufficient stock')
          ) {
            throw new BadRequestException(
              `Can't cancel this order: some of its goods have already left stock (${error.message}). Record a return for the units still held instead.`,
            );
          }
          throw error;
        }
      }

      await shelfGuard.assert();

      const updated = await tx.purchase.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelReason: dto.reason },
        include: { supplier: true },
      });
      const balance = await this.supplierBalanceOf(tx, purchase.supplierId);

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CANCELLED_PURCHASE',
        targetId: id,
        details:
          `Cancelled purchase ${purchase.invoiceNumber} from ${updated.supplier.name} (${dto.reason})` +
          (cancellationReturn
            ? `; goods returned as ${cancellationReturn.returnNumber}`
            : '; nothing left to return') +
          (balance.isNegative()
            ? `; supplier now owes ${balance.abs().toString()}`
            : ''),
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Undoes cancel(): removes its cancellation return (stock comes back in,
   * the supplier's payable goes back up) and makes the order active again.
   * Refunds already received for it stay — they are real money and are
   * corrected on their own.
   */
  async reinstate(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await this.purchaseReturnsService.lockPurchase(tx, id);
      if (!purchase.cancelledAt) {
        throw new BadRequestException('This purchase is not cancelled');
      }
      await this.lockSuppliers(tx, [purchase.supplierId]);

      const cancellationReturn = await tx.purchaseReturn.findFirst({
        where: { purchaseId: id, isCancellation: true },
        include: { items: true },
      });
      if (cancellationReturn) {
        await this.purchaseReturnsService.deleteWithin(
          tx,
          cancellationReturn,
          adminId,
        );
      }

      const updated = await tx.purchase.update({
        where: { id },
        data: { cancelledAt: null, cancelReason: null },
      });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'REINSTATED_PURCHASE',
        targetId: id,
        details:
          `Reinstated cancelled purchase ${purchase.invoiceNumber}` +
          (cancellationReturn
            ? `; cancellation return ${cancellationReturn.returnNumber} removed and stock restored`
            : ''),
      });
      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /** Same lock CreditsService takes for settlements; sorted so two edits can't deadlock. */
  private async lockSuppliers(tx: Prisma.TransactionClient, ids: string[]) {
    for (const supplierId of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${supplierId} FOR UPDATE`;
    }
  }

  private async supplierBalanceOf(
    tx: Prisma.TransactionClient,
    supplierId: string,
  ) {
    return (await computeSupplierBalance(tx, supplierId)).balance;
  }

  /**
   * Refuses a change that pushes the supplier into (further) credit — i.e.
   * we'd have paid more than they're owed. A supplier already in credit for
   * another reason (a return after full settlement) isn't blocked by changes
   * that don't make it worse.
   */
  private async assertSupplierNotOverpaid(
    tx: Prisma.TransactionClient,
    supplierId: string,
    balanceBefore: Prisma.Decimal,
  ) {
    const balance = await this.supplierBalanceOf(tx, supplierId);
    if (balance.isNegative() && balance.lessThan(balanceBefore)) {
      throw new BadRequestException(
        `This change would leave the supplier owing us ${balance.abs().toString()} — more has already been paid to them than they would be owed. Record a supplier refund first, or correct the payments.`,
      );
    }
  }
}
