import { ApiPropertyOptional } from '@nestjs/swagger';
import { ChequeFlowDirection, ChequeFlowStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Accepts ?status=PENDING,CLEARED or repeated ?status= params. */
const toList = ({ value }: { value: unknown }) =>
  (Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  )
    .map((v) => String(v).trim())
    .filter(Boolean);

export const CHEQUE_FLOW_SOURCES = [
  'MANUAL',
  'PAYMENT',
  'SETTLEMENT',
  'REFUND',
] as const;

export class ChequeFlowFiltersDto {
  @ApiPropertyOptional({
    enum: CHEQUE_FLOW_SOURCES,
    description:
      'Where the cheque was recorded: MANUAL (this page), PAYMENT (Payments), SETTLEMENT (Credits), REFUND (Refunds)',
  })
  @IsOptional()
  @IsIn(CHEQUE_FLOW_SOURCES)
  source?: (typeof CHEQUE_FLOW_SOURCES)[number];

  @ApiPropertyOptional({ enum: ChequeFlowDirection })
  @IsOptional()
  @IsEnum(ChequeFlowDirection)
  direction?: ChequeFlowDirection;

  @ApiPropertyOptional({
    enum: ChequeFlowStatus,
    isArray: true,
    description: 'Comma-separated',
  })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(ChequeFlowStatus, { each: true })
  status?: ChequeFlowStatus[];

  @ApiPropertyOptional({ description: 'Bank name (any case/spacing)' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bank?: string;

  @ApiPropertyOptional({
    description: 'Customer name — filters customer cheques only',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customer?: string;

  @ApiPropertyOptional({
    description: 'Supplier name — filters supplier cheques only',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string;

  @ApiPropertyOptional({
    description: 'Cheque no., name, bank, invoice ref or remarks',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class QueryChequeFlowDto extends ChequeFlowFiltersDto {
  @ApiPropertyOptional({
    example: '2026-10',
    description: 'Omit for all months',
  })
  @IsOptional()
  @Matches(MONTH, { message: 'month must look like 2026-10' })
  month?: string;
}

export class QueryChequeFlowMonthlyDto extends ChequeFlowFiltersDto {
  @ApiPropertyOptional({ example: '2026-05' })
  @IsOptional()
  @Matches(MONTH, { message: 'from must look like 2026-05' })
  from?: string;

  @ApiPropertyOptional({ example: '2027-04' })
  @IsOptional()
  @Matches(MONTH, { message: 'to must look like 2027-04' })
  to?: string;
}
