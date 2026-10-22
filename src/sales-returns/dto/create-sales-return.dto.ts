import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { SalesReturnSerialDto } from '../../product-units/dto/product-units.dto';
import { SERIALS_PER_REQUEST } from '../../common/utils/serial';

export class SalesReturnItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    type: [SalesReturnSerialDto],
    description:
      'Which serial-tracked units came back, with their condition. Required (up to the returned quantity) when every unit still with the buyer carries a serial.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SERIALS_PER_REQUEST)
  @ValidateNested({ each: true })
  @Type(() => SalesReturnSerialDto)
  serials?: SalesReturnSerialDto[];
}

export class CreateSalesReturnDto {
  @ApiProperty()
  @IsUUID()
  orderId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty()
  @IsDateString()
  returnDate: string;

  @ApiProperty({ type: [SalesReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesReturnItemDto)
  items: SalesReturnItemDto[];
}
