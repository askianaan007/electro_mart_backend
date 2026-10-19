import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Minimal rows for integration tests. Only ever called against the marked
 * test database (see test-app.ts) — these insert directly, bypassing the API,
 * purely to set up preconditions; behaviour under test goes through the API.
 */
export const hashPassword = (plain: string) => bcrypt.hash(plain, 4);

const uid = () => randomUUID().slice(0, 8);

export async function createDealer(prisma: PrismaService, name = 'Dealer') {
  const id = uid();
  return prisma.dealer.create({
    data: {
      businessName: `${name} ${id}`,
      ownerName: 'Owner',
      phone: '0770000000',
      username: `dealer_${id}`,
      password: 'x',
    },
  });
}

/** An invoice of `amount` for `dealerId`, with the dealer's outstanding balance raised to match. */
export async function createInvoice(
  prisma: PrismaService,
  dealerId: string,
  amount: number,
) {
  const id = uid();
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-${id}`,
      dealerId,
      subtotal: amount,
      totalAmount: amount,
      status: 'COMPLETED',
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-${id}`,
      orderId: order.id,
      dealerId,
      subtotal: amount,
      grandTotal: amount,
    },
  });
  await prisma.dealer.update({
    where: { id: dealerId },
    data: { outstandingBalance: { increment: amount } },
  });
  return { order, invoice };
}

export async function createSupplier(prisma: PrismaService, name = 'Supplier') {
  return prisma.supplier.create({ data: { name: `${name} ${uid()}` } });
}

export async function createPurchase(
  prisma: PrismaService,
  supplierId: string,
  adminId: string,
  totalValue: number,
  transportCharges = 0,
) {
  return prisma.purchase.create({
    data: {
      supplierId,
      adminId,
      invoiceNumber: `PI-${uid()}`,
      purchaseDate: new Date(),
      totalValue,
      transportCharges,
    },
  });
}

export async function createInvestor(prisma: PrismaService, share = 100) {
  return prisma.investor.create({
    data: { name: `Investor ${uid()}`, profitSharePercentage: share },
  });
}

export async function createRepresentative(prisma: PrismaService) {
  const id = uid();
  return prisma.representative.create({
    data: {
      name: `Rep ${id}`,
      phone: '0771111111',
      email: `rep_${id}@test.local`,
      username: `rep_${id}`,
      password: 'x',
    },
  });
}

/** PENDING commission lines for `repId`, created at `createdAt`. */
export async function createCommissionLines(
  prisma: PrismaService,
  repId: string,
  amounts: number[],
  createdAt = new Date(),
) {
  const dealer = await createDealer(prisma, 'RepShop');
  const product = await prisma.product.create({
    data: {
      productCode: `P-${uid()}`,
      name: 'Product',
      costPrice: 10,
      wholesalePrice: 20,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-${uid()}`,
      dealerId: dealer.id,
      subtotal: 100,
      totalAmount: 100,
      status: 'COMPLETED',
    },
  });
  return Promise.all(
    amounts.map((amount) =>
      prisma.commissionLedgerEntry.create({
        data: {
          representativeId: repId,
          orderId: order.id,
          orderItemId: randomUUID(),
          productId: product.id,
          amount: new Prisma.Decimal(amount),
          createdAt,
        },
      }),
    ),
  );
}

export const today = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export const daysAgo = (n: number) =>
  new Date(Date.now() + 330 * 60_000 - n * 86_400_000)
    .toISOString()
    .slice(0, 10);

export async function createProduct(prisma: PrismaService, stock = 0) {
  return prisma.product.create({
    data: {
      productCode: `P-${uid()}`,
      name: 'Product',
      costPrice: 10,
      wholesalePrice: 20,
      currentStock: stock,
    },
  });
}
