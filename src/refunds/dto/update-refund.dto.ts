import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

/**
 * Corrects a refund's details. The party can't change — cancel the refund
 * and record a new one for that. Omitting purchaseId unlinks the refund from
 * its order.
 */
export class UpdateRefundDto {
  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ description: 'When the money moved — not in the future' })
  @IsDateString()
  refundDate: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  chequeNumber?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({ description: 'Required when mode is CHEQUE' })
  @IsOptional()
  @IsDateString()
  chequeDate?: string;

  @ApiPropertyOptional({
    description:
      'Supplier refunds only: the order the refunded money was paid toward',
  })
  @IsOptional()
  @IsUUID()
  purchaseId?: string;
}
