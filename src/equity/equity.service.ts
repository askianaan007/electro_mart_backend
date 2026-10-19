import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesAnalysisService } from '../sales-analysis/sales-analysis.service';
import { QueryEquityHistoryDto } from './dto/query-equity-history.dto';
import { paginate } from '../common/utils/paginate';
import { EFFECTIVE_INVESTMENT_FILTER } from '../common/utils/investment-filters';
import {
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../common/utils/business-date';
import { likeContains } from '../common/utils/like-pattern';
import { sqlUtc } from '../common/utils/sql-time';

export interface EquityHistoryRow {
  id: string;
  type: 'INVESTMENT' | 'WITHDRAWAL' | 'EXPENSE';
  date: Date;
  description: string;
  investorId: string | null;
  investorName: string | null;
  amount: Prisma.Decimal;
  createdAt: Date;
}

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
          where: EFFECTIVE_INVESTMENT_FILTER,
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

  /**
   * Every investment, withdrawal, and expense affecting equity, merged into
   * a single timeline and paginated at the SQL level (a UNION ALL CTE) so
   * filtering/pagination is correct across both source tables — no
   * fetch-everything-then-slice-in-JS, which breaks down once either table
   * grows past a page or two.
   */
  async getHistory(query: QueryEquityHistoryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [];
    if (query.type) {
      conditions.push(Prisma.sql`type = ${query.type}`);
    }
    if (query.investorId) {
      conditions.push(Prisma.sql`"investorId" = ${query.investorId}`);
    }
    if (query.dateFrom) {
      conditions.push(
        Prisma.sql`date >= ${sqlUtc(startOfBusinessDay(query.dateFrom))}`,
      );
    }
    if (query.dateTo) {
      conditions.push(
        Prisma.sql`date < ${sqlUtc(startOfNextBusinessDay(query.dateTo))}`,
      );
    }
    if (query.search) {
      const term = likeContains(query.search);
      conditions.push(
        Prisma.sql`(description ILIKE ${term} ESCAPE '\\' OR "investorName" ILIKE ${term} ESCAPE '\\')`,
      );
    }

    const whereClause =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
        : Prisma.empty;

    const combinedCte = Prisma.sql`
      WITH combined AS (
        SELECT
          i.id AS id,
          CASE WHEN i.amount < 0 THEN 'WITHDRAWAL' ELSE 'INVESTMENT' END AS type,
          i."investmentDate" AS date,
          i.reason AS description,
          inv.id AS "investorId",
          inv.name AS "investorName",
          i.amount AS amount,
          i."createdAt" AS "createdAt"
        FROM "Investment" i
        JOIN "Investor" inv ON inv.id = i."investorId"
        -- Same rule as EFFECTIVE_INVESTMENT_FILTER: an uncleared or bounced
        -- cheque isn't capital yet.
        WHERE i.mode <> 'CHEQUE' OR i."chequeStatus" IS NULL OR i."chequeStatus" = 'CLEARED'
        UNION ALL
        SELECT
          e.id AS id,
          'EXPENSE' AS type,
          e."expenseDate" AS date,
          e.description AS description,
          NULL AS "investorId",
          NULL AS "investorName",
          (e.amount * -1) AS amount,
          e."createdAt" AS "createdAt"
        FROM "Expense" e
      )
    `;

    const [data, countResult] = await Promise.all([
      this.prisma.$queryRaw<EquityHistoryRow[]>`
        ${combinedCte}
        SELECT * FROM combined
        ${whereClause}
        ORDER BY date DESC, "createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ count: bigint }[]>`
        ${combinedCte}
        SELECT COUNT(*) AS count FROM combined
        ${whereClause}
      `,
    ]);

    const total = Number(countResult[0]?.count ?? 0);
    return paginate(data, total, page, limit);
  }
}
