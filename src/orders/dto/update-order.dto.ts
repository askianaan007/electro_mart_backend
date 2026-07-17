import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsUUID,
  Max,
  Min,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { OrderItemDto } from './create-order.dto';

export class UpdateOrderDto {
  @ApiProperty({ description: 'The dealer this order is for' })
  @IsUUID()
  dealerId: string;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiPropertyOptional({
    description:
      'Only meaningful for orders that are already Completed — the date the sale actually happened; approvedAt/packedAt/deliveredAt/completedAt are all reset to this date. Ignored for orders not yet Completed.',
  })
  @IsOptional()
  @IsDateString()
  saleDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercentage?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;
}
