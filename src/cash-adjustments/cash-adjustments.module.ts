import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { CashAdjustmentsService } from './cash-adjustments.service';
import { CashAdjustmentsController } from './cash-adjustments.controller';

@Module({
  imports: [ActivityLogModule],
  providers: [CashAdjustmentsService],
  controllers: [CashAdjustmentsController],
})
export class CashAdjustmentsModule {}
