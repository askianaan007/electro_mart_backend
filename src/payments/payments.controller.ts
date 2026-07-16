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
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UpdatePaymentChequeStatusDto } from './dto/update-payment-cheque-status.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';

@ApiTags('Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Record a payment against an invoice' })
  create(@Body() dto: CreatePaymentDto, @CurrentUser('sub') adminId: string) {
    return this.paymentsService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({
    summary: 'List payments (admins see all, dealers see their own)',
  })
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryPaymentDto) {
    return user.role === Role.ADMIN
      ? this.paymentsService.findAllForAdmin(query)
      : this.paymentsService.findAllForDealer(user.sub, query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({ summary: 'Get payment details' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentsService.findOne(id, { role: user.role, id: user.sub });
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Edit a payment within 1 day of it being recorded (blocked once a cheque has moved past PENDING)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.paymentsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Return/reverse a payment within 1 day of it being recorded, restoring the dealer balance and invoice status',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.paymentsService.remove(id, adminId);
  }

  @Patch(':id/cheque-status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Mark a pending cheque payment as cleared or returned (bounced), or revert a cleared/returned cheque back to pending within 1 day of that change',
  })
  updateChequeStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentChequeStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.paymentsService.updateChequeStatus(id, dto.status, adminId);
  }
}
