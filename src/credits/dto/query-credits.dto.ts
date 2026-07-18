import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryCreditsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'Only include suppliers with an outstanding (positive) credit balance',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  onlyOutstanding?: string;
}
