import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export type CreditBalanceEntryType =
  | 'PURCHASE'
  | 'TRANSPORT_CHARGE'
  | 'PURCHASE_RETURN'
  | 'RETURN_REPLACEMENT'
  | 'SETTLEMENT';

const ENTRY_TYPES: CreditBalanceEntryType[] = [
  'PURCHASE',
  'TRANSPORT_CHARGE',
  'PURCHASE_RETURN',
  'RETURN_REPLACEMENT',
  'SETTLEMENT',
];

export class QueryCreditBalanceHistoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ENTRY_TYPES })
  @IsOptional()
  @IsIn(ENTRY_TYPES)
  type?: CreditBalanceEntryType;

  @ApiPropertyOptional({ description: 'Start of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
