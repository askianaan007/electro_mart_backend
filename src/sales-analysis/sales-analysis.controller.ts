import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { SalesAnalysisService } from './sales-analysis.service';
import { QuerySalesAnalysisDto } from './dto/query-sales-analysis.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Sales Analysis')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('sales-analysis')
export class SalesAnalysisController {
  constructor(private salesAnalysisService: SalesAnalysisService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Net profit analysis for completed orders: total sales, cost of goods sold, gross profit, and net profit after expenses',
  })
  getSummary(@Query() query: QuerySalesAnalysisDto) {
    return this.salesAnalysisService.getSummary(query);
  }

  @Get()
  @ApiOperation({
    summary: 'Per-order sales analysis: selling price, buying price, and profit for each delivered/completed order',
  })
  findAll(@Query() query: QuerySalesAnalysisDto) {
    return this.salesAnalysisService.findAll(query);
  }
}
