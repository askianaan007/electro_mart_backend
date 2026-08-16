import { Module } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [ActivityLogModule, UploadsModule],
  providers: [BrandsService],
  controllers: [BrandsController],
  exports: [BrandsService],
})
export class BrandsModule {}
