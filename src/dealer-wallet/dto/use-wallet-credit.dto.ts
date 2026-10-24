import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsMoneyAmount } from '../../common/decorators/is-money-amount.decorator';

export class UseWalletCreditDto {
  @ApiProperty({ minimum: 0.01 })
  @IsMoneyAmount()
  amount: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
