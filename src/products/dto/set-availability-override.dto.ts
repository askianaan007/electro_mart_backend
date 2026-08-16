import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SetAvailabilityOverrideDto {
  @ApiProperty({
    description:
      'true = always show "In Stock" to representatives regardless of currentStock; false = always show "Out of Stock"',
  })
  @IsBoolean()
  forceAvailable: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
