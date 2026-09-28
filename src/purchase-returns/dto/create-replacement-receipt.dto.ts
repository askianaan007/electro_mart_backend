import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReplacementReceiptItemDto {
  @ApiProperty({
    description:
      'The return line being replaced. Product and unit cost are always taken from this line — ' +
      'they are not accepted from the client.',
  })
  @IsUUID()
  purchaseReturnItemId: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateReplacementReceiptDto {
  @ApiProperty({
    description:
      'Client-generated UUID, one per submit attempt. Resending the same key returns the ' +
      'already-recorded receipt instead of receiving the goods twice.',
  })
  @IsUUID()
  idempotencyKey: string;

  @ApiProperty()
  @IsDateString()
  receivedDate: string;

  @ApiPropertyOptional({ description: "Supplier's delivery note / GRN number" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiProperty({ type: [ReplacementReceiptItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReplacementReceiptItemDto)
  items: ReplacementReceiptItemDto[];
}
