import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { InvoicesService } from './invoices.service';
import { QueryInvoiceDto } from './dto/query-invoice.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';

@ApiTags('Invoices')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.DEALER)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoicesService: InvoicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List invoices (admins see all, dealers see their own)',
  })
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryInvoiceDto) {
    return user.role === Role.ADMIN
      ? this.invoicesService.findAllForAdmin(query)
      : this.invoicesService.findAllForDealer(user.sub, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get invoice details' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.invoicesService.findOne(id, { role: user.role, id: user.sub });
  }
}
