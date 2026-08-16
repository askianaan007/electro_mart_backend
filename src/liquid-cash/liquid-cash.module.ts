import { Module } from '@nestjs/common';
import { LiquidCashService } from './liquid-cash.service';
import { LiquidCashController } from './liquid-cash.controller';

@Module({
  providers: [LiquidCashService],
  controllers: [LiquidCashController],
  exports: [LiquidCashService],
})
export class LiquidCashModule {}
