import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryOrderDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Admin only: filter by dealer' })
  @IsOptional()
  @IsUUID()
  dealerId?: string;

  @ApiPropertyOptional({
    description: 'Start of date range (inclusive), matches Order.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (exclusive), matches Order.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
