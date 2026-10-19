import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';

@Module({
  imports: [ActivityLogModule],
  providers: [RefundsService],
  controllers: [RefundsController],
  exports: [RefundsService],
})
export class RefundsModule {}
