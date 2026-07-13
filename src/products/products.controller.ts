import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';

function hideCostPriceForDealer<T extends { costPrice?: unknown }>(
  product: T,
  role: JwtPayload['role'],
) {
  if (role !== Role.DEALER) return product;
  const rest: Partial<T> = { ...product };
  delete rest.costPrice;
  return rest;
}

@ApiTags('Products')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product' })
  create(@Body() dto: CreateProductDto, @CurrentUser('sub') adminId: string) {
    return this.productsService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({
    summary:
      'List products with search, category, low-stock filter, and pagination',
  })
  async findAll(
    @Query() query: QueryProductDto,
    @CurrentUser('role') role: JwtPayload['role'],
  ) {
    const result = await this.productsService.findAll(query);
    return {
      ...result,
      data: result.data.map((product) => hideCostPriceForDealer(product, role)),
    };
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({ summary: 'Get product details' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('role') role: JwtPayload['role'],
  ) {
    const product = await this.productsService.findOne(id);
    return hideCostPriceForDealer(product, role);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a product' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.update(id, dto, adminId);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Activate or deactivate a product' })
  setStatus(
    @Param('id') id: string,
    @Body('status') status: 'ACTIVE' | 'INACTIVE',
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.setStatus(id, status, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Delete a product (only if it has no order/purchase history)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.productsService.remove(id, adminId);
  }
}
