import { Module } from '@nestjs/common';
import { PurchaseReturnsService } from './purchase-returns.service';
import {
  PurchaseReturnsController,
  ReplacementReceiptsController,
} from './purchase-returns.controller';
import { ReplacementReceiptsService } from './replacement-receipts.service';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

@Module({
  imports: [InventoryModule, ActivityLogModule],
  providers: [PurchaseReturnsService, ReplacementReceiptsService],
  controllers: [PurchaseReturnsController, ReplacementReceiptsController],
  exports: [PurchaseReturnsService],
})
export class PurchaseReturnsModule {}
