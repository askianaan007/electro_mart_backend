import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [ActivityLogModule, ProductUnitsModule],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
export class InventoryModule {}
