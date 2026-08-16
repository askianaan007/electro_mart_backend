import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RepresentativeStatus } from '@prisma/client';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRepresentativeDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  phone: string;

  @ApiProperty({ description: 'Also becomes the login username' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ description: 'NIC or Employee ID' })
  @IsOptional()
  @IsString()
  nicOrEmployeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  joiningDate?: string;

  @ApiPropertyOptional({
    description: 'Leave blank to auto-generate a temporary password',
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password?: string;

  @ApiPropertyOptional({
    enum: RepresentativeStatus,
    default: RepresentativeStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(RepresentativeStatus)
  status?: RepresentativeStatus;
}
