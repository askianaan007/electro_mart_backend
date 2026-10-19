import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateSettlementChequeStatusDto {
  @ApiProperty({ enum: ['CLEARED', 'RETURNED'] })
  @IsIn(['CLEARED', 'RETURNED'])
  status: 'CLEARED' | 'RETURNED';
}
