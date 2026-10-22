import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';
import {
  derivePaymentStatus,
  recomputeInvoicePaymentStatus,
} from '../common/utils/invoice-financials';
import {
  computeDealerWallet,
  lockDealerRow,
} from '../common/utils/dealer-wallet';

/**
 * The dealer wallet: money a dealer paid above their invoices (an
 * overpayment, or a return on a paid invoice), kept for their next purchase.
 * Using it records a DealerCreditUse against an invoice — it pays that
 * invoice but is not new money, so Liquid Cash and the dealer's outstanding
 * balance stay as they are (the overpayment already counted when received).
 */
@Injectable()
export class DealerWalletService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async getWallet(dealerId: string) {
    const dealer = await this.prisma.dealer.findUnique({
      where: { id: dealerId },
      select: { id: true, businessName: true },
    });
    if (!dealer) throw new NotFoundException('Dealer not found');
    const [wallet, uses] = await Promise.all([
      computeDealerWallet(this.prisma, dealerId),
      this.prisma.dealerCreditUse.findMany({
        where: { dealerId },
        include: { invoice: { select: { invoiceNumber: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      dealerId,
      balance: wallet.balance.toNumber(),
      available: wallet.available.toNumber(),
      pending: wallet.pending.toNumber(),
      used: wallet.used.toNumber(),
      refunded: wallet.refunded.toNumber(),
      standalone: wallet.standalone.toNumber(),
      sources: wallet.sources.map((s) => ({
        invoiceId: s.invoiceId,
        invoiceNumber: s.invoiceNumber,
        excess: s.excess.toNumber(),
        pending: s.pending.toNumber(),
      })),
      uses: uses.map((u) => ({
        id: u.id,
        invoiceId: u.invoiceId,
        invoiceNumber: u.invoice.invoiceNumber,
        amount: u.amount.toNumber(),
        note: u.note,
        createdAt: u.createdAt,
      })),
    };
  }

  async useCredit(
    invoiceId: string,
    amount: number,
    adminId: string,
    note?: string,
  ) {
    return this.prisma.$transaction(
      (tx) => this.useCreditInTransaction(tx, invoiceId, amount, adminId, note),
      TRANSACTION_OPTIONS,
    );
  }

  /** Also used by order creation, so the order and its credit commit together. */
  async useCreditInTransaction(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    rawAmount: number,
    adminId: string,
    note?: string,
    /** Order creation: use at most what the new invoice comes to (the form's estimate may differ by rounding). */
    upToDue = false,
  ) {
    let amount = new Prisma.Decimal(rawAmount);
    if (!amount.greaterThan(0)) {
      throw new BadRequestException('Enter an amount above zero');
    }
    // Invoice first, then dealer — the same lock order as payments.
    const [invoice] = await tx.$queryRaw<
      { id: string; dealerId: string; invoiceNumber: string }[]
    >`SELECT id, "dealerId", "invoiceNumber" FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
    if (!invoice) throw new NotFoundException('Invoice not found');
    await lockDealerRow(tx, invoice.dealerId);

    const wallet = await computeDealerWallet(tx, invoice.dealerId);
    const figures = wallet.invoices.get(invoiceId);
    if (!figures) throw new NotFoundException('Invoice not found');
    const due = figures.net.sub(figures.paid);
    if (upToDue && amount.greaterThan(due) && due.greaterThan(0)) {
      amount = due;
    }

    if (amount.greaterThan(wallet.available)) {
      throw new BadRequestException(
        wallet.pending.greaterThan(0) &&
          amount.lessThanOrEqualTo(wallet.balance)
          ? `Only ${wallet.available.toFixed(2)} of the wallet can be used now — ${wallet.pending.toFixed(2)} is waiting for a cheque to clear`
          : `The dealer's wallet has ${wallet.available.toFixed(2)} available`,
      );
    }

    if (amount.greaterThan(due)) {
      throw new BadRequestException(
        due.greaterThan(0)
          ? `Only ${due.toFixed(2)} is due on invoice ${invoice.invoiceNumber}`
          : `Invoice ${invoice.invoiceNumber} is already fully paid`,
      );
    }

    const use = await tx.dealerCreditUse.create({
      data: {
        dealerId: invoice.dealerId,
        invoiceId,
        amount,
        note: note?.trim() || null,
        adminId,
      },
    });
    // Same rule as recomputeInvoicePaymentStatus(), from figures already read.
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus: derivePaymentStatus(
          figures.paid.add(amount),
          figures.net,
        ),
      },
    });

    await this.activityLogService.log(tx, {
      adminId,
      action: 'USED_WALLET_CREDIT',
      targetId: use.id,
      details: `Used ${amount.toString()} of wallet credit on invoice ${invoice.invoiceNumber} (${wallet.available.sub(amount).toString()} left)`,
    });
    return use;
  }

  /** Puts the credit back in the wallet; the invoice owes that amount again. */
  async removeUse(id: string, adminId: string) {
    const existing = await this.prisma.dealerCreditUse.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Wallet credit not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${existing.invoiceId} FOR UPDATE`;
      await lockDealerRow(tx, existing.dealerId);
      const use = await tx.dealerCreditUse.findUnique({
        where: { id },
        include: { invoice: { select: { invoiceNumber: true } } },
      });
      if (!use) throw new NotFoundException('Wallet credit not found');

      await tx.dealerCreditUse.delete({ where: { id } });
      await recomputeInvoicePaymentStatus(tx, use.invoiceId);

      await this.activityLogService.log(tx, {
        adminId,
        action: 'REMOVED_WALLET_CREDIT',
        targetId: id,
        details: `Removed ${use.amount.toString()} of wallet credit from invoice ${use.invoice.invoiceNumber} — back in the wallet`,
      });
      return { message: 'Wallet credit removed' };
    }, TRANSACTION_OPTIONS);
  }
}
