import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class CreateExpenseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty()
  @IsDateString()
  expenseDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;
}
