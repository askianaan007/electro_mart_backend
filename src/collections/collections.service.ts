import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { MailerService } from '../mailer/mailer.service';
import { PaymentsService } from '../payments/payments.service';
import { ConfirmCollectionDto } from './dto/confirm-collection.dto';
import { RejectCollectionDto } from './dto/reject-collection.dto';
import { QueryCollectionAdminDto } from './dto/query-collection-admin.dto';
import { paginate } from '../common/utils/paginate';

/**
 * Admin-facing review queue (version2_changes_backend.md §14.4) — the
 * "safety-critical part". confirm() is the sole bridge into the existing,
 * completely unmodified PaymentsService.create(); reject() has zero
 * financial effect by construction.
 */
@Injectable()
export class CollectionsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
    private mailer: MailerService,
    private paymentsService: PaymentsService,
  ) {}

  private readonly detailInclude = {
    representative: { select: { id: true, name: true, email: true } },
    customer: { select: { id: true, businessName: true, ownerName: true } },
    invoice: {
      select: {
        id: true,
        invoiceNumber: true,
        grandTotal: true,
        paymentStatus: true,
      },
    },
  } satisfies Prisma.CollectionSubmissionInclude;

  async findAll(query: QueryCollectionAdminDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CollectionSubmissionWhereInput = {
      status: query.status,
      representativeId: query.representativeId,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.collectionSubmission.findMany({
        where,
        include: this.detailInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.collectionSubmission.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(id: string) {
    const submission = await this.prisma.collectionSubmission.findUnique({
      where: { id },
      include: this.detailInclude,
    });
    if (!submission)
      throw new NotFoundException('Collection submission not found');
    return submission;
  }

  async confirm(id: string, dto: ConfirmCollectionDto, adminId: string) {
    const submission = await this.findOne(id);
    if (submission.status !== CollectionStatus.PENDING_VERIFICATION) {
      throw new BadRequestException(
        'Only a pending collection can be confirmed',
      );
    }

    const invoiceId = dto.invoiceId ?? submission.invoiceId;
    if (!invoiceId) {
      throw new BadRequestException(
        'This collection was not submitted against a specific invoice — specify invoiceId to confirm it',
      );
    }

    // The exact existing, unmodified pipeline (row-locking, overpayment
    // guard, cheque validation, outstandingBalance decrement,
    // recomputeInvoicePaymentStatus) — zero lines of PaymentsService
    // changed to support this.
    const payment = await this.paymentsService.create(
      {
        invoiceId,
        amount: submission.amount.toNumber(),
        mode: submission.mode,
        paymentDate: new Date().toISOString(),
        bankName: submission.bankName ?? undefined,
        chequeNumber: submission.chequeNumber ?? undefined,
        chequeDate: submission.chequeDate
          ? submission.chequeDate.toISOString()
          : undefined,
        collectedDate: submission.collectionDate.toISOString(),
        remarks: `Collected by representative ${submission.representative.name}${submission.notes ? ` — ${submission.notes}` : ''}`,
      },
      adminId,
    );

    const updated = await this.prisma.collectionSubmission.update({
      where: { id },
      data: {
        status: CollectionStatus.CONFIRMED,
        invoiceId,
        resultingPaymentId: payment.id,
        verifiedByAdminId: adminId,
        verifiedAt: new Date(),
      },
      include: this.detailInclude,
    });

    await this.activityLogService.log(this.prisma, {
      adminId,
      action: 'CONFIRMED_COLLECTION',
      targetId: id,
      details: `Confirmed a collection of ${submission.amount.toString()} from ${submission.customer.businessName}, recorded as payment ${payment.id}`,
    });

    await this.mailer
      .notifyRepCollectionConfirmed(
        submission.representative.email,
        submission.customer.businessName,
        submission.amount.toString(),
      )
      .catch(() => undefined);

    return updated;
  }

  async reject(id: string, dto: RejectCollectionDto, adminId: string) {
    const submission = await this.findOne(id);
    if (submission.status !== CollectionStatus.PENDING_VERIFICATION) {
      throw new BadRequestException(
        'Only a pending collection can be rejected',
      );
    }

    const updated = await this.prisma.collectionSubmission.update({
      where: { id },
      data: {
        status: CollectionStatus.REJECTED,
        rejectedReason: dto.reason,
        verifiedByAdminId: adminId,
        verifiedAt: new Date(),
      },
      include: this.detailInclude,
    });

    await this.activityLogService.log(this.prisma, {
      adminId,
      action: 'REJECTED_COLLECTION',
      targetId: id,
      details: `Rejected a collection of ${submission.amount.toString()} from ${submission.customer.businessName}: ${dto.reason}`,
    });

    await this.mailer
      .notifyRepCollectionRejected(
        submission.representative.email,
        submission.customer.businessName,
        submission.amount.toString(),
        dto.reason,
      )
      .catch(() => undefined);

    return updated;
  }
}
