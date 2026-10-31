import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ChequeFlowController } from './cheque-flow.controller';
import { ChequeFlowService } from './cheque-flow.service';

@Module({
  imports: [ActivityLogModule],
  providers: [ChequeFlowService],
  controllers: [ChequeFlowController],
})
export class ChequeFlowModule {}
