import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SerialList } from '../../product-units/dto/product-units.dto';

export class OrderItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description:
      "Admin-only: discount percentage off this line only. Mutually exclusive with this item's discountAmount, and with the order-wide discount — an order uses either a single overall discount or per-product discounts, never both. Ignored for dealer callers.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercentage?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      "Admin-only: fixed discount amount off this line only. Mutually exclusive with this item's discountPercentage, and with the order-wide discount. Ignored for dealer callers.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Admin-only, on create: serials of the exact units sold on this line (at most `quantity`). Ignored for dealer/representative callers and on edits.',
  })
  @IsOptional()
  @SerialList()
  serials?: string[];
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    description:
      "Admin/Representative only: the dealer (or, for a representative, the customer/shop) to place this order for. Required for those two roles, ignored (the caller's own id is used) when a dealer creates it.",
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
      'Admin-only: discount percentage off the order subtotal, applied immediately since admin-created orders are pre-approved. Mutually exclusive with discountAmount. Ignored for dealer callers.',
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

  @ApiPropertyOptional({
    description:
      'Admin-only: the date this sale actually happened. When provided, the order is created directly as COMPLETED ' +
      '(approved, packed, delivered, and completed all on this date) instead of sitting at APPROVED — for recording ' +
      'a walk-in/offline sale after the fact. Ignored for dealer callers.',
  })
  @IsOptional()
  @IsDateString()
  saleDate?: string;

  @ApiPropertyOptional({
    description:
      'Representative-only: special instructions for this order (Rep_Portal_DOCUMENTATION.md §14.4). Ignored for admin/dealer callers.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      "Representative-only: the customer's requested delivery date. Ignored for admin/dealer callers.",
  })
  @IsOptional()
  @IsDateString()
  expectedDeliveryDate?: string;
}
