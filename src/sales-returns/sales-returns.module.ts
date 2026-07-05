import { Module } from '@nestjs/common';
import { SalesReturnsService } from './sales-returns.service';
import { SalesReturnsController } from './sales-returns.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

@Module({
  imports: [InventoryModule, ActivityLogModule],
  providers: [SalesReturnsService],
  controllers: [SalesReturnsController],
  exports: [SalesReturnsService],
})
export class SalesReturnsModule {}
