import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode, ChequeStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsIn, IsOptional } from 'class-validator';
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

  @ApiPropertyOptional({
    enum: ['paymentDate', 'chequeDepositDate'],
    description: 'Field to sort by. Defaults to paymentDate.',
  })
  @IsOptional()
  @IsIn(['paymentDate', 'chequeDepositDate'])
  sortBy?: 'paymentDate' | 'chequeDepositDate';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Sort direction. Defaults to desc.' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
