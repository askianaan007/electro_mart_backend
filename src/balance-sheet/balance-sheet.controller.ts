import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { BalanceSheetService } from './balance-sheet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Balance Sheet')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('balance-sheet')
export class BalanceSheetController {
  constructor(private balanceSheetService: BalanceSheetService) {}

  @Get()
  @ApiOperation({
    summary:
      'Live Assets/Liabilities/Equity snapshot composed from Liquid Cash, Credit Balance, and Equity, ' +
      'plus inventory valuation and AR — with an explicit reconciliation of any known timing/allocation ' +
      'differences and Commission Payable reported as a memorandum item (see balance_sheet.md)',
  })
  getSummary() {
    return this.balanceSheetService.getSummary();
  }
}
