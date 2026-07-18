import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CreditsService } from './credits.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { UpdateChequeStatusDto } from './dto/update-cheque-status.dto';
import { QueryCreditsDto } from './dto/query-credits.dto';
import { QuerySettlementsDto } from './dto/query-settlements.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Supplier Credits')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('credits')
export class CreditsController {
  constructor(private creditsService: CreditsService) {}

  @Get()
  @ApiOperation({ summary: 'Per-supplier credit (payable) balances' })
  getSummary(@Query() query: QueryCreditsDto) {
    return this.creditsService.getSummary(query);
  }

  @Post('cheques/send-reminders')
  @ApiOperation({
    summary:
      "Manually trigger the cheque deposit reminder email for tomorrow's due cheques " +
      '(this also runs automatically once a day)',
  })
  sendChequeReminders() {
    return this.creditsService.sendChequeDepositReminders();
  }

  @Get(':supplierId')
  @ApiOperation({
    summary:
      'Credit balance and full purchase/return/settlement history for a supplier',
  })
  getSupplierDetail(@Param('supplierId') supplierId: string) {
    return this.creditsService.getSupplierDetail(supplierId);
  }

  @Get(':supplierId/settlements')
  @ApiOperation({
    summary: 'Paginated, filterable settlement history for a supplier',
  })
  getSettlements(
    @Param('supplierId') supplierId: string,
    @Query() query: QuerySettlementsDto,
  ) {
    return this.creditsService.getSettlements(supplierId, query);
  }

  @Post(':supplierId/settlements')
  @ApiOperation({
    summary:
      'Record a cash or cheque settlement against a supplier credit balance',
  })
  createSettlement(
    @Param('supplierId') supplierId: string,
    @Body() dto: CreateSettlementDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.creditsService.createSettlement(supplierId, dto, adminId);
  }

  @Delete('settlements/:paymentId')
  @ApiOperation({
    summary: 'Delete a settlement within 1 day of it being recorded',
  })
  deleteSettlement(
    @Param('paymentId') paymentId: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.creditsService.deleteSettlement(paymentId, adminId);
  }

  @Patch('settlements/:paymentId/status')
  @ApiOperation({
    summary:
      'Mark a pending cheque settlement as cleared or returned (bounced), ' +
      'or revert a cleared/returned cheque back to pending within 1 day of that change',
  })
  updateChequeStatus(
    @Param('paymentId') paymentId: string,
    @Body() dto: UpdateChequeStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.creditsService.updateChequeStatus(
      paymentId,
      dto.status,
      adminId,
    );
  }
}
