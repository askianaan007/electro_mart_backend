import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode, RefundParty } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class CreateRefundDto {
  @ApiProperty({
    enum: RefundParty,
    description:
      'DEALER: we pay a dealer back their credit (cash out). SUPPLIER: a supplier pays back what they owe us (cash in).',
  })
  @IsEnum(RefundParty)
  party: RefundParty;

  @ApiPropertyOptional({ description: 'Required when party is DEALER' })
  @ValidateIf((o: CreateRefundDto) => o.party === 'DEALER')
  @IsUUID()
  dealerId?: string;

  @ApiPropertyOptional({ description: 'Required when party is SUPPLIER' })
  @ValidateIf((o: CreateRefundDto) => o.party === 'SUPPLIER')
  @IsUUID()
  supplierId?: string;

  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  mode: PaymentMode;

  @ApiProperty({ description: 'When the money moved — not in the future' })
  @IsDateString()
  refundDate: string;

  @ApiProperty({ description: 'Why the refund is being made' })
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
      'Set after the server reported a POSSIBLE_DUPLICATE, to record an identical refund on purpose',
  })
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;
}
