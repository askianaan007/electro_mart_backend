import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RepReportsService } from './rep-reports.service';
import { QueryReportDto } from './dto/query-report.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

// version2_changes_backend.md §17.5 — 100% read-only, Admin-only.
@ApiTags('Reports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('reports')
export class RepReportsController {
  constructor(private repReportsService: RepReportsService) {}

  @Get('representative-performance')
  @ApiOperation({ summary: 'Revenue/order count per representative' })
  representativePerformance(@Query() query: QueryReportDto) {
    return this.repReportsService.representativePerformance(query);
  }

  @Get('collection-performance')
  @ApiOperation({
    summary:
      'Confirmed vs. rejected vs. pending collections per representative',
  })
  collectionPerformance(@Query() query: QueryReportDto) {
    return this.repReportsService.collectionPerformance(query);
  }

  @Get('outstanding-by-representative')
  @ApiOperation({
    summary:
      "Customers' outstanding balances, grouped by the representative who onboarded them",
  })
  outstandingByRepresentative() {
    return this.repReportsService.outstandingByRepresentative();
  }

  @Get('commission-summary')
  @ApiOperation({
    summary: 'Commission ledger totals per representative, by status',
  })
  commissionSummary(@Query() query: QueryReportDto) {
    return this.repReportsService.commissionSummary(query);
  }

  @Get('settlement-summary')
  @ApiOperation({ summary: 'Settlement totals grouped by status' })
  settlementSummary(@Query() query: QueryReportDto) {
    return this.repReportsService.settlementSummary(query);
  }

  @Get('overdue-collections')
  @ApiOperation({
    summary: 'Orders with an overdue, uncollected invoice balance',
  })
  overdueCollections() {
    return this.repReportsService.overdueCollections();
  }

  @Get('returned-cheques')
  @ApiOperation({
    summary:
      'Bounced cheques, joined to the representative whose customer issued them',
  })
  returnedCheques(@Query() query: QueryReportDto) {
    return this.repReportsService.returnedCheques(query);
  }

  @Get('sales/product')
  @ApiOperation({ summary: 'Sales aggregated by product' })
  salesByProduct(@Query() query: QueryReportDto) {
    return this.repReportsService.salesByProduct(query);
  }

  @Get('sales/category')
  @ApiOperation({ summary: 'Sales aggregated by category' })
  salesByCategory(@Query() query: QueryReportDto) {
    return this.repReportsService.salesByCategory(query);
  }

  @Get('sales/representative')
  @ApiOperation({ summary: 'Sales aggregated by representative' })
  salesByRepresentative(@Query() query: QueryReportDto) {
    return this.repReportsService.salesByRepresentative(query);
  }
}
