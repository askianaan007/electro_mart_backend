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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

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
}
