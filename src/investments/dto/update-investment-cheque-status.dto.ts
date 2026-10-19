import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateInvestmentChequeStatusDto {
  @ApiProperty({
    enum: ['CLEARED', 'RETURNED', 'PENDING'],
    description:
      'PENDING only reverts a CLEARED/RETURNED mark made within the last day.',
  })
  @IsIn(['CLEARED', 'RETURNED', 'PENDING'])
  status: 'CLEARED' | 'RETURNED' | 'PENDING';
}
