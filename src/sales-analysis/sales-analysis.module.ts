import { Module } from '@nestjs/common';
import { SalesAnalysisService } from './sales-analysis.service';
import { SalesAnalysisController } from './sales-analysis.controller';

@Module({
  providers: [SalesAnalysisService],
  controllers: [SalesAnalysisController],
  exports: [SalesAnalysisService],
})
export class SalesAnalysisModule {}
