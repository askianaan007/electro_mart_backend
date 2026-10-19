import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ReverseSettlementPaymentDto {
  @ApiProperty({ description: 'Why the payout is being reversed' })
  @IsString()
  @MinLength(3)
  reason: string;
}
