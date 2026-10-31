import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChequeFlowService } from './cheque-flow.service';
import { CreateChequeFlowDto } from './dto/create-cheque-flow.dto';
import { UpdateChequeFlowDto } from './dto/update-cheque-flow.dto';
import { UpdateChequeFlowStatusDto } from './dto/update-cheque-flow-status.dto';
import {
  QueryChequeFlowDto,
  QueryChequeFlowMonthlyDto,
} from './dto/query-cheque-flow.dto';
import {
  CommitChequeFlowImportDto,
  PreviewChequeFlowImportDto,
} from './dto/import-cheque-flow.dto';

@ApiTags('Cheque Flow')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('cheque-flow')
export class ChequeFlowController {
  constructor(private chequeFlowService: ChequeFlowService) {}

  @Get()
  @ApiOperation({
    summary:
      'Customer and supplier cheques for a month (or all months) with totals and the date-wise timeline',
  })
  list(@Query() query: QueryChequeFlowDto) {
    return this.chequeFlowService.list(query);
  }

  @Get('alerts')
  @ApiOperation({
    summary:
      'Pending cheques overdue, due today or due within 7 days (all months)',
  })
  alerts() {
    return this.chequeFlowService.alerts();
  }

  @Get('monthly')
  @ApiOperation({ summary: 'Receipts vs payments per month, for the chart' })
  monthly(@Query() query: QueryChequeFlowMonthlyDto) {
    return this.chequeFlowService.monthly(query);
  }

  @Get('options')
  @ApiOperation({ summary: 'Banks and names for filters and autocomplete' })
  options() {
    return this.chequeFlowService.options();
  }

  @Get('imports')
  @ApiOperation({ summary: 'Recent spreadsheet imports' })
  listImports() {
    return this.chequeFlowService.listImports();
  }

  @Post('imports/preview')
  @ApiOperation({
    summary: 'Check mapped spreadsheet rows — reports each row, saves nothing',
  })
  previewImport(@Body() dto: PreviewChequeFlowImportDto) {
    return this.chequeFlowService.previewImport(dto);
  }

  @Post('imports')
  @ApiOperation({
    summary: 'Save the ready rows of a previewed import (duplicates skipped)',
  })
  commitImport(
    @Body() dto: CommitChequeFlowImportDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.commitImport(dto, adminId);
  }

  @Delete('imports/:id')
  @ApiOperation({ summary: 'Undo an import — removes the cheques it added' })
  undoImport(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.undoImport(id, adminId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a customer or supplier cheque' })
  create(
    @Body() dto: CreateChequeFlowDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.create(dto, adminId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One cheque' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.chequeFlowService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a cheque' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChequeFlowDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.update(id, dto, adminId);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Mark pending, cleared (with date), bounced or cancelled',
  })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChequeFlowStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.setStatus(id, dto, adminId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a cheque (restorable)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.remove(id, adminId);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a deleted cheque' })
  restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.chequeFlowService.restore(id, adminId);
  }
}
