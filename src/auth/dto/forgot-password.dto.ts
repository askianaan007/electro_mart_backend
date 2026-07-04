import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ description: 'Email for admin, username for dealer' })
  @IsString()
  identifier: string;

  @ApiProperty({ enum: Role })
  @IsEnum(Role)
  role: Role;
}
