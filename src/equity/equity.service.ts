import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesAnalysisService } from '../sales-analysis/sales-analysis.service';

@Injectable()
export class EquityService {
  constructor(
    private prisma: PrismaService,
    private salesAnalysisService: SalesAnalysisService,
  ) {}

  async getSummary() {
    const [investors, investmentTotals, salesAnalysis, expenseAgg] =
      await Promise.all([
        this.prisma.investor.findMany({ orderBy: { name: 'asc' } }),
        this.prisma.investment.groupBy({
          by: ['investorId'],
          _sum: { amount: true },
        }),
        // Gross profit computed live from every completed sale — no manual
        // entry needed. Expenses are still deducted per investor below, so
        // this intentionally uses gross (not net-of-expenses) profit to
        // avoid double-subtracting expenses.
        this.salesAnalysisService.getSummary({}),
        this.prisma.expense.aggregate({ _sum: { amount: true } }),
      ]);

    const investorCount = investors.length;
    const totalProfit = new Prisma.Decimal(salesAnalysis.totalProfit);
    const totalExpenses = expenseAgg._sum.amount ?? new Prisma.Decimal(0);

    const investmentByInvestor = new Map(
      investmentTotals.map((row) => [
        row.investorId,
        row._sum.amount ?? new Prisma.Decimal(0),
      ]),
    );

    const entries = investors.map((investor) => {
      const totalInvestment =
        investmentByInvestor.get(investor.id) ?? new Prisma.Decimal(0);
      const share = investor.profitSharePercentage.dividedBy(100);
      const profitShare = totalProfit.mul(share);
      const expenseShare = totalExpenses.mul(share);
      const equity = totalInvestment.add(profitShare).sub(expenseShare);
      return {
        investorId: investor.id,
        investorName: investor.name,
        profitSharePercentage: investor.profitSharePercentage,
        totalInvestment,
        profitShare,
        expenseShare,
        equity,
      };
    });

    const totalInvestment = entries.reduce(
      (sum, entry) => sum.add(entry.totalInvestment),
      new Prisma.Decimal(0),
    );
    const totalEquity = entries.reduce(
      (sum, entry) => sum.add(entry.equity),
      new Prisma.Decimal(0),
    );
    const percentageTotal = investors.reduce(
      (sum, investor) => sum.add(investor.profitSharePercentage),
      new Prisma.Decimal(0),
    );

    return {
      investorCount,
      entries,
      totals: {
        totalInvestment,
        totalProfit,
        totalExpenses,
        totalEquity,
        percentageTotal,
      },
    };
  }
}
