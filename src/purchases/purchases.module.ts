import { Module } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { PurchasesController } from './purchases.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { PurchaseReturnsModule } from '../purchase-returns/purchase-returns.module';

@Module({
  imports: [InventoryModule, ActivityLogModule, PurchaseReturnsModule],
  providers: [PurchasesService],
  controllers: [PurchasesController],
  exports: [PurchasesService],
})
export class PurchasesModule {}
