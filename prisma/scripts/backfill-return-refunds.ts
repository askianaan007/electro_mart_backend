/**
 * One-off backfill: corrects existing SalesReturn/SalesReturnItem records
 * that were refunded using the pre-fix logic (the original, pre-discount
 * unitPrice) instead of the order item's discount-allocated netUnitPrice.
 *
 * For every sales return, recomputes each item's refund from its order
 * item's netUnitPrice (populated by the order_item_discount_allocation
 * migration), corrects the return's totalAmount, restores the difference to
 * the dealer's outstandingBalance (the old refund always overpaid credit
 * back to the dealer when the order had any discount), and recomputes the
 * invoice's paymentStatus to match.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-return-refunds.ts            (dry run, no writes)
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-return-refunds.ts --commit    (writes for real)
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  computeEffectivePaid,
  derivePaymentStatus,
} from '../../src/common/utils/invoice-financials';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');
const TRANSACTION_OPTIONS = { maxWait: 10000, timeout: 20000 };
const ADMIN_EMAIL = 'electromarttrade@gmail.com';

async function main() {
  const admin = await prisma.admin.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin) throw new Error(`Admin ${ADMIN_EMAIL} not found`);

  const salesReturns = await prisma.salesReturn.findMany({
    include: {
      items: true,
      order: {
        include: {
          items: true,
          invoice: { include: { payments: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${salesReturns.length} sales return(s) to check.\n`);

  let correctedCount = 0;
  const dealerDeltas = new Map<string, Prisma.Decimal>();
  const invoiceIdsToRecompute = new Set<string>();

  for (const salesReturn of salesReturns) {
    const orderItemByProduct = new Map(
      salesReturn.order.items.map((oi) => [oi.productId, oi]),
    );

    let newTotalAmount = new Prisma.Decimal(0);
    const itemCorrections: {
      id: string;
      productId: string;
      oldLineTotal: Prisma.Decimal;
      newLineTotal: Prisma.Decimal;
      newAllocatedDiscount: Prisma.Decimal;
    }[] = [];

    for (const item of salesReturn.items) {
      const orderItem = orderItemByProduct.get(item.productId);
      if (!orderItem) {
        console.warn(
          `  ! Return ${salesReturn.returnNumber}: product ${item.productId} not found on order ${salesReturn.order.orderNumber}, skipping item`,
        );
        newTotalAmount = newTotalAmount.add(item.lineTotal);
        continue;
      }

      const perUnitDiscount = orderItem.unitPrice.sub(orderItem.netUnitPrice);
      const newAllocatedDiscount = perUnitDiscount.mul(item.quantity);
      const newLineTotal = orderItem.netUnitPrice.mul(item.quantity);
      newTotalAmount = newTotalAmount.add(newLineTotal);

      if (!newLineTotal.equals(item.lineTotal)) {
        itemCorrections.push({
          id: item.id,
          productId: item.productId,
          oldLineTotal: item.lineTotal,
          newLineTotal,
          newAllocatedDiscount,
        });
      }
    }

    if (itemCorrections.length === 0) continue;

    correctedCount++;
    const oldTotalAmount = salesReturn.totalAmount;
    const delta = oldTotalAmount.sub(newTotalAmount); // old refund minus new (smaller) refund

    console.log(
      `Return ${salesReturn.returnNumber} (order ${salesReturn.order.orderNumber}): ` +
        `${oldTotalAmount.toString()} -> ${newTotalAmount.toString()} (dealer credited back ${delta.toString()})`,
    );
    for (const c of itemCorrections) {
      console.log(
        `    product ${c.productId}: ${c.oldLineTotal.toString()} -> ${c.newLineTotal.toString()}`,
      );
    }

    const existingDelta = dealerDeltas.get(salesReturn.dealerId) ?? new Prisma.Decimal(0);
    dealerDeltas.set(salesReturn.dealerId, existingDelta.add(delta));
    if (salesReturn.order.invoice) {
      invoiceIdsToRecompute.add(salesReturn.order.invoice.id);
    }

    if (COMMIT) {
      await prisma.$transaction(async (tx) => {
        for (const c of itemCorrections) {
          await tx.salesReturnItem.update({
            where: { id: c.id },
            data: {
              lineTotal: c.newLineTotal,
              allocatedDiscount: c.newAllocatedDiscount,
            },
          });
        }
        await tx.salesReturn.update({
          where: { id: salesReturn.id },
          data: { totalAmount: newTotalAmount },
        });
      }, TRANSACTION_OPTIONS);
    }
  }

  console.log(`\n${correctedCount} return(s) needed correction.\n`);

  for (const [dealerId, delta] of dealerDeltas) {
    if (delta.isZero()) continue;
    const dealer = await prisma.dealer.findUniqueOrThrow({ where: { id: dealerId } });
    console.log(
      `Dealer ${dealer.businessName}: outstandingBalance ${dealer.outstandingBalance.toString()} -> ${dealer.outstandingBalance.add(delta).toString()}`,
    );
    if (COMMIT) {
      await prisma.$transaction(async (tx) => {
        await tx.dealer.update({
          where: { id: dealerId },
          data: { outstandingBalance: { increment: delta } },
        });
        await tx.activityLog.create({
          data: {
            adminId: admin.id,
            action: 'BACKFILL_CORRECTED_RETURN_REFUND',
            targetId: dealerId,
            details: `Corrected discount-allocation bug: restored ${delta.toString()} to ${dealer.businessName}'s outstanding balance across their affected sales returns`,
          },
        });
      }, TRANSACTION_OPTIONS);
    }
  }

  for (const invoiceId of invoiceIdsToRecompute) {
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });
    const returnedAmount = await prisma.salesReturn.aggregate({
      where: { orderId: invoice.orderId },
      _sum: { totalAmount: true },
    });
    const netGrandTotal = invoice.grandTotal.sub(
      returnedAmount._sum.totalAmount ?? new Prisma.Decimal(0),
    );
    const effectivePaid = computeEffectivePaid(invoice.payments);
    const newStatus = derivePaymentStatus(effectivePaid, netGrandTotal);
    if (newStatus !== invoice.paymentStatus) {
      console.log(
        `Invoice ${invoice.invoiceNumber}: paymentStatus ${invoice.paymentStatus} -> ${newStatus}`,
      );
      if (COMMIT) {
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { paymentStatus: newStatus },
        });
      }
    }
  }

  console.log(COMMIT ? '\nDone — changes committed.' : '\nDry run only — pass --commit to apply.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
