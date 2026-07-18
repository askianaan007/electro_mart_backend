import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryActivityLogDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'One or more comma-separated action codes, e.g. RECORDED_EXPENSE or RECORDED_EXPENSE,UPDATED_EXPENSE',
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    description: 'Filter by the admin who performed the action',
  })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({
    description:
      'Start of date range (inclusive), matches ActivityLog.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (inclusive), matches ActivityLog.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
