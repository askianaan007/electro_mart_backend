import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdatePaymentChequeStatusDto {
  @ApiProperty({
    enum: ['CLEARED', 'RETURNED', 'PENDING'],
    description: "Any status other than the cheque's current one.",
  })
  @IsIn(['CLEARED', 'RETURNED', 'PENDING'])
  status: 'CLEARED' | 'RETURNED' | 'PENDING';
}
