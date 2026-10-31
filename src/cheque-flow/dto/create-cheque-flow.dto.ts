import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChequeFlowDirection, ChequeFlowStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class CreateChequeFlowDto {
  @ApiProperty({
    enum: ChequeFlowDirection,
    description: 'RECEIVABLE = customer cheque, PAYABLE = supplier cheque',
  })
  @IsEnum(ChequeFlowDirection)
  direction: ChequeFlowDirection;

  @ApiPropertyOptional({
    description: 'Text — leading zeros are kept',
    example: '000718',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  chequeNumber?: string;

  @ApiProperty({ example: 'BOC' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  bankName: string;

  @ApiProperty({ example: '2026-10-31' })
  @IsDateString()
  chequeDate: string;

  @ApiProperty({ description: 'Customer or supplier name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  partyName: string;

  @ApiPropertyOptional({ example: 'INV-2026-00046' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  invoiceRef?: string;

  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiPropertyOptional({
    enum: ChequeFlowStatus,
    default: ChequeFlowStatus.PENDING,
  })
  @IsOptional()
  @IsEnum(ChequeFlowStatus)
  status?: ChequeFlowStatus;

  @ApiPropertyOptional({ description: 'Required when the status is CLEARED' })
  @IsOptional()
  @IsDateString()
  clearedDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
