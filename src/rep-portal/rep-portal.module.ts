import { Module } from '@nestjs/common';
import { RepCustomersService } from './rep-customers.service';
import { RepCustomersController } from './rep-customers.controller';
import { RepDraftsService } from './rep-drafts.service';
import { RepDraftsController } from './rep-drafts.controller';
import { RepOrdersService } from './rep-orders.service';
import { RepOrdersController } from './rep-orders.controller';
import { RepHomeService } from './rep-home.service';
import { RepHomeController } from './rep-home.controller';
import { RepCollectionsService } from './rep-collections.service';
import { RepCollectionsController } from './rep-collections.controller';
import { RepActivityLogModule } from '../rep-activity-log/rep-activity-log.module';
import { RepCatalogVisibilityModule } from '../rep-catalog-visibility/rep-catalog-visibility.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [RepActivityLogModule, RepCatalogVisibilityModule, OrdersModule],
  providers: [
    RepCustomersService,
    RepDraftsService,
    RepOrdersService,
    RepHomeService,
    RepCollectionsService,
  ],
  controllers: [
    RepCustomersController,
    RepDraftsController,
    RepOrdersController,
    RepHomeController,
    RepCollectionsController,
  ],
  exports: [RepOrdersService],
})
export class RepPortalModule {}
