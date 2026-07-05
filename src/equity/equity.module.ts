import { Module } from '@nestjs/common';
import { EquityService } from './equity.service';
import { EquityController } from './equity.controller';

@Module({
  providers: [EquityService],
  controllers: [EquityController],
})
export class EquityModule {}
