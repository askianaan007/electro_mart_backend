import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';

const DEFAULT_GRACE_DAYS = 7;
const HIGH_PRIORITY_THRESHOLD_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * version2_changes_backend.md §16 — a background job, independent of
 * CreditsService's existing daily cron. Reads only Order/Invoice's existing,
 * unmodified fields; writes only to the new CollectionReminderLog table.
 */
@Injectable()
export class CollectionRemindersService {
  private readonly logger = new Logger(CollectionRemindersService.name);

  constructor(
    private prisma: PrismaService,
    private mailer: MailerService,
    private config: ConfigService,
  ) {}

  private getGraceDays(): number {
    const configured = Number(
      this.config.get<string>('COLLECTION_REMINDER_GRACE_DAYS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_GRACE_DAYS;
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendReminders() {
    const graceDays = this.getGraceDays();
    const graceDeadline = new Date(Date.now() - graceDays * DAY_MS);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const candidates = await this.prisma.order.findMany({
      where: {
        createdByRepId: { not: null },
        status: {
          in: [
            OrderStatus.APPROVED,
            OrderStatus.PACKED,
            OrderStatus.DELIVERED,
            OrderStatus.COMPLETED,
          ],
        },
        approvedAt: { lte: graceDeadline },
        invoice: {
          paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
        },
        collectionReminders: { none: { sentAt: { gte: startOfToday } } },
      },
      include: {
        invoice: true,
        dealer: { select: { businessName: true } },
        createdByRep: { select: { email: true } },
      },
    });

    let sent = 0;
    for (const order of candidates) {
      if (!order.invoice || !order.createdByRep || !order.approvedAt) continue;

      // Every candidate here already has an expired collection grace period
      // (the query condition above guarantees it), so daysRemaining is
      // always 0 for this reminder — "overdue" is measured from whichever
      // deadline has actually passed: the invoice's own dueDate if set and
      // past, otherwise the collection grace period itself.
      const now = new Date();
      const invoiceOverdue =
        order.invoice.dueDate !== null && order.invoice.dueDate < now;
      const graceOverdueDays = Math.floor(
        (now.getTime() - (order.approvedAt.getTime() + graceDays * DAY_MS)) /
          DAY_MS,
      );
      const overdueDays = invoiceOverdue
        ? Math.floor(
            (now.getTime() - order.invoice.dueDate!.getTime()) / DAY_MS,
          )
        : Math.max(graceOverdueDays, 0);
      const priority: 'NORMAL' | 'HIGH' | 'OVERDUE' =
        invoiceOverdue || graceOverdueDays > HIGH_PRIORITY_THRESHOLD_DAYS
          ? 'OVERDUE'
          : 'HIGH';
      const daysRemaining = 0;

      try {
        await this.mailer.notifyRepCollectionReminder(
          order.createdByRep.email,
          {
            customerName: order.dealer.businessName,
            invoiceNumber: order.invoice.invoiceNumber,
            outstandingAmount: order.invoice.grandTotal.toString(),
            daysRemaining,
            overdueDays,
            priority,
          },
        );
        await this.prisma.collectionReminderLog.create({
          data: { orderId: order.id, daysOverdue: overdueDays },
        });
        sent += 1;
      } catch (error) {
        this.logger.error(
          `Failed to send collection reminder for order ${order.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    if (sent > 0) {
      this.logger.log(`Sent ${sent} collection reminder(s)`);
    }
    return { sent };
  }
}
