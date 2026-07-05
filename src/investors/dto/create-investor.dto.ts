import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateInvestorDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description: 'This investor\'s share of profit/expense distribution, as a percentage',
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  profitSharePercentage: number;
}
