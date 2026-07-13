import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryInvoiceDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Admin only: filter by dealer' })
  @IsOptional()
  @IsUUID()
  dealerId?: string;

  @ApiPropertyOptional({
    description: 'Start of date range (inclusive), matches Invoice.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (exclusive), matches Invoice.createdAt',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
