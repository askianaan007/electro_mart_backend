import { Module } from '@nestjs/common';
import { BalanceSheetService } from './balance-sheet.service';
import { BalanceSheetController } from './balance-sheet.controller';
import { LiquidCashModule } from '../liquid-cash/liquid-cash.module';
import { CreditBalanceModule } from '../credit-balance/credit-balance.module';
import { EquityModule } from '../equity/equity.module';

@Module({
  imports: [LiquidCashModule, CreditBalanceModule, EquityModule],
  providers: [BalanceSheetService],
  controllers: [BalanceSheetController],
})
export class BalanceSheetModule {}
