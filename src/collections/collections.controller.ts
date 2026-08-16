import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CollectionsService } from './collections.service';
import { ConfirmCollectionDto } from './dto/confirm-collection.dto';
import { RejectCollectionDto } from './dto/reject-collection.dto';
import { QueryCollectionAdminDto } from './dto/query-collection-admin.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// version2_changes_backend.md §14.5 — Admin review queue. Only an Admin can
// ever call confirm(), the sole route that bridges into PaymentsService.create().
@ApiTags('Collections (Admin)')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('collections')
export class CollectionsController {
  constructor(private collectionsService: CollectionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin review queue, filterable by status/representative',
  })
  findAll(@Query() query: QueryCollectionAdminDto) {
    return this.collectionsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a collection submission' })
  findOne(@Param('id') id: string) {
    return this.collectionsService.findOne(id);
  }

  @Patch(':id/confirm')
  @ApiOperation({
    summary: 'Verify and confirm a collection — creates the real payment',
  })
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmCollectionDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.collectionsService.confirm(id, dto, adminId);
  }

  @Patch(':id/reject')
  @ApiOperation({
    summary: 'Reject a collection submission — no financial effect',
  })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectCollectionDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.collectionsService.reject(id, dto, adminId);
  }
}
