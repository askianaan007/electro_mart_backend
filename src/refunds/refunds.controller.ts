import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RefundsService } from './refunds.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';
import { UpdateRefundChequeStatusDto } from './dto/update-refund-cheque-status.dto';
import { CancelRefundDto } from './dto/cancel-refund.dto';

@ApiTags('Refunds')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('refunds')
export class RefundsController {
  constructor(private refundsService: RefundsService) {}

  @Post()
  @ApiOperation({
    summary:
      "Pay back a dealer's credit (cash out) or record a supplier paying back theirs (cash in)",
  })
  create(@Body() dto: CreateRefundDto, @CurrentUser('sub') adminId: string) {
    return this.refundsService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({ summary: 'List refunds' })
  findAll(@Query() query: QueryRefundsDto) {
    return this.refundsService.findAll(query);
  }

  @Get('available/dealer/:id')
  @ApiOperation({ summary: "A dealer's refundable credit" })
  dealerCredit(@Param('id', ParseUUIDPipe) id: string) {
    return this.refundsService.availableCredit('DEALER', id);
  }

  @Get('available/supplier/:id')
  @ApiOperation({
    summary: "A supplier's refundable credit (what they owe us)",
  })
  supplierCredit(@Param('id', ParseUUIDPipe) id: string) {
    return this.refundsService.availableCredit('SUPPLIER', id);
  }

  @Patch(':id/cheque-status')
  @ApiOperation({ summary: 'Mark a refund cheque CLEARED or RETURNED' })
  updateChequeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRefundChequeStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.refundsService.updateChequeStatus(id, dto.status, adminId);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a refund recorded in error' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelRefundDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.refundsService.cancel(id, dto.reason, adminId);
  }
}
