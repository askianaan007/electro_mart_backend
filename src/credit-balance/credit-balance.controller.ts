import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CreditBalanceService } from './credit-balance.service';
import { QueryCreditBalanceHistoryDto } from './dto/query-credit-balance-history.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Credit Balance')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('credit-balance')
export class CreditBalanceController {
  constructor(private creditBalanceService: CreditBalanceService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Current company-wide Credit Balance and its breakdown (purchases, transport charges, returns, settlements, pending cheque settlements)',
  })
  getSummary() {
    return this.creditBalanceService.getSummary();
  }

  @Get('history')
  @ApiOperation({
    summary:
      'Every purchase, transport charge, purchase return, and settlement affecting the Credit Balance, merged into one running-balance ledger and paginated',
  })
  getHistory(@Query() query: QueryCreditBalanceHistoryDto) {
    return this.creditBalanceService.getHistory(query);
  }
}
