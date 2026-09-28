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
import { PurchaseReturnsService } from './purchase-returns.service';
import { CreatePurchaseReturnDto } from './dto/create-purchase-return.dto';
import { UpdatePurchaseReturnDto } from './dto/update-purchase-return.dto';
import { QueryPurchaseReturnsDto } from './dto/query-purchase-returns.dto';
import { ReplacementReceiptsService } from './replacement-receipts.service';
import { CreateReplacementReceiptDto } from './dto/create-replacement-receipt.dto';
import { QueryReplacementReceiptsDto } from './dto/query-replacement-receipts.dto';
import { UpdateReplacementReceiptDto } from './dto/update-replacement-receipt.dto';
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
  constructor(
    private purchaseReturnsService: PurchaseReturnsService,
    private replacementReceiptsService: ReplacementReceiptsService,
  ) {}

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

  @Post(':id/replacements')
  @ApiOperation({
    summary:
      'Receive replacement goods for a return: restocks them and adds their value back to the supplier balance',
  })
  receiveReplacement(
    @Param('id') id: string,
    @Body() dto: CreateReplacementReceiptDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.replacementReceiptsService.create(id, dto, adminId);
  }

  @Get(':id/replacements')
  @ApiOperation({ summary: 'List replacement receipts recorded for a return' })
  findReplacements(@Param('id') id: string) {
    return this.replacementReceiptsService.findForReturn(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Correct a mistaken return — only within 1 day of recording it',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseReturnDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.purchaseReturnsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a mistaken return — only within 1 day of recording it',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.purchaseReturnsService.remove(id, adminId);
  }
}

@ApiTags('Purchase Returns')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('purchase-return-replacements')
export class ReplacementReceiptsController {
  constructor(private replacementReceiptsService: ReplacementReceiptsService) {}

  @Get()
  @ApiOperation({ summary: 'List replacement receipts' })
  findAll(@Query() query: QueryReplacementReceiptsDto) {
    return this.replacementReceiptsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get replacement receipt details' })
  findOne(@Param('id') id: string) {
    return this.replacementReceiptsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Correct a mistaken replacement receipt (quantity, return line/product, date, ref) — only within 1 day of recording it',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateReplacementReceiptDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.replacementReceiptsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Void a mistaken replacement receipt — only within 1 day of recording it',
  })
  void(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.replacementReceiptsService.void(id, adminId);
  }
}
