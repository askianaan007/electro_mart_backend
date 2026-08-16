import { ApiPropertyOptional } from '@nestjs/swagger';
import { RepresentativeStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class QueryRepresentativeDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RepresentativeStatus })
  @IsOptional()
  @IsEnum(RepresentativeStatus)
  status?: RepresentativeStatus;
}
