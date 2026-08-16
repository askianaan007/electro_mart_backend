import { Module } from '@nestjs/common';
import { CreditBalanceService } from './credit-balance.service';
import { CreditBalanceController } from './credit-balance.controller';

@Module({
  providers: [CreditBalanceService],
  controllers: [CreditBalanceController],
  exports: [CreditBalanceService],
})
export class CreditBalanceModule {}
