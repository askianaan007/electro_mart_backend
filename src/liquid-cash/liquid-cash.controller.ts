import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { LiquidCashService } from './liquid-cash.service';
import { QueryLiquidCashHistoryDto } from './dto/query-liquid-cash-history.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Liquid Cash')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('liquid-cash')
export class LiquidCashController {
  constructor(private liquidCashService: LiquidCashService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Current Liquid Cash balance and its breakdown (investments, dealer collections, supplier payments, expenses, pending cheques)',
  })
  getSummary() {
    return this.liquidCashService.getSummary();
  }

  @Get('history')
  @ApiOperation({
    summary:
      'Every investment, dealer payment, supplier payment, and expense affecting Liquid Cash, merged into one running-balance ledger and paginated',
  })
  getHistory(@Query() query: QueryLiquidCashHistoryDto) {
    return this.liquidCashService.getHistory(query);
  }
}
