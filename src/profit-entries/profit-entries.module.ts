import { Module } from '@nestjs/common';
import { ProfitEntriesService } from './profit-entries.service';
import { ProfitEntriesController } from './profit-entries.controller';

@Module({
  providers: [ProfitEntriesService],
  controllers: [ProfitEntriesController],
  exports: [ProfitEntriesService],
})
export class ProfitEntriesModule {}
