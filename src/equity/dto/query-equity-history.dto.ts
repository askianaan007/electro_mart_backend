import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryEquityHistoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['INVESTMENT', 'WITHDRAWAL', 'EXPENSE'] })
  @IsOptional()
  @IsIn(['INVESTMENT', 'WITHDRAWAL', 'EXPENSE'])
  type?: 'INVESTMENT' | 'WITHDRAWAL' | 'EXPENSE';

  @ApiPropertyOptional({
    description:
      'Only investment/withdrawal rows for this investor (expenses have no investor)',
  })
  @IsOptional()
  @IsUUID()
  investorId?: string;

  @ApiPropertyOptional({ description: 'Start of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (inclusive)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
