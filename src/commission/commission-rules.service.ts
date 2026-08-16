import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreateCommissionRuleDto } from './dto/create-commission-rule.dto';
import { UpdateCommissionRuleDto } from './dto/update-commission-rule.dto';
import { TRANSACTION_OPTIONS } from '../common/constants/prisma';

/**
 * Plain CRUD over CommissionRule (version2_changes_backend.md §9.4) — no
 * interaction with the order pipeline. Rule *resolution* (which rule applies
 * to a given commissioned line) happens only inside
 * CommissionReconciliationService, at read/compute time.
 */
@Injectable()
export class CommissionRulesService {
  constructor(
    private prisma: PrismaService,
    private activityLogService: ActivityLogService,
  ) {}

  private async assertProductExists(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async findAll(productId: string) {
    await this.assertProductExists(productId);
    return this.prisma.commissionRule.findMany({
      where: { productId },
      orderBy: { startDate: 'desc' },
    });
  }

  async create(
    productId: string,
    dto: CreateCommissionRuleDto,
    adminId: string,
  ) {
    const product = await this.assertProductExists(productId);

    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.commissionRule.create({
        data: {
          productId,
          type: dto.type,
          value: dto.value,
          startDate: new Date(dto.startDate),
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          isCampaign: dto.isCampaign ?? false,
          campaignName: dto.campaignName,
          createdByAdminId: adminId,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'CREATED_COMMISSION_RULE',
        targetId: rule.id,
        details: `Created a commission rule for product ${product.name}`,
      });

      return rule;
    }, TRANSACTION_OPTIONS);
  }

  async update(
    productId: string,
    ruleId: string,
    dto: UpdateCommissionRuleDto,
    adminId: string,
  ) {
    const rule = await this.prisma.commissionRule.findUnique({
      where: { id: ruleId },
    });
    if (!rule || rule.productId !== productId)
      throw new NotFoundException('Commission rule not found');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.commissionRule.update({
        where: { id: ruleId },
        data: {
          type: dto.type,
          value: dto.value,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          isCampaign: dto.isCampaign,
          campaignName: dto.campaignName,
        },
      });

      await this.activityLogService.log(tx, {
        adminId,
        action: 'UPDATED_COMMISSION_RULE',
        targetId: ruleId,
        details: `Updated a commission rule for product ${productId}`,
      });

      return updated;
    }, TRANSACTION_OPTIONS);
  }

  async remove(productId: string, ruleId: string, adminId: string) {
    const rule = await this.prisma.commissionRule.findUnique({
      where: { id: ruleId },
    });
    if (!rule || rule.productId !== productId)
      throw new NotFoundException('Commission rule not found');

    const referencingCount = await this.prisma.commissionLedgerEntry.count({
      where: { commissionRuleId: ruleId },
    });
    if (referencingCount > 0) {
      throw new ConflictException(
        `${referencingCount} commission ledger entr${referencingCount === 1 ? 'y' : 'ies'} already reference this rule and cannot be deleted — it can still be edited to close it out (set an endDate).`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.commissionRule.delete({ where: { id: ruleId } });
      await this.activityLogService.log(tx, {
        adminId,
        action: 'DELETED_COMMISSION_RULE',
        targetId: ruleId,
        details: `Deleted a commission rule for product ${productId}`,
      });
    }, TRANSACTION_OPTIONS);

    return { message: 'Commission rule deleted' };
  }
}
