import { Controller, Delete, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ActivityLogService } from './activity-log.service';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Activity Log')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('activity-logs')
export class ActivityLogController {
  constructor(private activityLogService: ActivityLogService) {}

  @Get()
  @ApiOperation({ summary: 'Audit trail of admin actions' })
  findAll(@Query() query: QueryActivityLogDto) {
    return this.activityLogService.findAll(query);
  }

  @Get('admins')
  @ApiOperation({ summary: 'List admins for filtering the activity log' })
  listAdmins() {
    return this.activityLogService.listAdmins();
  }

  @Delete()
  @ApiOperation({
    summary: 'Permanently clear the entire activity log (writes one final entry recording the clear)',
  })
  clearAll(@CurrentUser('sub') adminId: string) {
    return this.activityLogService.clearAll(adminId);
  }
}
