import { Module } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';
import { CollectionRemindersService } from './collection-reminders.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { MailerModule } from '../mailer/mailer.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [ActivityLogModule, MailerModule, PaymentsModule],
  providers: [CollectionsService, CollectionRemindersService],
  controllers: [CollectionsController],
})
export class CollectionsModule {}
