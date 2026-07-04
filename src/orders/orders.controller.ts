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
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { QueryOrderDto } from './dto/query-order.dto';
import { RejectOrderDto } from './dto/reject-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';

@ApiTags('Orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Post()
  @Roles(Role.DEALER)
  @ApiOperation({ summary: 'Dealer submits a new order for approval' })
  create(@CurrentUser('sub') dealerId: string, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(dealerId, dto);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({
    summary: 'List orders (admins see all, dealers see their own)',
  })
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryOrderDto) {
    return user.role === Role.ADMIN
      ? this.ordersService.findAllForAdmin(query)
      : this.ordersService.findAllForDealer(user.sub, query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({ summary: 'Get order details' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.ordersService.findOne(id, { role: user.role, id: user.sub });
  }

  @Patch(':id/approve')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Approve a pending order — reserves stock and generates an invoice',
  })
  approve(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.ordersService.approve(id, adminId);
  }

  @Patch(':id/reject')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Reject a pending order with a reason' })
  reject(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.ordersService.reject(id, adminId, dto.reason);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Advance order status: Packed -> Delivered -> Completed',
  })
  updateStatus(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.advanceStatus(id, adminId, dto.status);
  }
}
