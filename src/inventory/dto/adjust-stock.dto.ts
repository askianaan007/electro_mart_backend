import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { SerialList } from '../../product-units/dto/product-units.dto';

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

  @ApiPropertyOptional({
    type: [String],
    description:
      'Optional serials (at most `quantity`): OUT writes these in-stock units off; IN registers them as existing stock.',
  })
  @IsOptional()
  @SerialList()
  serials?: string[];
}
