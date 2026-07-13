import { Module } from '@nestjs/common';
import { InvestorsService } from './investors.service';
import { InvestorsController } from './investors.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';

@Module({
  imports: [ActivityLogModule],
  providers: [InvestorsService],
  controllers: [InvestorsController],
  exports: [InvestorsService],
})
export class InvestorsModule {}
