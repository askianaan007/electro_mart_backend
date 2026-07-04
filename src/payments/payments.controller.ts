import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
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
}
