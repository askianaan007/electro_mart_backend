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
import { Role } from '@prisma/client';
import { RepCustomersService } from './rep-customers.service';
import { CreateRepCustomerDto } from './dto/create-rep-customer.dto';
import { SetCustomerStatusDto } from './dto/set-customer-status.dto';
import { AddCustomerNoteDto } from './dto/add-customer-note.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Rep Portal — Customers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal/customers')
export class RepCustomersController {
  constructor(private repCustomersService: RepCustomersService) {}

  @Get()
  @ApiOperation({
    summary:
      'Search Rep Portal customers by shop name, owner, phone, area, or city',
  })
  search(@Query() query: PaginationQueryDto) {
    return this.repCustomersService.search(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Register a new shop, with duplicate-phone detection',
  })
  create(@Body() dto: CreateRepCustomerDto, @CurrentUser('sub') repId: string) {
    return this.repCustomersService.create(dto, repId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a customer profile, order summary, and timeline notes',
  })
  findOne(@Param('id') id: string) {
    return this.repCustomersService.findOne(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Set a customer status (Lead/New/Regular/VIP/Blocked/Inactive)',
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: SetCustomerStatusDto,
    @CurrentUser('sub') repId: string,
  ) {
    return this.repCustomersService.setStatus(id, dto.status, repId);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: "Append a note to a customer's timeline" })
  addNote(
    @Param('id') id: string,
    @Body() dto: AddCustomerNoteDto,
    @CurrentUser('sub') repId: string,
  ) {
    return this.repCustomersService.addNote(id, dto.note, repId);
  }
}
