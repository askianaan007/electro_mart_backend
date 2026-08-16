import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RepEarningsService } from './rep-earnings.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// version2_changes_backend.md §10.6 — always implicitly scoped to the
// caller's own representativeId (JWT `sub`); no route here takes an `:id`.
@ApiTags('Rep Portal — Earnings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal/earnings')
export class RepEarningsController {
  constructor(private repEarningsService: RepEarningsService) {}

  @Get('summary')
  @ApiOperation({ summary: "The caller's own earnings summary" })
  getSummary(@CurrentUser('sub') repId: string) {
    return this.repEarningsService.getSummary(repId);
  }

  @Get('ledger')
  @ApiOperation({
    summary: "The caller's own commission ledger (per order/product)",
  })
  getLedger(
    @CurrentUser('sub') repId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.repEarningsService.getLedger(repId, query);
  }

  @Get('settlements')
  @ApiOperation({ summary: "The caller's own settlement history" })
  getSettlements(
    @CurrentUser('sub') repId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.repEarningsService.getSettlementHistory(repId, query);
  }

  @Get('statement')
  @ApiOperation({
    summary: "CSV export of the caller's own commission ledger for a period",
  })
  async getStatement(
    @CurrentUser('sub') repId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.repEarningsService.getStatementCsv(repId, from, to);
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="commission-statement-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return csv;
  }
}
