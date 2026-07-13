import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryInventoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['IN_STOCK', 'OUT_OF_STOCK'] })
  @IsOptional()
  @IsIn(['IN_STOCK', 'OUT_OF_STOCK'])
  status?: 'IN_STOCK' | 'OUT_OF_STOCK';
}
