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
import { InvestorsService } from './investors.service';
import { CreateInvestorDto } from './dto/create-investor.dto';
import { UpdateInvestorDto } from './dto/update-investor.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Investors')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('investors')
export class InvestorsController {
  constructor(private investorsService: InvestorsService) {}

  @Post()
  @ApiOperation({ summary: 'Create an investor' })
  create(@Body() dto: CreateInvestorDto) {
    return this.investorsService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List investors' })
  findAll(@Query() query: PaginationQueryDto) {
    return this.investorsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get investor details' })
  findOne(@Param('id') id: string) {
    return this.investorsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update investor details' })
  update(@Param('id') id: string, @Body() dto: UpdateInvestorDto) {
    return this.investorsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an investor' })
  remove(@Param('id') id: string) {
    return this.investorsService.remove(id);
  }
}
