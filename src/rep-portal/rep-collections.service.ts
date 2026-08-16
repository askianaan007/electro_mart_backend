import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CollectionStatus,
  DealerSource,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RepActivityLogService } from '../rep-activity-log/rep-activity-log.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { QueryCollectionDto } from './dto/query-collection.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

const ZERO = new Prisma.Decimal(0);

/**
 * Rep-facing Collections (version2_changes_backend.md §14.4) — a pure
 * staging insert. No call to PaymentsService anywhere in this file; only
 * CollectionsService.confirm() (src/collections/, admin-facing) may ever
 * turn a submission into a real Payment.
 */
@Injectable()
export class RepCollectionsService {
  constructor(
    private prisma: PrismaService,
    private repActivityLogService: RepActivityLogService,
  ) {}

  private async assertCustomer(customerId: string) {
    const customer = await this.prisma.dealer.findFirst({
      where: { id: customerId, source: DealerSource.REP_PORTAL },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async submit(dto: CreateCollectionDto, repId: string) {
    const customer = await this.assertCustomer(dto.customerId);
    if (
      dto.mode === 'CHEQUE' &&
      (!dto.chequeNumber || !dto.bankName || !dto.chequeDate)
    ) {
      throw new BadRequestException(
        'chequeNumber, bankName, and chequeDate are required when mode is CHEQUE',
      );
    }
    if (dto.invoiceId) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: dto.invoiceId },
      });
      if (!invoice || invoice.dealerId !== dto.customerId) {
        throw new BadRequestException(
          'invoiceId does not belong to this customer',
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.collectionSubmission.create({
        data: {
          representativeId: repId,
          customerId: dto.customerId,
          invoiceId: dto.invoiceId,
          amount: dto.amount,
          mode: dto.mode,
          chequeNumber: dto.chequeNumber,
          bankName: dto.bankName,
          chequeDate: dto.chequeDate ? new Date(dto.chequeDate) : undefined,
          collectionDate: new Date(dto.collectionDate),
          notes: dto.notes,
          chequeImageUrl: dto.chequeImageUrl,
          status: CollectionStatus.PENDING_VERIFICATION,
        },
      });

      await this.repActivityLogService.log(tx, {
        representativeId: repId,
        action: 'COLLECTION_SUBMITTED',
        targetId: submission.id,
        details: `Submitted a collection of ${dto.amount} from ${customer.businessName}`,
      });

      return submission;
    }, TRANSACTION_OPTIONS);
  }

  async list(repId: string, query: QueryCollectionDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CollectionSubmissionWhereInput = {
      representativeId: repId,
      status: query.status,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.collectionSubmission.findMany({
        where,
        include: { customer: { select: { id: true, businessName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.collectionSubmission.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  /** §14.5 — outstanding/invoices/pending cheques/history for one customer, as seen by any representative. */
  async getCustomerCollectionsSummary(customerId: string) {
    const customer = await this.assertCustomer(customerId);

    const [invoices, pendingChequePayments, lastPayment, history] =
      await Promise.all([
        this.prisma.invoice.findMany({
          where: { dealerId: customerId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.payment.findMany({
          where: {
            invoice: { dealerId: customerId },
            mode: 'CHEQUE',
            chequeStatus: 'PENDING',
          },
          orderBy: { chequeDate: 'asc' },
        }),
        this.prisma.payment.findFirst({
          where: { invoice: { dealerId: customerId } },
          orderBy: { paymentDate: 'desc' },
        }),
        this.prisma.collectionSubmission.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    const now = new Date();
    const overdueAmount = invoices
      .filter(
        (inv) =>
          (inv.paymentStatus === PaymentStatus.PENDING ||
            inv.paymentStatus === PaymentStatus.PARTIAL) &&
          inv.dueDate !== null &&
          inv.dueDate < now,
      )
      .reduce((sum, inv) => sum.add(inv.grandTotal), ZERO);

    return {
      customerId,
      customerName: customer.businessName,
      outstandingBalance: customer.outstandingBalance,
      creditLimit: customer.creditLimit,
      unlimitedCredit: customer.unlimitedCredit,
      overdueAmount,
      invoices,
      pendingCheques: pendingChequePayments,
      lastPayment: lastPayment ?? null,
      collectionHistory: history,
    };
  }
}
