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
import { ProfitEntriesService } from './profit-entries.service';
import { CreateProfitEntryDto } from './dto/create-profit-entry.dto';
import { UpdateProfitEntryDto } from './dto/update-profit-entry.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Profit Entries')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('profit-entries')
export class ProfitEntriesController {
  constructor(private profitEntriesService: ProfitEntriesService) {}

  @Post()
  @ApiOperation({ summary: 'Record a company profit figure for a period' })
  create(@Body() dto: CreateProfitEntryDto) {
    return this.profitEntriesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List profit-period entries' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.profitEntriesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a profit-period entry' })
  findOne(@Param('id') id: string) {
    return this.profitEntriesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a profit-period entry' })
  update(@Param('id') id: string, @Body() dto: UpdateProfitEntryDto) {
    return this.profitEntriesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a profit-period entry' })
  remove(@Param('id') id: string) {
    return this.profitEntriesService.remove(id);
  }
}
