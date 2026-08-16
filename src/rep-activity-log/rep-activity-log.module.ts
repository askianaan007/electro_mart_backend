import { Module } from '@nestjs/common';
import { RepActivityLogService } from './rep-activity-log.service';

@Module({
  providers: [RepActivityLogService], 
  exports: [RepActivityLogService],
})
export class RepActivityLogModule {}
