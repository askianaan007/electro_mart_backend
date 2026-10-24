import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class UpdatePaymentDto {
  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiProperty()
  @IsDateString()
  paymentDate: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  chequeNumber?: string;

  @ApiPropertyOptional({
    description:
      'Required when mode is CHEQUE: the date printed on the cheque (may be post-dated)',
  })
  @IsOptional()
  @IsDateString()
  chequeDate?: string;

  @ApiPropertyOptional({
    description:
      'Required when mode is CHEQUE: the date the cheque was physically collected from the dealer',
  })
  @IsOptional()
  @IsDateString()
  collectedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({
    description:
      "Accept an amount above what's due on the invoice: the excess goes to the dealer's wallet for later purchases",
  })
  @IsOptional()
  @IsBoolean()
  excessToWallet?: boolean;
}
