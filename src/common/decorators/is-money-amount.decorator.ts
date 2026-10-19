import { applyDecorators } from '@nestjs/common';
import { IsNumber, Max, Min } from 'class-validator';

/** Largest amount accepted anywhere money is entered — guards against typos like an extra five zeros. */
export const MAX_MONEY_AMOUNT = 1_000_000_000;

/**
 * A positive money amount in rupees and cents: at most two decimal places,
 * so a value like 0.1 + 0.2 = 0.30000000000000004 from a client can't be
 * stored as a sub-cent fraction (LC-23). Amounts are stored as Decimal.
 */
export function IsMoneyAmount(options: { min?: number } = {}) {
  return applyDecorators(
    IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }),
    Min(options.min ?? 0.01),
    Max(MAX_MONEY_AMOUNT),
  );
}
