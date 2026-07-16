import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  IsUUID,
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
}
