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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
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

@ApiTags('Categories')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a product category' })
  create(@Body() dto: CreateCategoryDto, @CurrentUser('sub') adminId: string) {
    return this.categoriesService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'List product categories' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.categoriesService.findAll(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'Get a category' })
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update a category (name, sortOrder, isFeatured, parentId)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.categoriesService.update(id, dto, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a category' })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.categoriesService.remove(id, adminId);
  }

  @Post(':id/image')
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a category's hero image" })
  @UseInterceptors(FileInterceptor('image', imageInterceptorOptions))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') adminId: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.categoriesService.uploadImage(id, file, adminId);
  }

  @Post(':id/icon')
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: "Upload a category's icon" })
  @UseInterceptors(FileInterceptor('icon', imageInterceptorOptions))
  uploadIcon(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') adminId: string,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.categoriesService.uploadIcon(id, file, adminId);
  }
}
