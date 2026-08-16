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
import { SettlementsService } from './settlements.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { RejectSettlementDto } from './dto/reject-settlement.dto';
import { PaySettlementDto } from './dto/pay-settlement.dto';
import { QuerySettlementDto } from './dto/query-settlement.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// version2_changes_backend.md §11.5 — the commission-side mirror of the
// existing Payments/Credits admin workflow. Admin-only, entirely.
@ApiTags('Commission')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('commission')
export class CommissionController {
  constructor(private settlementsService: SettlementsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Commission dashboard KPIs' })
  dashboard() {
    return this.settlementsService.dashboard();
  }

  @Get('representatives/:id/summary')
  @ApiOperation({ summary: "A representative's commission summary" })
  representativeSummary(@Param('id') id: string) {
    return this.settlementsService.representativeSummary(id);
  }

  @Get('settlements')
  @ApiOperation({
    summary: 'List settlements (filterable by status/representative)',
  })
  findAll(@Query() query: QuerySettlementDto) {
    return this.settlementsService.findAll(query);
  }

  @Post('settlements')
  @ApiOperation({
    summary:
      'Batch a representative’s eligible commission lines for a period into a new settlement',
  })
  create(
    @Body() dto: CreateSettlementDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.settlementsService.create(dto, adminId);
  }

  @Get('settlements/:id')
  @ApiOperation({ summary: 'Get settlement details' })
  findOne(@Param('id') id: string) {
    return this.settlementsService.findOne(id);
  }

  @Patch('settlements/:id/approve')
  @ApiOperation({ summary: 'Approve a pending settlement' })
  approve(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.settlementsService.approve(id, adminId);
  }

  @Patch('settlements/:id/reject')
  @ApiOperation({
    summary: 'Reject a settlement, releasing its lines back to pending',
  })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectSettlementDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.settlementsService.reject(id, dto, adminId);
  }

  @Patch('settlements/:id/pay')
  @ApiOperation({ summary: 'Record how an approved settlement was paid' })
  pay(
    @Param('id') id: string,
    @Body() dto: PaySettlementDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.settlementsService.pay(id, dto, adminId);
  }

  @Patch('settlements/:id/cheque-status')
  @ApiOperation({
    summary: 'Mark a cheque-mode settlement CLEARED or RETURNED',
  })
  updateChequeStatus(
    @Param('id') id: string,
    @Body('status') status: 'CLEARED' | 'RETURNED',
    @CurrentUser('sub') adminId: string,
  ) {
    return this.settlementsService.updateChequeStatus(id, status, adminId);
  }

  @Get('settlements/:id/receipt')
  @ApiOperation({
    summary:
      'Settlement receipt data (structured JSON for the frontend to render/print — no server-side PDF pipeline exists in this codebase to mirror)',
  })
  receipt(@Param('id') id: string) {
    return this.settlementsService.findOne(id);
  }
}
