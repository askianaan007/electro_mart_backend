import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryPurchasesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by supplier' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    description:
      'Start of date range (inclusive), matches Purchase.purchaseDate',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (inclusive), matches Purchase.purchaseDate',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
