import { Module } from '@nestjs/common';
import { RepresentativesService } from './representatives.service';
import { RepresentativesController } from './representatives.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { RepActivityLogModule } from '../rep-activity-log/rep-activity-log.module';

@Module({
  imports: [ActivityLogModule, RepActivityLogModule],
  providers: [RepresentativesService],
  controllers: [RepresentativesController],
  exports: [RepresentativesService],
})
export class RepresentativesModule {}
