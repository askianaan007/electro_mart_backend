import { Module } from '@nestjs/common';
import { DealersService } from './dealers.service';
import { DealersController } from './dealers.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [ActivityLogModule, InventoryModule, ProductUnitsModule],
  providers: [DealersService],
  controllers: [DealersController],
  exports: [DealersService],
})
export class DealersModule {}
