import { Module } from '@nestjs/common';
import { EquityModule } from '../equity/equity.module';
import { InvestmentsService } from './investments.service';
import { InvestmentsController } from './investments.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';

@Module({
  imports: [ActivityLogModule, EquityModule],
  providers: [InvestmentsService],
  controllers: [InvestmentsController],
  exports: [InvestmentsService],
})
export class InvestmentsModule {}
