import { Module } from '@nestjs/common';
import { BannersService } from './banners.service';
import { BannersController } from './banners.controller';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [ActivityLogModule, UploadsModule],
  providers: [BannersService],
  controllers: [BannersController],
  exports: [BannersService],
})
export class BannersModule {}
