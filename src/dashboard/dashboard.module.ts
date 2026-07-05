import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { CreditsModule } from '../credits/credits.module';
import { SalesAnalysisModule } from '../sales-analysis/sales-analysis.module';

@Module({
  imports: [CreditsModule, SalesAnalysisModule],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
