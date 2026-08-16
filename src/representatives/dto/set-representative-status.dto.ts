import { ApiProperty } from '@nestjs/swagger';
import { RepresentativeStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class SetRepresentativeStatusDto {
  @ApiProperty({ enum: RepresentativeStatus })
  @IsEnum(RepresentativeStatus)
  status: RepresentativeStatus;
}
