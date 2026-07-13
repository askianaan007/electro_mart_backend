import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { EquityService } from './equity.service';
import { QueryEquityHistoryDto } from './dto/query-equity-history.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Equity')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('equity')
export class EquityController {
  constructor(private equityService: EquityService) {}

  @Get()
  @ApiOperation({
    summary:
      'Per-investor equity breakdown: investment + equal profit share - equal expense share',
  })
  getSummary() {
    return this.equityService.getSummary();
  }

  @Get('history')
  @ApiOperation({
    summary: 'Every investment, withdrawal, and expense affecting equity, merged and paginated',
  })
  getHistory(@Query() query: QueryEquityHistoryDto) {
    return this.equityService.getHistory(query);
  }
}
