import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChequeFlowStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export class UpdateChequeFlowStatusDto {
  @ApiProperty({ enum: ChequeFlowStatus })
  @IsEnum(ChequeFlowStatus)
  status: ChequeFlowStatus;

  @ApiPropertyOptional({
    description: 'The day the bank cleared it — required for CLEARED',
  })
  @IsOptional()
  @IsDateString()
  clearedDate?: string;
}
