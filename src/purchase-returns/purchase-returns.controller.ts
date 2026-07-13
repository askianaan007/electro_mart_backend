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
import { PurchaseReturnsService } from './purchase-returns.service';
import { CreatePurchaseReturnDto } from './dto/create-purchase-return.dto';
import { QueryPurchaseReturnsDto } from './dto/query-purchase-returns.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Purchase Returns')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('purchase-returns')
export class PurchaseReturnsController {
  constructor(private purchaseReturnsService: PurchaseReturnsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Record a purchase return: reduces inventory sent back to the supplier',
  })
  create(
    @Body() dto: CreatePurchaseReturnDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.purchaseReturnsService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({ summary: 'List purchase returns' })
  findAll(@Query() query: QueryPurchaseReturnsDto) {
    return this.purchaseReturnsService.findAll(query);
  }

  @Get('by-purchase/:purchaseId')
  @ApiOperation({ summary: 'List purchase returns for a specific purchase' })
  findAllForPurchase(@Param('purchaseId') purchaseId: string) {
    return this.purchaseReturnsService.findAllForPurchase(purchaseId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get purchase return details' })
  findOne(@Param('id') id: string) {
    return this.purchaseReturnsService.findOne(id);
  }
}
