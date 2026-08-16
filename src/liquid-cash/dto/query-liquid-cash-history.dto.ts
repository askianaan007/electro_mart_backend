import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export type LiquidCashEntryType =
  | 'INVESTMENT'
  | 'DEALER_PAYMENT'
  | 'SUPPLIER_PAYMENT'
  | 'EXPENSE';

const ENTRY_TYPES: LiquidCashEntryType[] = [
  'INVESTMENT',
  'DEALER_PAYMENT',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
];

export class QueryLiquidCashHistoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ENTRY_TYPES })
  @IsOptional()
  @IsIn(ENTRY_TYPES)
  type?: LiquidCashEntryType;

  @ApiPropertyOptional({ description: 'Start of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
