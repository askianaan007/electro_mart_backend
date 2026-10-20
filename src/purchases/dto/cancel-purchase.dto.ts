import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsString, MinLength } from 'class-validator';

export class CancelPurchaseDto {
  @ApiProperty({ description: 'Why the order is being called off' })
  @IsString()
  @MinLength(3)
  reason: string;

  @ApiProperty({
    description:
      'Date the goods go back to the supplier (the cancellation return date) — not in the future',
  })
  @IsDateString()
  cancelDate: string;
}
