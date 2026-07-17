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
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ApproveOrderDto } from './dto/approve-order.dto';
import { QueryOrderDto } from './dto/query-order.dto';
import { RejectOrderDto } from './dto/reject-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateOrderItemsDto } from './dto/update-order-items.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
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
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({
    summary:
      "Create an order — dealers submit their own for approval; admins create one pre-approved on a dealer's behalf",
  })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrderDto) {
    return this.ordersService.create({ role: user.role, id: user.sub }, dto);
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
  approve(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
    @Body() dto?: ApproveOrderDto,
  ) {
    return this.ordersService.approve(id, adminId, dto);
  }

  @Patch(':id/items')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "Replace a pending order's line items (only while PENDING_APPROVAL)",
  })
  updateItems(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
    @Body() dto: UpdateOrderItemsDto,
  ) {
    return this.ordersService.updateItems(id, adminId, dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Edit any order that has an invoice (fixes a mistake in dealer/items/discount/sale date) — reverses and re-applies its stock reservation, and dealer balance impact if it was completed',
  })
  update(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.ordersService.updateAdminOrder(id, dto, adminId);
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

  @Patch(':id/complete')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Fast-forward an approved order straight to Completed, applying any skipped Packed/Delivered steps along the way',
  })
  completeDirectly(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.ordersService.completeDirectly(id, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Delete an order any time before COMPLETED, reversing its stock reservation and invoice if it was approved',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.ordersService.remove(id, adminId);
  }
}
