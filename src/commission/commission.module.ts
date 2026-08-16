import { Module } from '@nestjs/common';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionRulesController } from './commission-rules.controller';
import { CommissionReconciliationService } from './commission-reconciliation.service';
import { SettlementsService } from './settlements.service';
import { CommissionController } from './commission.controller';
import { RepEarningsService } from './rep-earnings.service';
import { RepEarningsController } from './rep-earnings.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { MailerModule } from '../mailer/mailer.module';

@Module({
  imports: [ActivityLogModule, MailerModule],
  providers: [
    CommissionRulesService,
    CommissionReconciliationService,
    SettlementsService,
    RepEarningsService,
  ],
  controllers: [
    CommissionRulesController,
    CommissionController,
    RepEarningsController,
  ],
  exports: [SettlementsService],
})
export class CommissionModule {}
