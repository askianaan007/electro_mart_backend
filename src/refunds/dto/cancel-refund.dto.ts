import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CancelRefundDto {
  @ApiProperty({ description: 'Why the refund is being cancelled' })
  @IsString()
  @MinLength(3)
  reason: string;
}
