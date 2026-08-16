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
import { RepresentativesService } from './representatives.service';
import { CreateRepresentativeDto } from './dto/create-representative.dto';
import { UpdateRepresentativeDto } from './dto/update-representative.dto';
import { QueryRepresentativeDto } from './dto/query-representative.dto';
import { SetRepresentativeStatusDto } from './dto/set-representative-status.dto';
import { AssignProductDto } from './dto/assign-product.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';   
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Representative Management module (version2_changes_backend.md §3) — a
// first-class Admin Panel module mirroring DealersController exactly.
// Admin-only, in its entirety: representatives never have access to any
// route here, by construction (Role.ADMIN is the only role ever listed).
@ApiTags('Representatives')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('representatives')
export class RepresentativesController {
  constructor(private representativesService: RepresentativesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a representative account' })
  create(
    @Body() dto: CreateRepresentativeDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({
    summary: 'List representatives with search, status filter, and pagination',
  })
  findAll(@Query() query: QueryRepresentativeDto) {
    return this.representativesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get representative profile with customer/order summary',
  })
  findOne(@Param('id') id: string) {
    return this.representativesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update representative details' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRepresentativeDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.update(id, dto, adminId);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Set representative status (Active/Suspended/Blocked/Inactive)',
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetRepresentativeStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.setStatus(id, dto.status, adminId);
  }

  @Post(':id/reset-password')
  @ApiOperation({
    summary: 'Generate a new temporary password for a representative',
  })
  resetPassword(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.representativesService.resetPassword(id, adminId);
  }

  @Post(':id/force-password-change')
  @ApiOperation({
    summary: "Force a password change on the representative's next login",
  })
  forcePasswordChange(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.forcePasswordChange(id, adminId);
  }

  @Post(':id/unlock')
  @ApiOperation({ summary: 'Clear a login lockout for a representative' })
  unlock(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.representativesService.unlock(id, adminId);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a representative (only if they have no related records)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.representativesService.remove(id, adminId);
  }

  @Get(':id/login-history')
  @ApiOperation({ summary: "View a representative's login history" })
  getLoginHistory(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.representativesService.getLoginHistory(id, query);
  }

  @Get(':id/activity-log')
  @ApiOperation({ summary: "View a representative's activity log" })
  getActivityLog(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.representativesService.getActivityLog(id, query);
  }

  @Delete(':id/activity-log')
  @ApiOperation({ summary: "Clear a representative's activity log" })
  clearActivityLog(
    @Param('id') id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.clearActivityLog(id, adminId);
  }

  @Get(':id/sales-stats')
  @ApiOperation({ summary: "View a representative's sales statistics" })
  getSalesStats(@Param('id') id: string) {
    return this.representativesService.getSalesStats(id);
  }

  @Get(':id/commission-stats')
  @ApiOperation({ summary: "View a representative's commission statistics" })
  getCommissionStats(@Param('id') id: string) {
    return this.representativesService.getCommissionStats(id);
  }

  @Get(':id/settlements')
  @ApiOperation({ summary: "View a representative's settlement history" })
  getSettlements(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.representativesService.getSettlements(id, query);
  }

  @Get(':id/assigned-products')
  @ApiOperation({ summary: "List a representative's assigned product scopes" })
  getAssignedProducts(@Param('id') id: string) {
    return this.representativesService.getAssignedProducts(id);
  }

  @Post(':id/assigned-products')
  @ApiOperation({
    summary:
      'Assign a category/product/brand/campaign scope to a representative',
  })
  assignProduct(
    @Param('id') id: string,
    @Body() dto: AssignProductDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.assignProduct(
      id,
      dto.scopeType,
      dto.scopeValue,
      adminId,
    );
  }

  @Delete(':id/assigned-products/:assignmentId')
  @ApiOperation({
    summary: "Remove one of a representative's assigned product scopes",
  })
  removeProductAssignment(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.representativesService.removeProductAssignment(
      id,
      assignmentId,
      adminId,
    );
  }

  @Get(':id/assigned-banners')
  @ApiOperation({ summary: "List a representative's assigned banners" })
  getAssignedBanners(@Param('id') id: string) {
    return this.representativesService.getAssignedBanners(id);
  }

  @Get(':id/assigned-customers')
  @ApiOperation({ summary: 'List shops this representative registered' })
  getAssignedCustomers(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.representativesService.getAssignedCustomers(id, query);
  }
}
