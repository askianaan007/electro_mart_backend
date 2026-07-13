import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AccountStatus, Role } from '@prisma/client';
import { DealersService } from './dealers.service';
import { CreateDealerDto } from './dto/create-dealer.dto';
import { UpdateDealerDto } from './dto/update-dealer.dto';
import { QueryDealerDto } from './dto/query-dealer.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Dealers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('dealers')
export class DealersController {
  constructor(private dealersService: DealersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a dealer account' })
  create(@Body() dto: CreateDealerDto, @CurrentUser('sub') adminId: string) {
    return this.dealersService.create(dto, adminId);
  }

  @Get()
  @ApiOperation({
    summary: 'List dealers with search, status filter, and pagination',
  })
  findAll(@Query() query: QueryDealerDto) {
    return this.dealersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get dealer profile with order/invoice summary' })
  findOne(@Param('id') id: string) {
    return this.dealersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update dealer details' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDealerDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.dealersService.update(id, dto, adminId);
  }

  @Post(':id/reset-password')
  @ApiOperation({
    summary: 'Generate a new temporary password for a dealer account',
  })
  resetPassword(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.dealersService.resetPassword(id, adminId);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a dealer account' })
  setStatus(
    @Param('id') id: string,
    @Body('status') status: AccountStatus,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.dealersService.setStatus(id, status, adminId);
  }
}
