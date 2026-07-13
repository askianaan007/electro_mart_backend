import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateChequeStatusDto {
  @ApiProperty({
    enum: ['CLEARED', 'RETURNED', 'PENDING'],
    description:
      'PENDING is only accepted as a revert of a cheque previously marked CLEARED or RETURNED, within 1 day of that change.',
  })
  @IsIn(['CLEARED', 'RETURNED', 'PENDING'])
  status: 'CLEARED' | 'RETURNED' | 'PENDING';
}
