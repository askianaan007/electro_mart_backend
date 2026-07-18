import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DealerLoginDto {
  @ApiProperty({ example: 'jrt_enterprise' })
  @IsString()
  username: string;

  @ApiProperty({ example: 'dealerpassword' })
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;
}
