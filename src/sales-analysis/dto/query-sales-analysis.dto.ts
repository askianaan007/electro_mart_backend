import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QuerySalesAnalysisDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Start of date range (inclusive), matches Order.completedAt' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (exclusive), matches Order.completedAt' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Filter by dealer' })
  @IsOptional()
  @IsUUID()
  dealerId?: string;
}
