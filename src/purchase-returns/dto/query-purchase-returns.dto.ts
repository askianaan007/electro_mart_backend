import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryPurchaseReturnsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by supplier' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true: only returns tied to a purchase; false: only standalone returns',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  linked?: 'true' | 'false';

  @ApiPropertyOptional({
    description:
      'Start of date range (inclusive), matches PurchaseReturn.returnDate',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description:
      'End of date range (inclusive), matches PurchaseReturn.returnDate',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
