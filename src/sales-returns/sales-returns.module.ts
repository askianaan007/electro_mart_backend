import { Module } from '@nestjs/common';
import { SalesReturnsService } from './sales-returns.service';
import { SalesReturnsController } from './sales-returns.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [InventoryModule, ActivityLogModule, ProductUnitsModule],
  providers: [SalesReturnsService],
  controllers: [SalesReturnsController],
  exports: [SalesReturnsService],
})
export class SalesReturnsModule {}
