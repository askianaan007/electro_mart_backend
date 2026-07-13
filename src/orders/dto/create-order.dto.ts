import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    description:
      'Admin-only: the dealer to place this order for. Required when an admin creates the order, ignored (the caller\'s own id is used) when a dealer creates it.',
  })
  @IsOptional()
  @IsUUID()
  dealerId?: string;

  @ApiProperty({ type: [OrderItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description:
      "Admin-only: discount percentage off the order subtotal, applied immediately since admin-created orders are pre-approved. Mutually exclusive with discountAmount. Ignored for dealer callers.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercentage?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Admin-only: fixed discount amount off the order subtotal. Mutually exclusive with discountPercentage. Ignored for dealer callers.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;
}
