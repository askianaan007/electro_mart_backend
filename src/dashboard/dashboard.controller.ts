import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get('admin')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Admin dashboard summary: sales, approvals, stock, outstanding',
  })
  getAdminSummary() {
    return this.dashboardService.getAdminSummary();
  }

  @Get('dealer')
  @Roles(Role.DEALER)
  @ApiOperation({
    summary:
      'Dealer dashboard summary: own balance, credit, and recent activity',
  })
  getDealerSummary(@CurrentUser('sub') dealerId: string) {
    return this.dashboardService.getDealerSummary(dealerId);
  }
}
