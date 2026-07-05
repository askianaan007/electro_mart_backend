import { Module } from '@nestjs/common';
import { InvestorsService } from './investors.service';
import { InvestorsController } from './investors.controller';

@Module({
  providers: [InvestorsService],
  controllers: [InvestorsController],
  exports: [InvestorsService],
})
export class InvestorsModule {}
