import { Module } from '@nestjs/common';
import { LiquidCashModule } from '../liquid-cash/liquid-cash.module';
import { InvestmentsService } from './investments.service';
import { InvestmentsController } from './investments.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';

@Module({
  imports: [ActivityLogModule, LiquidCashModule],
  providers: [InvestmentsService],
  controllers: [InvestmentsController],
  exports: [InvestmentsService],
})
export class InvestmentsModule {}
