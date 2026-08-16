import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RepDraftsService } from './rep-drafts.service';
import { UpsertDraftDto } from './dto/upsert-draft.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Rep Portal — Drafts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal/drafts')
export class RepDraftsController {
  constructor(private repDraftsService: RepDraftsService) {}

  @Post()
  @ApiOperation({ summary: 'Start a new draft' })
  create(@CurrentUser('sub') repId: string) {
    return this.repDraftsService.create(repId);
  }

  @Get()
  @ApiOperation({ summary: "List this representative's open drafts" })
  list(@CurrentUser('sub') repId: string) {
    return this.repDraftsService.list(repId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a draft' })
  findOne(@Param('id') id: string, @CurrentUser('sub') repId: string) {
    return this.repDraftsService.findOneSanitized(id, repId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a draft (items, customer, notes, expected delivery date)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpsertDraftDto,
    @CurrentUser('sub') repId: string,
  ) {
    return this.repDraftsService.update(id, repId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a draft' })
  remove(@Param('id') id: string, @CurrentUser('sub') repId: string) {
    return this.repDraftsService.remove(id, repId);
  }
}
