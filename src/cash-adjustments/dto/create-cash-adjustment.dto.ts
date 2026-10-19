import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';
import { MAX_MONEY_AMOUNT } from '../../common/decorators/is-money-amount.decorator';

export class CreateCashAdjustmentDto {
  @ApiProperty({
    enum: ['OPENING_BALANCE', 'ADJUSTMENT'],
    description:
      'OPENING_BALANCE: verified cash on hand when record-keeping began (one at a time, dated on/before the first entry). ADJUSTMENT: a counted / bank-verified correction.',
  })
  @IsIn(['OPENING_BALANCE', 'ADJUSTMENT'])
  type: 'OPENING_BALANCE' | 'ADJUSTMENT';

  @ApiProperty({
    description:
      'Positive adds to Liquid Cash, negative takes from it; never zero',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @NotEquals(0)
  @Min(-MAX_MONEY_AMOUNT)
  @Max(MAX_MONEY_AMOUNT)
  amount: number;

  @ApiProperty({
    description: 'Date the figure applies to — not in the future',
  })
  @IsDateString()
  adjustmentDate: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  reason: string;

  @ApiProperty({
    description:
      'Cash-count sheet number, bank statement reference or similar evidence for the figure',
  })
  @IsString()
  @MinLength(3)
  evidenceReference: string;

  @ApiProperty({ description: "The admin's own password, to confirm" })
  @IsString()
  password: string;
}
