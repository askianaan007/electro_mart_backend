import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  NotEquals,
} from 'class-validator';
import { MAX_MONEY_AMOUNT } from '../../common/decorators/is-money-amount.decorator';

export class CreateInvestmentDto {
  @ApiProperty()
  @IsUUID()
  investorId: string;

  @ApiProperty({
    description:
      'Positive for a contribution, negative for a withdrawal; never zero, at most 2 decimal places',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @NotEquals(0)
  @Min(-MAX_MONEY_AMOUNT)
  @Max(MAX_MONEY_AMOUNT)
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ description: 'When the money moved — not in the future' })
  @IsDateString()
  investmentDate: string;

  @ApiProperty()
  @IsString()
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  chequeNumber?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({
    description: 'Required when mode is CHEQUE: the date on the cheque',
  })
  @IsOptional()
  @IsDateString()
  chequeDate?: string;
}
