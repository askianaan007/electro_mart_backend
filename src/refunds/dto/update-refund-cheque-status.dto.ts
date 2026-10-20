import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateRefundChequeStatusDto {
  @ApiProperty({
    enum: ['PENDING', 'CLEARED', 'RETURNED'],
    description:
      'Refund cheques received from a supplier can move between any statuses (bank reversal, re-presented cheque); ' +
      'refund cheques paid to a dealer can only be reverted to PENDING within a day.',
  })
  @IsIn(['PENDING', 'CLEARED', 'RETURNED'])
  status: 'PENDING' | 'CLEARED' | 'RETURNED';
}
