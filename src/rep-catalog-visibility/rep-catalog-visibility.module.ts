import { Module } from '@nestjs/common';
import { RepCatalogVisibilityService } from './rep-catalog-visibility.service';

@Module({
  providers: [RepCatalogVisibilityService],
  exports: [RepCatalogVisibilityService],
})
export class RepCatalogVisibilityModule {}
