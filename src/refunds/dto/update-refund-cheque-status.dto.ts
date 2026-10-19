import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateRefundChequeStatusDto {
  @ApiProperty({ enum: ['CLEARED', 'RETURNED'] })
  @IsIn(['CLEARED', 'RETURNED'])
  status: 'CLEARED' | 'RETURNED';
}
