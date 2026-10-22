import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { CreditsModule } from '../credits/credits.module';
import { SalesAnalysisModule } from '../sales-analysis/sales-analysis.module';
import { LiquidCashModule } from '../liquid-cash/liquid-cash.module';
import { CreditBalanceModule } from '../credit-balance/credit-balance.module';

@Module({
  imports: [
    CreditsModule,
    SalesAnalysisModule,
    LiquidCashModule,
    CreditBalanceModule,
  ],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
