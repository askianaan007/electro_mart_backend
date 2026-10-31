import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const MAX_IMPORT_ROWS = 2000;

/**
 * One spreadsheet row after column mapping. Deliberately loose (strings or
 * numbers as the sheet had them): each row is checked on its own and reported
 * back, so one bad row never rejects the whole file.
 */
export class ChequeFlowImportRowDto {
  @ApiPropertyOptional({ description: 'Sheet row number, echoed back' })
  @IsOptional()
  @IsInt()
  sourceRow?: number;

  @ApiProperty({ description: 'RECEIVABLE or PAYABLE' })
  @Allow()
  direction: unknown;

  @Allow()
  chequeNumber?: unknown;

  @Allow()
  bankName?: unknown;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @Allow()
  chequeDate?: unknown;

  @Allow()
  partyName?: unknown;

  @Allow()
  invoiceRef?: unknown;

  @Allow()
  amount?: unknown;

  @ApiPropertyOptional({
    description: 'Pass / Pending / Bounced / Cancelled …',
  })
  @Allow()
  status?: unknown;

  @Allow()
  clearedDate?: unknown;

  @Allow()
  remarks?: unknown;
}

export class PreviewChequeFlowImportDto {
  @ApiProperty({ type: [ChequeFlowImportRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IMPORT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ChequeFlowImportRowDto)
  rows: ChequeFlowImportRowDto[];

  @ApiPropertyOptional({
    description:
      'Imported CLEARED rows without a cleared date take their cheque date',
  })
  @IsOptional()
  @IsBoolean()
  clearedOnChequeDate?: boolean;
}

export class CommitChequeFlowImportDto extends PreviewChequeFlowImportDto {
  @ApiProperty({
    description: 'A fresh UUID per import — a resend returns the first result',
  })
  @IsUUID()
  importKey: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fileName: string;

  @ApiPropertyOptional({
    description: 'The column mapping used, kept for audit',
  })
  @IsOptional()
  @IsObject()
  mapping?: Record<string, unknown>;
}
