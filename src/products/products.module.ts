import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [ActivityLogModule, InventoryModule],
  providers: [ProductsService],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule {}
