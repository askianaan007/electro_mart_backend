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
import { SalesReturnsService } from './sales-returns.service';
import { CreateSalesReturnDto } from './dto/create-sales-return.dto';
import { UpdateSalesReturnDto } from './dto/update-sales-return.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Sales Returns')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('sales-returns')
export class SalesReturnsController {
  constructor(private salesReturnsService: SalesReturnsService) {}

  @Post()
  @ApiOperation({
    summary: 'Record a sales return: restocks inventory and credits the dealer',
  })
  create(
    @Body() dto: CreateSalesReturnDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.salesReturnsService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({ summary: 'List sales returns' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.salesReturnsService.findAll(query);
  }

  @Get('by-order/:orderId')
  @ApiOperation({ summary: 'List sales returns for a specific order' })
  findAllForOrder(@Param('orderId') orderId: string) {
    return this.salesReturnsService.findAllForOrder(orderId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sales return details' })
  findOne(@Param('id') id: string) {
    return this.salesReturnsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Correct a mistaken return: reverses the old stock/credit impact and applies the new one (within 1 day of recording)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSalesReturnDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.salesReturnsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete a mistaken return entirely: reverses its stock/credit impact (within 1 day of recording)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.salesReturnsService.remove(id, adminId);
  }
}
