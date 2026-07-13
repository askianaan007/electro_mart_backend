import {
  Body,
  Controller,
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

  @Get(':supplierId')
  @ApiOperation({
    summary:
      'Credit balance and full purchase/return/settlement history for a supplier',
  })
  getSupplierDetail(@Param('supplierId') supplierId: string) {
    return this.creditsService.getSupplierDetail(supplierId);
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

  @Patch('settlements/:paymentId/status')
  @ApiOperation({
    summary:
      'Mark a pending cheque settlement as cleared or returned (bounced)',
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
