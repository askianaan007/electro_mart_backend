import { Module } from '@nestjs/common';
import { EquityService } from './equity.service';
import { EquityController } from './equity.controller';
import { SalesAnalysisModule } from '../sales-analysis/sales-analysis.module';

@Module({
  imports: [SalesAnalysisModule],
  providers: [EquityService],
  controllers: [EquityController],
})
export class EquityModule {}
