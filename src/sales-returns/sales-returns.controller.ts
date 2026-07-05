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
import { SalesReturnsService } from './sales-returns.service';
import { CreateSalesReturnDto } from './dto/create-sales-return.dto';
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

  @Get(':id')
  @ApiOperation({ summary: 'Get sales return details' })
  findOne(@Param('id') id: string) {
    return this.salesReturnsService.findOne(id);
  }
}
