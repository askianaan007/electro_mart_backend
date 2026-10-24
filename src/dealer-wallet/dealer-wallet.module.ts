import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DealerWalletService } from './dealer-wallet.service';
import { DealerWalletController } from './dealer-wallet.controller';

@Module({
  imports: [ActivityLogModule],
  providers: [DealerWalletService],
  controllers: [DealerWalletController],
  exports: [DealerWalletService],
})
export class DealerWalletModule {}
