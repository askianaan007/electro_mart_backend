import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ProductUnitsModule } from '../product-units/product-units.module';

@Module({
  imports: [ActivityLogModule, ProductUnitsModule],
  providers: [InvoicesService],
  controllers: [InvoicesController],
  exports: [InvoicesService],
})
export class InvoicesModule {}
