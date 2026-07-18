import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class AdjustStockDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ enum: ['IN', 'OUT'] })
  @IsIn(['IN', 'OUT'])
  direction: 'IN' | 'OUT';

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiProperty({
    description:
      'Why this manual correction is being made — required for the audit trail.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
