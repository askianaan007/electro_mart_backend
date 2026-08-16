import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RejectCollectionDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  reason: string;
}
