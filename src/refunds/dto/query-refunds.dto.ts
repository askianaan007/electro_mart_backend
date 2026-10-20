import { ApiPropertyOptional } from '@nestjs/swagger';
import { RefundParty } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryRefundsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RefundParty })
  @IsOptional()
  @IsEnum(RefundParty)
  party?: RefundParty;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  dealerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  purchaseId?: string;
}
