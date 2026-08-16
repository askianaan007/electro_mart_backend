import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateCollectionDto {
  @ApiProperty()
  @IsUUID()
  customerId: string;

  @ApiPropertyOptional({
    description: 'The specific invoice this collection is against, if known',
  })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

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

  @ApiProperty()
  @IsDateString()
  collectionDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'URL of an already-uploaded photo of the cheque, if mode is CHEQUE',
  })
  @IsOptional()
  @IsString()
  chequeImageUrl?: string;
}
