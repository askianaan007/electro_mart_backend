import { ApiPropertyOptional } from '@nestjs/swagger';
import { ChequeStatus, PaymentMode } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export const PAYMENT_SORT_VALUES = ['createdAt', 'chequeDate'] as const;
export type PaymentSortBy = (typeof PAYMENT_SORT_VALUES)[number];

export class QueryPaymentDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional()
  @IsEnum(PaymentMode)
  mode?: PaymentMode;

  @ApiPropertyOptional({
    enum: ChequeStatus,
    description: 'Filter cheque payments by status',
  })
  @IsOptional()
  @IsEnum(ChequeStatus)
  chequeStatus?: ChequeStatus;

  @ApiPropertyOptional({ description: 'Admin only: filter by invoice' })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

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

  @ApiPropertyOptional({
    enum: PAYMENT_SORT_VALUES,
    description:
      "Default 'createdAt' (most recently recorded first). 'chequeDate' sorts pending cheques by soonest deposit date first — for upcoming-deposit views.",
  })
  @IsOptional()
  @IsIn(PAYMENT_SORT_VALUES)
  sortBy?: PaymentSortBy;
}
