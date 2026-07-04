import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class DealerLoginDto {
  @ApiProperty({ example: 'jrt_enterprise' })
  @IsString()
  username: string;

  @ApiProperty({ example: 'dealerpassword' })
  @IsString()
  @MinLength(6)
  password: string;
}
