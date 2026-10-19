import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CashAdjustmentsService } from './cash-adjustments.service';
import { CreateCashAdjustmentDto } from './dto/create-cash-adjustment.dto';
import { ReverseCashAdjustmentDto } from './dto/reverse-cash-adjustment.dto';

@ApiTags('Cash Adjustments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('cash-adjustments')
export class CashAdjustmentsController {
  constructor(private cashAdjustmentsService: CashAdjustmentsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Record a verified opening balance or a cash/bank-verified Liquid Cash adjustment (password required)',
  })
  create(
    @Body() dto: CreateCashAdjustmentDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.cashAdjustmentsService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({ summary: 'List cash adjustments' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.cashAdjustmentsService.findAll(query);
  }

  @Post(':id/reverse')
  @ApiOperation({
    summary:
      'Reverse an adjustment with an exactly negating entry (password required)',
  })
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseCashAdjustmentDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.cashAdjustmentsService.reverse(
      id,
      dto.reason,
      dto.password,
      adminId,
    );
  }
}
