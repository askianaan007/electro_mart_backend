import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ActivityLogService } from './activity-log.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Activity Log')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('activity-logs')
export class ActivityLogController {
  constructor(private activityLogService: ActivityLogService) {}

  @Get()
  @ApiOperation({ summary: 'Audit trail of admin actions' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.activityLogService.findAll(query);
  }
}
