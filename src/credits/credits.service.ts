import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChequeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { QueryCreditsDto } from './dto/query-credits.dto';
import { paginate } from '../common/utils/paginate';

const ZERO = new Prisma.Decimal(0);

// A cheque that has bounced no longer counts as money paid to the supplier —
// everything else (cash, bank transfer, pending or cleared cheques) does.
const EFFECTIVE_PAYMENT_FILTER: Prisma.SupplierPaymentWhereInput = {
  NOT: { mode: 'CHEQUE', chequeStatus: 'RETURNED' },
};

@Injectable()
export class CreditsService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  private async computeCreditBalance(supplierId: string) {
    const [purchaseAgg, returnAgg, paymentAgg] = await Promise.all([
      this.prisma.purchase.aggregate({
        where: { supplierId },
        _sum: { totalValue: true },
      }),
      this.prisma.purchaseReturn.aggregate({
        where: { supplierId },
        _sum: { totalAmount: true },
      }),
      this.prisma.supplierPayment.aggregate({
        where: { supplierId, ...EFFECTIVE_PAYMENT_FILTER },
        _sum: { amount: true },
      }),
    ]);

    const totalPurchases = purchaseAgg._sum.totalValue ?? ZERO;
    const totalReturns = returnAgg._sum.totalAmount ?? ZERO;
    const totalSettled = paymentAgg._sum.amount ?? ZERO;
    const creditBalance = totalPurchases.sub(totalReturns).sub(totalSettled);

    return { totalPurchases, totalReturns, totalSettled, creditBalance };
  }

  async getSummary(query: QueryCreditsDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const suppliers = await this.prisma.supplier.findMany({
      where: query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {},
      orderBy: { name: 'asc' },
    });
    const supplierIds = suppliers.map((s) => s.id);

    const [purchaseTotals, returnTotals, paymentTotals] = await Promise.all([
      this.prisma.purchase.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { totalValue: true },
      }),
      this.prisma.purchaseReturn.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds } },
        _sum: { totalAmount: true },
      }),
      this.prisma.supplierPayment.groupBy({
        by: ['supplierId'],
        where: { supplierId: { in: supplierIds }, ...EFFECTIVE_PAYMENT_FILTER },
        _sum: { amount: true },
      }),
    ]);

    const purchaseMap = new Map(
      purchaseTotals.map((r) => [r.supplierId, r._sum.totalValue ?? ZERO]),
    );
    const returnMap = new Map(
      returnTotals.map((r) => [r.supplierId, r._sum.totalAmount ?? ZERO]),
    );
    const paymentMap = new Map(
      paymentTotals.map((r) => [r.supplierId, r._sum.amount ?? ZERO]),
    );

    let entries = suppliers.map((supplier) => {
      const totalPurchases = purchaseMap.get(supplier.id) ?? ZERO;
      const totalReturns = returnMap.get(supplier.id) ?? ZERO;
      const totalSettled = paymentMap.get(supplier.id) ?? ZERO;
      const creditBalance = totalPurchases.sub(totalReturns).sub(totalSettled);
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        totalPurchases,
        totalReturns,
        totalSettled,
        creditBalance,
      };
    });

    if (query.onlyOutstanding === 'true') {
      entries = entries.filter((e) => e.creditBalance.greaterThan(ZERO));
    }

    const totals = entries.reduce(
      (acc, e) => ({
        totalPurchases: acc.totalPurchases.add(e.totalPurchases),
        totalReturns: acc.totalReturns.add(e.totalReturns),
        totalSettled: acc.totalSettled.add(e.totalSettled),
        totalCreditBalance: acc.totalCreditBalance.add(e.creditBalance),
      }),
      {
        totalPurchases: ZERO,
        totalReturns: ZERO,
        totalSettled: ZERO,
        totalCreditBalance: ZERO,
      },
    );

    const start = (page - 1) * limit;
    const { data, meta } = paginate(
      entries.slice(start, start + limit),
      entries.length,
      page,
      limit,
    );

    return { entries: data, meta, totals };
  }

  async getSupplierDetail(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const [balances, purchases, purchaseReturns, payments] = await Promise.all([
      this.computeCreditBalance(supplierId),
      this.prisma.purchase.findMany({
        where: { supplierId },
        include: { items: true },
        orderBy: { purchaseDate: 'desc' },
      }),
      this.prisma.purchaseReturn.findMany({
        where: { supplierId },
        orderBy: { returnDate: 'desc' },
      }),
      this.prisma.supplierPayment.findMany({
        where: { supplierId },
        orderBy: { paymentDate: 'desc' },
      }),
    ]);

    return {
      supplier,
      ...balances,
      purchases,
      purchaseReturns,
      payments,
    };
  }

  async createSettlement(
    supplierId: string,
    dto: CreateSettlementDto,
    adminId: string,
  ) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    if (dto.mode === 'CHEQUE' && !dto.chequeDepositDate) {
      throw new BadRequestException(
        'Cheque deposit date is required for cheque settlements',
      );
    }

    const { creditBalance } = await this.computeCreditBalance(supplierId);
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.greaterThan(creditBalance)) {
      throw new BadRequestException(
        'Settlement amount exceeds the outstanding credit balance',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.create({
        data: {
          supplierId,
          amount,
          mode: dto.mode,
          reference: dto.reference,
          paymentDate: new Date(dto.paymentDate),
          chequeStatus:
            dto.mode === 'CHEQUE' ? ChequeStatus.PENDING : undefined,
          chequeDepositDate:
            dto.mode === 'CHEQUE' && dto.chequeDepositDate
              ? new Date(dto.chequeDepositDate)
              : undefined,
          remarks: dto.remarks,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'RECORDED_SUPPLIER_SETTLEMENT',
        targetId: payment.id,
        details: `${dto.mode} settlement of ${amount.toString()} to ${supplier.name}`,
      });

      return payment;
    });
  }

  async updateChequeStatus(
    paymentId: string,
    status: 'CLEARED' | 'RETURNED',
    adminId: string,
  ) {
    const payment = await this.prisma.supplierPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Settlement not found');
    if (payment.mode !== 'CHEQUE') {
      throw new BadRequestException(
        'Only cheque settlements have a cheque status',
      );
    }
    if (payment.chequeStatus !== ChequeStatus.PENDING) {
      throw new BadRequestException(
        `This cheque is already marked ${payment.chequeStatus}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.supplierPayment.update({
        where: { id: paymentId },
        data: { chequeStatus: status },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_CHEQUE_STATUS',
        targetId: paymentId,
        details: `Cheque ${payment.reference ?? paymentId} marked ${status}`,
      });

      return updated;
    });
  }
}
