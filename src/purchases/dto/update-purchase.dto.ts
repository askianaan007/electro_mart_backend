import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PurchaseItemDto } from './create-purchase.dto';

export class UpdatePurchaseDto {
  @ApiProperty()
  @IsUUID()
  supplierId: string;

  @ApiProperty()
  @IsString()
  invoiceNumber: string;

  @ApiProperty()
  @IsDateString()
  purchaseDate: string;

  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Optional: transport cost for getting this shipment from the supplier to our shop, when the supplier is ' +
      'contractually responsible for it. Deducted from the supplier credit balance (what we owe them) rather ' +
      'than added to the purchase value.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  transportCharges?: number;
}
