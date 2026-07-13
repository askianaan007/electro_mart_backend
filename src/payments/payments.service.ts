import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { paginate } from '../common/utils/paginate';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  async create(dto: CreatePaymentDto, adminId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: dto.invoiceId },
      include: { payments: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const amount = new Prisma.Decimal(dto.amount);
    const alreadyPaid = invoice.payments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0),
    );
    if (alreadyPaid.add(amount).greaterThan(invoice.grandTotal)) {
      throw new BadRequestException(
        'Payment amount exceeds the outstanding invoice balance',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          invoiceId: dto.invoiceId,
          dealerId: invoice.dealerId,
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
        },
      });

      const totalPaid = alreadyPaid.add(amount);
      const paymentStatus = totalPaid.greaterThanOrEqualTo(invoice.grandTotal)
        ? PaymentStatus.PAID
        : totalPaid.greaterThan(0)
          ? PaymentStatus.PARTIAL
          : PaymentStatus.PENDING;

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paymentStatus },
      });

      const dealer = await tx.dealer.findUniqueOrThrow({
        where: { id: invoice.dealerId },
      });
      const newOutstanding = Prisma.Decimal.max(
        0,
        dealer.outstandingBalance.sub(amount),
      );
      await tx.dealer.update({
        where: { id: invoice.dealerId },
        data: { outstandingBalance: newOutstanding },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_PAYMENT',
        targetId: payment.id,
        details: `Payment of ${amount.toString()} against invoice ${invoice.invoiceNumber}`,
      });

      return payment;
    }, TRANSACTION_OPTIONS);
  }

  async findAllForAdmin(query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = {
      mode: query.mode,
      dealerId: query.dealerId,
      ...((query.dateFrom || query.dateTo) && {
        paymentDate: {
          ...(query.dateFrom && { gte: new Date(query.dateFrom) }),
          ...(query.dateTo && { lt: new Date(query.dateTo) }),
        },
      }),
      ...(query.search && {
        reference: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: { invoice: true, dealer: { omit: { password: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForDealer(dealerId: string, query: QueryPaymentDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = { dealerId, mode: query.mode };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        include: { invoice: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(
    id: string,
    requester: { role: 'ADMIN' | 'DEALER'; id: string },
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { invoice: true, dealer: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (requester.role === 'DEALER' && payment.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this payment');
    }
    return payment;
  }
}
