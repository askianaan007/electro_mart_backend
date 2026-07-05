import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateSettlementDto {
  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
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
    description: 'Required when mode is CHEQUE: the date the cheque is/was deposited',
  })
  @IsOptional()
  @IsDateString()
  chequeDepositDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}
