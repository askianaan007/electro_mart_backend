import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
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

  @ApiPropertyOptional({ description: 'Start of date range (inclusive), matches Investment.investmentDate' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (inclusive), matches Investment.investmentDate' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
