import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RepHomeService } from './rep-home.service';
import { RepActivityLogService } from '../rep-activity-log/rep-activity-log.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Rep Portal — Home')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal')
export class RepHomeController {
  constructor(
    private repHomeService: RepHomeService,
    private repActivityLogService: RepActivityLogService,
  ) {}

  @Get('home')
  @ApiOperation({
    summary:
      'Single aggregated homepage payload — banners, featured categories/brands, new arrivals, best sellers, offers, recommended',
  })
  home(@CurrentUser('sub') repId: string) {
    return this.repHomeService.home(repId);
  }

  @Get('search')
  @ApiQuery({ name: 'q', required: true })
  @ApiOperation({ summary: 'Search by name/SKU/barcode/brand/category/model' })
  search(@CurrentUser('sub') repId: string, @Query('q') q: string) {
    return this.repHomeService.search(repId, q ?? '');
  }

  @Get('dashboard')
  @ApiOperation({ summary: "The representative's own KPI dashboard" })
  dashboard(@CurrentUser('sub') repId: string) {
    return this.repHomeService.dashboard(repId);
  }

  @Get('activity-log')
  @ApiOperation({
    summary: "The representative's own activity log (read-only; §13.6)",
  })
  activityLog(
    @CurrentUser('sub') repId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.repActivityLogService.findAllForRepresentative(repId, query);
  }
}
