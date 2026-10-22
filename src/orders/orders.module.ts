import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';
import { DealerWalletModule } from '../dealer-wallet/dealer-wallet.module';

@Module({
  imports: [
    InventoryModule,
    ActivityLogModule,
    ProductUnitsModule,
    DealerWalletModule,
  ],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
