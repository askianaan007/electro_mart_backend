import { ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryLogType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryLedgerDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      'Start of date range (inclusive), matches InventoryLog.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description:
      'End of date range (exclusive), matches InventoryLog.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ enum: InventoryLogType })
  @IsOptional()
  @IsEnum(InventoryLogType)
  type?: InventoryLogType;
}
