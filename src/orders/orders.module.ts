import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [InventoryModule, ActivityLogModule, ProductUnitsModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
