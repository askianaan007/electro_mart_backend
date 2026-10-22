import { MODULE_METADATA } from '@nestjs/common/constants';
import { InventoryModule } from '../inventory/inventory.module';
import { InventoryService } from '../inventory/inventory.service';
import { ProductUnitsModule } from './product-units.module';
import { ProductUnitsService } from './product-units.service';
import { SerialLifecycleService } from './serial-lifecycle.service';

// Bar_code_plan.md rule 9 / test 22: serial code must not be able to move stock.
describe('ProductUnitsModule', () => {
  it('does not import the inventory module or provide InventoryService', () => {
    const imports = (Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ProductUnitsModule,
    ) ?? []) as unknown[];
    const providers = (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ProductUnitsModule,
    ) ?? []) as unknown[];
    expect(imports).not.toContain(InventoryModule);
    expect(providers).not.toContain(InventoryService);
  });

  it('services do not depend on InventoryService', () => {
    for (const service of [ProductUnitsService, SerialLifecycleService]) {
      const deps = (Reflect.getMetadata('design:paramtypes', service) ??
        []) as unknown[];
      expect(deps).not.toContain(InventoryService);
    }
  });
});
