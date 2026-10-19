import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ReverseCashAdjustmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(5)
  reason: string;

  @ApiProperty({ description: "The admin's own password, to confirm" })
  @IsString()
  password: string;
}
