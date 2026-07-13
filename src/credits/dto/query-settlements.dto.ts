import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode, ChequeStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QuerySettlementsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional()
  @IsEnum(PaymentMode)
  mode?: PaymentMode;

  @ApiPropertyOptional({ enum: ChequeStatus })
  @IsOptional()
  @IsEnum(ChequeStatus)
  chequeStatus?: ChequeStatus;

  @ApiPropertyOptional({ description: 'Start of date range (inclusive), matches SupplierPayment.paymentDate' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'End of date range (inclusive), matches SupplierPayment.paymentDate' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
