import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLogType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  CreateReplacementReceiptDto,
  ReplacementReceiptItemDto,
} from './dto/create-replacement-receipt.dto';
import { UpdateReplacementReceiptDto } from './dto/update-replacement-receipt.dto';
import { QueryReplacementReceiptsDto } from './dto/query-replacement-receipts.dto';
import { paginate } from '../common/utils/paginate';
import {
  nextSequenceNumber,
  resetSequenceCounter,
} from '../common/utils/sequence';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEQUENCE_KEY = 'purchaseReturnReplacement';

type TransactionClient = Prisma.TransactionClient;

export type ReplacementStatus = 'NOT_REPLACED' | 'PARTIAL' | 'FULL';

/**
 * Derives a return's replacement progress from its items and receipts —
 * never stored, so returns recorded before this feature existed need no
 * backfill and simply read as NOT_REPLACED.
 */
export function withReplacementSummary<
  R extends {
    totalAmount: Prisma.Decimal;
    items: { id: string; quantity: number }[];
    replacements?: {
      totalAmount: Prisma.Decimal;
      items: { purchaseReturnItemId: string; quantity: number }[];
    }[];
  },
>(purchaseReturn: R) {
  const replacements = purchaseReturn.replacements ?? [];
  const receivedByItem = new Map<string, number>();
  let receivedAmount = new Prisma.Decimal(0);
  for (const replacement of replacements) {
    receivedAmount = receivedAmount.add(replacement.totalAmount);
    for (const item of replacement.items) {
      receivedByItem.set(
        item.purchaseReturnItemId,
        (receivedByItem.get(item.purchaseReturnItemId) ?? 0) + item.quantity,
      );
    }
  }

  const items = purchaseReturn.items.map((item) => {
    const receivedQuantity = receivedByItem.get(item.id) ?? 0;
    return {
      ...item,
      receivedQuantity,
      remainingQuantity: item.quantity - receivedQuantity,
    };
  });

  const totalReturned = items.reduce((sum, i) => sum + i.quantity, 0);
  const totalReceived = items.reduce((sum, i) => sum + i.receivedQuantity, 0);
  const replacementStatus: ReplacementStatus =
    totalReceived === 0
      ? 'NOT_REPLACED'
      : totalReceived >= totalReturned
        ? 'FULL'
        : 'PARTIAL';

  return { ...purchaseReturn, items, receivedAmount, replacementStatus };
}

@Injectable()
export class ReplacementReceiptsService {
  constructor(
    private prisma: PrismaService,
    private inventoryService: InventoryService,
    private activityLogService: ActivityLogService,
  ) {}

  private readonly include = {
    supplier: true,
    admin: { select: { id: true, name: true } },
    purchaseReturn: {
      select: { id: true, returnNumber: true, purchaseId: true },
    },
    items: {
      include: {
        product: true,
        purchaseReturnItem: { select: { quantity: true } },
      },
    },
  } satisfies Prisma.PurchaseReturnReplacementInclude;

  /**
   * Records goods the supplier sent in place of a return. Everything —
   * header, lines, stock movements, activity log — happens in one
   * transaction, so a failure at any step leaves nothing behind. The
   * supplier's credit balance needs no separate write: it's derived from
   * these rows (supplierBalance()), so committing the receipt *is* the
   * balance change and can never drift from the stock movement.
   */
  async create(
    purchaseReturnId: string,
    dto: CreateReplacementReceiptDto,
    adminId: string,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialises every receipt for this return: a second concurrent
        // request waits here, then reads the first one's committed rows in
        // the checks below instead of a stale "already received" snapshot.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "PurchaseReturn" WHERE id = ${purchaseReturnId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new NotFoundException('Purchase return not found');
        }

        const existing = await tx.purchaseReturnReplacement.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
          include: this.include,
        });
        if (existing) {
          if (existing.purchaseReturnId !== purchaseReturnId) {
            throw new ConflictException(
              'This request key was already used for a different return',
            );
          }
          return existing;
        }

        const purchaseReturn = await tx.purchaseReturn.findUniqueOrThrow({
          where: { id: purchaseReturnId },
          include: {
            supplier: true,
            items: { include: { replacementItems: true } },
          },
        });

        const receivedDate = new Date(dto.receivedDate);
        assertReceivedDate(receivedDate, purchaseReturn.returnDate);
        const { itemsData, totalAmount } = priceReceiptLines(
          purchaseReturn,
          dto.items,
        );

        const replacementNumber = await nextSequenceNumber(
          tx,
          SEQUENCE_KEY,
          'RPLC',
        );

        const replacement = await tx.purchaseReturnReplacement.create({
          data: {
            replacementNumber,
            idempotencyKey: dto.idempotencyKey,
            purchaseReturnId: purchaseReturn.id,
            supplierId: purchaseReturn.supplierId,
            totalAmount,
            receivedDate,
            reference: dto.reference || null,
            notes: dto.notes || null,
            adminId,
            items: { create: itemsData },
          },
          include: this.include,
        });

        for (const item of itemsData) {
          await this.inventoryService.recordMovement(tx, {
            productId: item.productId,
            type: InventoryLogType.ADJUSTMENT,
            quantityIn: item.quantity,
            reference: replacement.id,
          });
        }

        await assertNotOverReceived(tx, purchaseReturn.id);

        await this.activityLogService.log(tx, {
          adminId,
          action: 'RECORDED_REPLACEMENT_RECEIPT',
          targetId: replacement.id,
          details: `Replacement receipt ${replacementNumber} of ${totalAmount.toString()} from ${purchaseReturn.supplier.name} for return ${purchaseReturn.returnNumber}`,
        });

        return replacement;
      }, TRANSACTION_OPTIONS);
    } catch (error) {
      // Two identical requests racing past the lookup above: the unique
      // index rejects the loser — answer it with the winner's receipt.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.purchaseReturnReplacement.findUnique(
          {
            where: { idempotencyKey: dto.idempotencyKey },
            include: this.include,
          },
        );
        if (existing && existing.purchaseReturnId === purchaseReturnId) {
          return existing;
        }
      }
      throw error;
    }
  }

  async findAll(query: QueryReplacementReceiptsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PurchaseReturnReplacementWhereInput = {
      ...(query.supplierId && { supplierId: query.supplierId }),
      ...(query.search && {
        OR: [
          {
            replacementNumber: { contains: query.search, mode: 'insensitive' },
          },
          { reference: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
      ...((query.dateFrom || query.dateTo) && {
        receivedDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lte: new Date(query.dateTo) }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchaseReturnReplacement.findMany({
        where,
        include: this.include,
        orderBy: [{ receivedDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.purchaseReturnReplacement.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findForReturn(purchaseReturnId: string) {
    return this.prisma.purchaseReturnReplacement.findMany({
      where: { purchaseReturnId },
      include: this.include,
      orderBy: [{ receivedDate: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(id: string) {
    const replacement = await this.prisma.purchaseReturnReplacement.findUnique({
      where: { id },
      include: this.include,
    });
    if (!replacement) {
      throw new NotFoundException('Replacement receipt not found');
    }
    return replacement;
  }

  /**
   * Corrects a mistaken receipt within 1 day of recording it — wrong
   * quantity, wrong return line (i.e. wrong product), or wrong date/ref.
   * Lines are re-priced from the return exactly as on create, so the
   * receipt's value and the supplier balance follow automatically. Stock is
   * moved by the per-product *net* difference only (old → new), so fixing
   * a count doesn't spuriously fail just because some of the units have
   * since been sold. One transaction, same row lock and over-receive check
   * as create().
   */
  async update(id: string, dto: UpdateReplacementReceiptDto, adminId: string) {
    const current = await this.prisma.purchaseReturnReplacement.findUnique({
      where: { id },
      select: { purchaseReturnId: true },
    });
    if (!current) {
      throw new NotFoundException('Replacement receipt not found');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseReturn" WHERE id = ${current.purchaseReturnId} FOR UPDATE`;

      // Re-read under the lock — a concurrent void/edit may have committed.
      const replacement = await tx.purchaseReturnReplacement.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!replacement) {
        throw new NotFoundException('Replacement receipt not found');
      }
      assertWithinEditWindow(replacement.createdAt, 'edited');

      const purchaseReturn = await tx.purchaseReturn.findUniqueOrThrow({
        where: { id: replacement.purchaseReturnId },
        include: {
          supplier: true,
          items: { include: { replacementItems: true } },
        },
      });

      const receivedDate = new Date(dto.receivedDate);
      assertReceivedDate(receivedDate, purchaseReturn.returnDate);
      // Excluding this receipt's own lines, so its old quantities don't
      // count against the corrected ones.
      const { itemsData, totalAmount } = priceReceiptLines(
        purchaseReturn,
        dto.items,
        replacement.id,
      );

      const netByProduct = new Map<string, number>();
      for (const item of replacement.items) {
        netByProduct.set(
          item.productId,
          (netByProduct.get(item.productId) ?? 0) - item.quantity,
        );
      }
      for (const item of itemsData) {
        netByProduct.set(
          item.productId,
          (netByProduct.get(item.productId) ?? 0) + item.quantity,
        );
      }

      const updated = await tx.purchaseReturnReplacement.update({
        where: { id },
        data: {
          totalAmount,
          receivedDate,
          reference: dto.reference || null,
          notes: dto.notes || null,
          items: { deleteMany: {}, create: itemsData },
        },
        include: this.include,
      });

      for (const [productId, delta] of netByProduct) {
        if (delta === 0) continue;
        await this.inventoryService.recordMovement(tx, {
          productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityIn: delta > 0 ? delta : 0,
          quantityOut: delta < 0 ? -delta : 0,
          reference: replacement.id,
        });
      }

      await assertNotOverReceived(tx, purchaseReturn.id);

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_REPLACEMENT_RECEIPT',
        targetId: id,
        details: `Updated replacement receipt ${replacement.replacementNumber} for return ${purchaseReturn.returnNumber} (${purchaseReturn.supplier.name}): ${replacement.totalAmount.toString()} -> ${totalAmount.toString()}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  /**
   * Voids a mistaken receipt within 1 day of recording it: takes the units
   * back out of stock (failing cleanly via recordMovement's negative-stock
   * guard if they've already been sold) and removes the receipt, which in
   * turn removes its value from the supplier balance.
   */
  async void(id: string, adminId: string) {
    const replacement = await this.prisma.purchaseReturnReplacement.findUnique({
      where: { id },
      include: { items: true, supplier: true, purchaseReturn: true },
    });
    if (!replacement) {
      throw new NotFoundException('Replacement receipt not found');
    }
    assertWithinEditWindow(replacement.createdAt, 'voided');

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PurchaseReturn" WHERE id = ${replacement.purchaseReturnId} FOR UPDATE`;

      for (const item of replacement.items) {
        await this.inventoryService.recordMovement(tx, {
          productId: item.productId,
          type: InventoryLogType.ADJUSTMENT,
          quantityOut: item.quantity,
          reference: `Void of replacement receipt ${replacement.replacementNumber}`,
        });
      }

      await tx.purchaseReturnReplacementItem.deleteMany({
        where: { replacementId: id },
      });
      await tx.purchaseReturnReplacement.delete({ where: { id } });

      const remaining = await tx.purchaseReturnReplacement.findMany({
        select: { replacementNumber: true },
      });
      await resetSequenceCounter(
        tx,
        SEQUENCE_KEY,
        remaining.map((r) => r.replacementNumber),
      );

      await this.activityLogService.log(tx, {
        adminId,
        action: 'VOIDED_REPLACEMENT_RECEIPT',
        targetId: id,
        details: `Voided replacement receipt ${replacement.replacementNumber} of ${replacement.totalAmount.toString()} from ${replacement.supplier.name} for return ${replacement.purchaseReturn.returnNumber}`,
      });

      return { message: 'Replacement receipt voided' };
    }, TRANSACTION_OPTIONS);
  }
}

function startOfUtcDay(date: Date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function assertWithinEditWindow(createdAt: Date, verb: 'edited' | 'voided') {
  if (Date.now() - createdAt.getTime() > DAY_MS) {
    throw new BadRequestException(
      `A replacement receipt can only be ${verb} within 1 day of being recorded`,
    );
  }
}

function assertReceivedDate(receivedDate: Date, returnDate: Date) {
  if (receivedDate.getTime() < startOfUtcDay(returnDate)) {
    throw new BadRequestException(
      'Received date cannot be before the return date',
    );
  }
  if (receivedDate.getTime() > Date.now() + DAY_MS) {
    throw new BadRequestException('Received date cannot be in the future');
  }
}

/**
 * Validates requested lines against what's still outstanding per return
 * line and prices them from the return line — never from the client — so a
 * full replacement reverses exactly the credit the return took off.
 * `excludeReplacementId` leaves one receipt's own lines out of "already
 * received" (used when editing that receipt).
 */
function priceReceiptLines(
  purchaseReturn: {
    returnNumber: string;
    items: {
      id: string;
      productId: string;
      quantity: number;
      unitCost: Prisma.Decimal;
      replacementItems: { replacementId: string; quantity: number }[];
    }[];
  },
  dtoItems: ReplacementReceiptItemDto[],
  excludeReplacementId?: string,
) {
  const requestedByItem = new Map<string, number>();
  for (const item of dtoItems) {
    requestedByItem.set(
      item.purchaseReturnItemId,
      (requestedByItem.get(item.purchaseReturnItemId) ?? 0) + item.quantity,
    );
  }

  let totalAmount = new Prisma.Decimal(0);
  const itemsData = [...requestedByItem].map(([returnItemId, qty]) => {
    const returnItem = purchaseReturn.items.find((i) => i.id === returnItemId);
    if (!returnItem) {
      throw new BadRequestException(
        `Return line ${returnItemId} does not belong to return ${purchaseReturn.returnNumber}`,
      );
    }
    const alreadyReceived = returnItem.replacementItems
      .filter(
        (r) =>
          !excludeReplacementId || r.replacementId !== excludeReplacementId,
      )
      .reduce((sum, r) => sum + r.quantity, 0);
    const remaining = returnItem.quantity - alreadyReceived;
    if (qty > remaining) {
      throw new BadRequestException(
        `Cannot receive ${qty} for a return line with only ${remaining} remaining to be replaced`,
      );
    }
    const lineTotal = returnItem.unitCost.mul(qty);
    totalAmount = totalAmount.add(lineTotal);
    return {
      purchaseReturnItemId: returnItem.id,
      productId: returnItem.productId,
      quantity: qty,
      unitCost: returnItem.unitCost,
      lineTotal,
    };
  });

  return { itemsData, totalAmount };
}

// Defence in depth: re-read what's now written in this transaction and
// refuse to commit if any return line is over-received.
async function assertNotOverReceived(
  tx: TransactionClient,
  purchaseReturnId: string,
) {
  const overReceived = await tx.$queryRaw<{ id: string }[]>`
    SELECT pri.id
    FROM "PurchaseReturnItem" pri
    JOIN "PurchaseReturnReplacementItem" rri ON rri."purchaseReturnItemId" = pri.id
    WHERE pri."purchaseReturnId" = ${purchaseReturnId}
    GROUP BY pri.id, pri.quantity
    HAVING SUM(rri.quantity) > pri.quantity
  `;
  if (overReceived.length > 0) {
    throw new ConflictException(
      'Replacement quantity would exceed the returned quantity',
    );
  }
}
