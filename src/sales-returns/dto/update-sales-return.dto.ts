import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  ValidateNested,
} from 'class-validator';
import { SalesReturnItemDto } from './create-sales-return.dto';

export class UpdateSalesReturnDto {
  @ApiProperty()
  @IsString()
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
