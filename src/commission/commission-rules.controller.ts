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
import { CommissionRulesService } from './commission-rules.service';
import { CreateCommissionRuleDto } from './dto/create-commission-rule.dto';
import { UpdateCommissionRuleDto } from './dto/update-commission-rule.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// Mounted at products/:id/commission-rules per version2_changes_backend.md
// §9.5 — deliberately a separate controller (not added to ProductsController)
// since it lives in src/commission/ per §9.4, but the route shape matches.
@ApiTags('Commission Rules')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('products/:productId/commission-rules')
export class CommissionRulesController {
  constructor(private commissionRulesService: CommissionRulesService) {}

  @Get()
  @ApiOperation({ summary: "List a product's commission rules" })
  findAll(@Param('productId') productId: string) {
    return this.commissionRulesService.findAll(productId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a commission rule for a product' })
  create(
    @Param('productId') productId: string,
    @Body() dto: CreateCommissionRuleDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.commissionRulesService.create(productId, dto, adminId);
  }

  @Patch(':ruleId')
  @ApiOperation({ summary: 'Update a commission rule' })
  update(
    @Param('productId') productId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateCommissionRuleDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.commissionRulesService.update(productId, ruleId, dto, adminId);
  }

  @Delete(':ruleId')
  @ApiOperation({
    summary:
      'Delete a commission rule (blocked if any ledger entry references it)',
  })
  remove(
    @Param('productId') productId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.commissionRulesService.remove(productId, ruleId, adminId);
  }
}
