import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryPaymentDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional()
  @IsEnum(PaymentMode)
  mode?: PaymentMode;

  @ApiPropertyOptional({ description: 'Admin only: filter by dealer' })
  @IsOptional()
  @IsUUID()
  dealerId?: string;

  @ApiPropertyOptional({
    description: 'Start of date range (inclusive), matches Payment.paymentDate',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    description: 'End of date range (exclusive), matches Payment.paymentDate',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
