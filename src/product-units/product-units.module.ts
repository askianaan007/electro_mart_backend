import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsController } from './product-units.controller';
import { ProductUnitsService } from './product-units.service';
import { SerialLifecycleService } from './serial-lifecycle.service';

// Deliberately does NOT import InventoryModule (Bar_code_plan.md rule 9):
// nothing in this module can move stock.
@Module({
  imports: [ActivityLogModule],
  providers: [ProductUnitsService, SerialLifecycleService],
  controllers: [ProductUnitsController],
  exports: [ProductUnitsService, SerialLifecycleService],
})
export class ProductUnitsModule {}
