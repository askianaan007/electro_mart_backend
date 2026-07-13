import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryInvoiceDto } from './dto/query-invoice.dto';
import { paginate } from '../common/utils/paginate';

@Injectable()
export class InvoicesService {
  private readonly invoiceListInclude = {
    dealer: { omit: { password: true } },
    payments: true,
  } satisfies Prisma.InvoiceInclude;

  private readonly invoiceDetailInclude = {
    order: { include: { items: { include: { product: true } } } },
    dealer: { omit: { password: true } },
    payments: true,
  } satisfies Prisma.InvoiceInclude;

  constructor(private prisma: PrismaService) {}

  /**
   * OVERDUE isn't a stored value — an invoice is overdue whenever it's still
   * PENDING/PARTIAL past its dueDate. Computed here rather than via a cron so
   * it's always accurate and there's no window where a passed-due invoice
   * still reads as PENDING.
   */
  private withComputedStatus<T extends { paymentStatus: PaymentStatus; dueDate: Date | null }>(
    invoice: T,
  ): T {
    const isPastDue =
      (invoice.paymentStatus === PaymentStatus.PENDING ||
        invoice.paymentStatus === PaymentStatus.PARTIAL) &&
      invoice.dueDate !== null &&
      invoice.dueDate < new Date();
    return isPastDue ? { ...invoice, paymentStatus: PaymentStatus.OVERDUE } : invoice;
  }

  private buildPaymentStatusWhere(
    paymentStatus?: PaymentStatus,
  ): Prisma.InvoiceWhereInput {
    if (!paymentStatus) return {};
    const now = new Date();
    if (paymentStatus === PaymentStatus.OVERDUE) {
      return {
        paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
        dueDate: { lt: now },
      };
    }
    if (
      paymentStatus === PaymentStatus.PENDING ||
      paymentStatus === PaymentStatus.PARTIAL
    ) {
      return {
        paymentStatus,
        OR: [{ dueDate: null }, { dueDate: { gte: now } }],
      };
    }
    return { paymentStatus };
  }

  async findAllForAdmin(query: QueryInvoiceDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvoiceWhereInput = {
      ...this.buildPaymentStatusWhere(query.paymentStatus),
      dealerId: query.dealerId,
      ...((query.dateFrom || query.dateTo) && {
        createdAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
      ...(query.search && {
        invoiceNumber: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: this.invoiceListInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return paginate(data.map((i) => this.withComputedStatus(i)), total, page, limit);
  }

  async findAllForDealer(dealerId: string, query: QueryInvoiceDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvoiceWhereInput = {
      dealerId,
      ...this.buildPaymentStatusWhere(query.paymentStatus),
      ...((query.dateFrom || query.dateTo) && {
        createdAt: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: this.invoiceListInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return paginate(data.map((i) => this.withComputedStatus(i)), total, page, limit);
  }

  async findOne(
    id: string,
    requester: { role: 'ADMIN' | 'DEALER'; id: string },
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: this.invoiceDetailInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (requester.role === 'DEALER' && invoice.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this invoice');
    }
    return this.withComputedStatus(invoice);
  }
}
