import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class CreateSettlementDto {
  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiPropertyOptional({ description: 'Cheque number or transfer reference' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty()
  @IsDateString()
  paymentDate: string;

  @ApiPropertyOptional({
    description:
      'Required when mode is CHEQUE: the date the cheque is/was deposited',
  })
  @IsOptional()
  @IsDateString()
  chequeDepositDate?: string;

  @ApiPropertyOptional({
    description: 'Cheque settlements: the bank the cheque is drawn on',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({
    description:
      'Set after the server reported a POSSIBLE_DUPLICATE, to record an identical settlement on purpose',
  })
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;
}
