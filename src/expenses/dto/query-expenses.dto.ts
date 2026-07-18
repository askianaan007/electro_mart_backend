import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryExpensesDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Start of date range (inclusive), matches Expense.expenseDate',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (inclusive), matches Expense.expenseDate',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
