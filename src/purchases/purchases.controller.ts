import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Purchases')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('purchases')
export class PurchasesController {
  constructor(private purchasesService: PurchasesService) {}

  @Post()
  @ApiOperation({ summary: 'Record a new stock purchase from a supplier' })
  create(@Body() dto: CreatePurchaseDto, @CurrentUser('sub') adminId: string) {
    return this.purchasesService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({ summary: 'List purchases' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.purchasesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get purchase details' })
  findOne(@Param('id') id: string) {
    return this.purchasesService.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete a purchase, reversing its stock movements (and any returns against it)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.purchasesService.remove(id, adminId);
  }
}
