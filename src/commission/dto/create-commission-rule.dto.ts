import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommissionType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateCommissionRuleDto {
  @ApiProperty({ enum: CommissionType })
  @IsEnum(CommissionType)
  type: CommissionType;

  @ApiProperty({
    description:
      'Percentage (0-100) if type is PERCENTAGE, or a fixed currency amount if type is FIXED',
  })
  @IsNumber()
  @Min(0)
  value: number;

  @ApiProperty()
  @IsDateString()
  startDate: string;

  @ApiPropertyOptional({
    description: 'Leave unset for the standing/default rule',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isCampaign?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  campaignName?: string;
}
