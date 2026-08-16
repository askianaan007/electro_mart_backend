import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { BannersService } from './banners.service';
import { CreateBannerDto } from './dto/create-banner.dto';
import { UpdateBannerDto } from './dto/update-banner.dto';
import { AssignBannerDto } from './dto/assign-banner.dto';
import { SetStatusDto } from '../common/dto/set-status.dto';
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

// Banner module (Rep_Portal_DOCUMENTATION.md §7 / version2_changes_backend.md §8).
// Admin manages the global banner pool; Representatives may read it for
// reference. The *personalized* homepage banner list a rep actually sees is
// resolved by RepCatalogVisibilityService and served from RepPortalModule's
// /rep-portal/home — this controller is the plain admin-CRUD surface.
@ApiTags('Banners')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('banners')
export class BannersController {
  constructor(private bannersService: BannersService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a banner' })
  @UseInterceptors(FileInterceptor('image', imageInterceptorOptions))
  create(
    @Body() dto: CreateBannerDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.bannersService.create(dto, file, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'List banners' })
  findAll() {
    return this.bannersService.findAll();
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.REPRESENTATIVE)
  @ApiOperation({ summary: 'Get a banner' })
  findOne(@Param('id') id: string) {
    return this.bannersService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a banner (non-image fields)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBannerDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.bannersService.update(id, dto, adminId);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Activate or deactivate a banner' })
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.bannersService.setStatus(id, dto, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a banner' })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.bannersService.remove(id, adminId);
  }

  @Get(':id/assignments')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List representative assignments for a banner' })
  listAssignments(@Param('id') id: string) {
    return this.bannersService.listAssignments(id);
  }

  @Post(':id/assignments')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Assign a banner to a representative' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignBannerDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.bannersService.assign(id, dto, adminId);
  }

  @Delete(':id/assignments/:assignmentId')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Remove a banner assignment' })
  removeAssignment(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.bannersService.removeAssignment(id, assignmentId, adminId);
  }
}
