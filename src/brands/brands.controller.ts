import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

const imageInterceptorOptions = {
  limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
  fileFilter: (
    _req: unknown,
    file: Express.Multer.File,
    callback: (error: Error | null, accept: boolean) => void,
  ) => {
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
};

// Brand module (Rep_Portal_DOCUMENTATION.md §8) — mirrors CategoriesController's
// read-role split: Admin manages, Admin + Representative (+ Dealer, for
// parity with the existing Categories read access) can read.
@ApiTags('Brands')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('brands')
export class BrandsController {
  constructor(private brandsService: BrandsService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a brand' })
  create(@Body() dto: CreateBrandDto, @CurrentUser('sub') adminId: string) {
    return this.brandsService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'List brands' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.brandsService.findAll(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'Get a brand' })
  findOne(@Param('id') id: string) {
    return this.brandsService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a brand' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.brandsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Delete a brand (only if no products reference it)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.brandsService.remove(id, adminId);
  }

  @Post(':id/logo')
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a brand's logo" })
  @UseInterceptors(FileInterceptor('logo', imageInterceptorOptions))
  uploadLogo(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') adminId: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.brandsService.uploadLogo(id, file, adminId);
  }

  @Post(':id/image')
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a brand's hero image (brand page)" })
  @UseInterceptors(FileInterceptor('image', imageInterceptorOptions))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') adminId: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.brandsService.uploadImage(id, file, adminId);
  }
}
