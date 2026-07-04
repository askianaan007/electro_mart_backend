import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryInvoiceDto } from './dto/query-invoice.dto';
import { paginate } from '../common/utils/paginate';

@Injectable()
export class InvoicesService {
  private readonly invoiceInclude = {
    order: { include: { items: { include: { product: true } } } },
    dealer: { omit: { password: true } },
    payments: true,
  } satisfies Prisma.InvoiceInclude;

  constructor(private prisma: PrismaService) {}

  async findAllForAdmin(query: QueryInvoiceDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvoiceWhereInput = {
      paymentStatus: query.paymentStatus,
      dealerId: query.dealerId,
      ...(query.search && {
        invoiceNumber: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: this.invoiceInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findAllForDealer(dealerId: string, query: QueryInvoiceDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.InvoiceWhereInput = {
      dealerId,
      paymentStatus: query.paymentStatus,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: this.invoiceInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return paginate(data, total, page, limit);
  }

  async findOne(
    id: string,
    requester: { role: 'ADMIN' | 'DEALER'; id: string },
  ) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: this.invoiceInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (requester.role === 'DEALER' && invoice.dealerId !== requester.id) {
      throw new ForbiddenException('You do not have access to this invoice');
    }
    return invoice;
  }
}
