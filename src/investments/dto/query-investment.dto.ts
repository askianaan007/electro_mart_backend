import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryInvestmentDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by investor' })
  @IsOptional()
  @IsUUID()
  investorId?: string;

  @ApiPropertyOptional({
    enum: ['DEPOSIT', 'WITHDRAWAL'],
    description:
      'Filter by whether the amount is a contribution (positive) or a withdrawal (negative)',
  })
  @IsOptional()
  @IsIn(['DEPOSIT', 'WITHDRAWAL'])
  type?: 'DEPOSIT' | 'WITHDRAWAL';
}
