import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryInvestmentDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by investor' })
  @IsOptional()
  @IsUUID()
  investorId?: string;
}
