import { Module } from '@nestjs/common';
import { DealersService } from './dealers.service';
import { DealersController } from './dealers.controller';

@Module({
  providers: [DealersService],
  controllers: [DealersController],
  exports: [DealersService],
})
export class DealersModule {}
