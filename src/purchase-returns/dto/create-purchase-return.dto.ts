import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class PurchaseReturnItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    description:
      'Cost per unit for this returned item. Required when the return is not tied to a purchase ' +
      '(purchaseId omitted) since there is no purchase line to derive the cost from; ignored otherwise.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  unitCost?: number;
}

export class CreatePurchaseReturnDto {
  @ApiPropertyOptional({
    description:
      'The purchase this return is against. Omit to record a standalone return (e.g. a damaged item ' +
      'found in stock) that is not tied to a particular purchase invoice — supplierId is required in that case.',
  })
  @IsOptional()
  @IsUUID()
  purchaseId?: string;

  @ApiPropertyOptional({
    description:
      'Required when purchaseId is omitted; ignored otherwise (derived from the purchase).',
  })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty()
  @IsDateString()
  returnDate: string;

  @ApiProperty({ type: [PurchaseReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnItemDto)
  items: PurchaseReturnItemDto[];
}
