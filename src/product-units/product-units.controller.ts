import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { ProductUnitsService } from './product-units.service';
import {
  AssignOrderUnitsDto,
  QueryUnitsDto,
  RegisterUnitsDto,
  SetConditionDto,
  SupplierReplacementDto,
  UpdateUnitDto,
  ValidateSerialsDto,
  WarrantySwapDto,
} from './dto/product-units.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Serial Units')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller()
export class ProductUnitsController {
  constructor(private productUnitsService: ProductUnitsService) {}

  @Post('product-units/validate')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check scanned serials for a context — no writes' })
  validate(@Body() dto: ValidateSerialsDto) {
    return this.productUnitsService.validate(dto);
  }

  @Post('product-units')
  @ApiOperation({
    summary:
      'Register serials against a purchase, or for stock already on the shelf',
  })
  register(@Body() dto: RegisterUnitsDto, @CurrentUser('sub') adminId: string) {
    return this.productUnitsService.register(dto, adminId);
  }

  @Get('product-units')
  @ApiOperation({ summary: 'List serial units' })
  findAll(@Query() query: QueryUnitsDto) {
    return this.productUnitsService.findAll(query);
  }

  @Get('product-units/coverage')
  @ApiOperation({
    summary:
      'Physical stock vs registered serials per tracked product (report only)',
  })
  coverage(@Query('productId') productId?: string) {
    return this.productUnitsService.coverage(productId);
  }

  @Get('product-units/scan/:code')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Resolve a scanned code to a unit, a product (model barcode) or nothing',
  })
  scan(@Param('code') code: string) {
    return this.productUnitsService.scan(code);
  }

  @Get('product-units/:id')
  @ApiOperation({ summary: 'Full life of one unit' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.productUnitsService.findOne(id);
  }

  @Patch('product-units/:id')
  @ApiOperation({
    summary: 'Correct a serial typo, edit notes or warranty dates',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.update(id, dto, adminId);
  }

  @Delete('product-units/:id')
  @ApiOperation({
    summary:
      'Remove a mistakenly registered unit (no sales/return history only)',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.remove(id, adminId);
  }

  @Post('product-units/:id/condition')
  @ApiOperation({ summary: 'Mark an in-stock unit good or defective' })
  setCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetConditionDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.setCondition(id, dto, adminId);
  }

  @Post('product-units/:id/warranty-swap')
  @ApiOperation({
    summary:
      'Swap a faulty unit on an order for another in-stock unit (no stock or money change)',
  })
  warrantySwap(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WarrantySwapDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.warrantySwap(id, dto, adminId);
  }

  @Post('product-units/:id/supplier-replacement')
  @ApiOperation({
    summary: 'Register the unit a supplier sent in place of this returned one',
  })
  supplierReplacement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupplierReplacementDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.supplierReplacement(id, dto, adminId);
  }

  @Get('orders/:id/units')
  @ApiOperation({ summary: 'Serials per line of an order' })
  getOrderUnits(@Param('id', ParseUUIDPipe) id: string) {
    return this.productUnitsService.getOrderUnits(id);
  }

  @Put('orders/:id/units')
  @ApiOperation({
    summary:
      'Set the exact serial set for one or more lines of an approved order',
  })
  assignOrderUnits(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignOrderUnitsDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productUnitsService.assignOrderUnits(id, dto, adminId);
  }
}
