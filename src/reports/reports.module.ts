import { Module } from '@nestjs/common';
import { RepReportsService } from './rep-reports.service';
import { RepReportsController } from './rep-reports.controller';

@Module({
  providers: [RepReportsService],
  controllers: [RepReportsController],
})
export class ReportsModule {}
