import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_PRODUCT_IMAGES,
  ProductsService,
} from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { SetStatusDto } from '../common/dto/set-status.dto';
import { SetAvailabilityOverrideDto } from './dto/set-availability-override.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import { RepCatalogVisibilityService } from '../rep-catalog-visibility/rep-catalog-visibility.service';

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// Renamed from hideCostPriceForDealer — costPrice is hidden from every
// non-Admin channel, Dealer and Representative alike (Rep_Portal_DOCUMENTATION.md §5.3).
function hideCostPrice<T extends { costPrice?: unknown }>(
  product: T,
  role: JwtPayload['role'],
) {
  if (role !== Role.DEALER && role !== Role.REPRESENTATIVE) return product;
  const rest: Partial<T> = { ...product };
  delete rest.costPrice;
  return rest;
}

@ApiTags('Products')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(
    private productsService: ProductsService,
    private repCatalogVisibility: RepCatalogVisibilityService,
  ) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product' })
  create(@Body() dto: CreateProductDto, @CurrentUser('sub') adminId: string) {
    return this.productsService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({
    summary:
      'List products with search, category, low-stock filter, and pagination',
  })
  async findAll(
    @Query() query: QueryProductDto,
    @CurrentUser('role') role: JwtPayload['role'],
    @CurrentUser('sub') userId: string,
  ) {
    if (role === Role.REPRESENTATIVE) {
      const scope =
        await this.repCatalogVisibility.buildAssignedProductWhereClause(userId);
      const result = await this.productsService.findAll(query, scope);
      return {
        ...result,
        data: await this.repCatalogVisibility.serializeManyForRep(result.data),
      };
    }

    const result = await this.productsService.findAll(query);
    return {
      ...result,
      data: result.data.map((product) => hideCostPrice(product, role)),
    };
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'Get product details' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('role') role: JwtPayload['role'],
    @CurrentUser('sub') userId: string,
  ) {
    if (role === Role.REPRESENTATIVE) {
      const scope =
        await this.repCatalogVisibility.buildAssignedProductWhereClause(userId);
      const product = await this.productsService.findOne(id, scope);
      return this.repCatalogVisibility.serializeForRep(product);
    }

    const product = await this.productsService.findOne(id);
    return hideCostPrice(product, role);
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
    @Body() dto: SetStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.setStatus(id, dto.status, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Delete a product (only if it has no order/purchase history)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.productsService.remove(id, adminId);
  }

  @Post(':id/images')
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: `Upload up to ${MAX_PRODUCT_IMAGES} images for a product (max 5MB each)`,
  })
  @UseInterceptors(
    FilesInterceptor('images', MAX_PRODUCT_IMAGES, {
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
          callback(
            new BadRequestException(
              'Only JPEG, PNG, WEBP, or GIF images are allowed',
            ),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  addImages(
    @Param('id') id: string,
    @UploadedFiles() files: Array<Express.Multer.File>,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.addImages(id, files ?? [], adminId);
  }

  @Delete(':id/images/:imageId')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Remove a single image from a product's gallery" })
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.removeImage(id, imageId, adminId);
  }

  @Post(':id/availability-override')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Force a product to appear In Stock / Out of Stock to representatives, independent of currentStock',
  })
  setAvailabilityOverride(
    @Param('id') id: string,
    @Body() dto: SetAvailabilityOverrideDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.setAvailabilityOverride(id, dto, adminId);
  }

  @Delete(':id/availability-override')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Revert a product to its real stock status for representatives',
  })
  removeAvailabilityOverride(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.productsService.removeAvailabilityOverride(id, adminId);
  }
}
