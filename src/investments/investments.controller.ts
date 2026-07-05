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
import { InvestmentsService } from './investments.service';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { QueryInvestmentDto } from './dto/query-investment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Investments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('investments')
export class InvestmentsController {
  constructor(private investmentsService: InvestmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Record an investor contribution or withdrawal' })
  create(@Body() dto: CreateInvestmentDto) {
    return this.investmentsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List investment ledger entries' })
  findAll(@Query() query: QueryInvestmentDto) {
    return this.investmentsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an investment entry' })
  findOne(@Param('id') id: string) {
    return this.investmentsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an investment entry' })
  update(@Param('id') id: string, @Body() dto: UpdateInvestmentDto) {
    return this.investmentsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an investment entry' })
  remove(@Param('id') id: string) {
    return this.investmentsService.remove(id);
  }
}
