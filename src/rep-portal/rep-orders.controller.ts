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
import { RepOrdersService } from './rep-orders.service';
import { CreateOrderDto } from '../orders/dto/create-order.dto';
import { QueryRepOrderDto } from './dto/query-rep-order.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Rep Portal — Orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal/orders')
export class RepOrdersController {
  constructor(private repOrdersService: RepOrdersService) {}

  @Post()
  @ApiOperation({
    summary:
      "Submit an order on a customer's behalf — reuses OrdersService.create() unmodified, starts PENDING_APPROVAL",
  })
  create(@CurrentUser('sub') repId: string, @Body() dto: CreateOrderDto) {
    return this.repOrdersService.create(repId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List this representative's own placed orders" })
  list(@CurrentUser('sub') repId: string, @Query() query: QueryRepOrderDto) {
    return this.repOrdersService.list(repId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order detail + status timeline' })
  findOne(@Param('id') id: string, @CurrentUser('sub') repId: string) {
    return this.repOrdersService.findOne(id, repId);
  }
}
