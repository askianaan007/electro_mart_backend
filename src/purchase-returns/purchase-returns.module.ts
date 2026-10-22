import { Module } from '@nestjs/common';
import { PurchaseReturnsService } from './purchase-returns.service';
import { PurchaseReturnsController } from './purchase-returns.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [InventoryModule, ActivityLogModule, ProductUnitsModule],
  providers: [PurchaseReturnsService],
  controllers: [PurchaseReturnsController],
  exports: [PurchaseReturnsService],
})
export class PurchaseReturnsModule {}
