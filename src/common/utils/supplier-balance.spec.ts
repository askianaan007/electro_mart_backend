import { Prisma } from '@prisma/client';
import { supplierBalance } from './supplier-balance';

const d = (n: number) => new Prisma.Decimal(n);

describe('supplierBalance', () => {
  it('= purchases − returns + replacements − settled − transport + refunds received', () => {
    expect(
      supplierBalance({
        purchases: d(10_000),
        returns: d(1_500),
        replacements: d(1_000),
        settled: d(6_000),
        transportCharges: d(250),
        refundsReceived: d(100),
      }).toNumber(),
    ).toBe(3_350);
  });
});
