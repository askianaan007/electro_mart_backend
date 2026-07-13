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
import { InventoryService } from './inventory.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { QueryLedgerDto } from './dto/query-ledger.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Inventory')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('inventory')
export class InventoryController {
  constructor(private inventoryService: InventoryService) {}

  @Get()
  @ApiOperation({ summary: 'List current stock levels with status badges' })
  listStock(@Query() query: QueryInventoryDto) {
    return this.inventoryService.listStock(query);
  }

  @Get(':productId/ledger')
  @ApiOperation({ summary: 'Get stock movement ledger for a product' })
  getLedger(
    @Param('productId') productId: string,
    @Query() query: QueryLedgerDto,
  ) {
    return this.inventoryService.getLedger(productId, query);
  }

  @Post('adjustment')
  @ApiOperation({ summary: 'Manually adjust stock for a product' })
  adjustStock(@Body() dto: AdjustStockDto, @CurrentUser('sub') adminId: string) {
    return this.inventoryService.adjustStock(dto, adminId);
  }
}
