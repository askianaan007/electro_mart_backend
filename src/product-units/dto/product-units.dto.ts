import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProductUnitCondition, ProductUnitStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { SERIALS_PER_REQUEST } from '../../common/utils/serial';

/** Raw scanned values; normalized server-side (common/utils/serial.ts). */
export function SerialList() {
  return function (target: object, key: string) {
    IsArray()(target, key);
    ArrayMaxSize(SERIALS_PER_REQUEST)(target, key);
    IsString({ each: true })(target, key);
    MaxLength(200, { each: true })(target, key);
  };
}

export const SERIAL_CONTEXTS = [
  'RECEIVE',
  'ASSIGN',
  'SALES_RETURN',
  'PURCHASE_RETURN',
  'WRITE_OFF',
] as const;
export type SerialContext = (typeof SERIAL_CONTEXTS)[number];

export class ValidateSerialsDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ type: [String] })
  @SerialList()
  serials: string[];

  @ApiProperty({ enum: SERIAL_CONTEXTS })
  @IsIn(SERIAL_CONTEXTS)
  context: SerialContext;

  @ApiPropertyOptional({ description: 'ASSIGN / SALES_RETURN: the order' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({
    description: 'RECEIVE / PURCHASE_RETURN: the purchase',
  })
  @IsOptional()
  @IsUUID()
  purchaseId?: string;
}

export class RegisterUnitsDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ type: [String] })
  @SerialList()
  @ArrayMinSize(1)
  serials: string[];

  @ApiPropertyOptional({
    description:
      'Register against this purchase; omit for stock already on the shelf (opening stock)',
  })
  @IsOptional()
  @IsUUID()
  purchaseId?: string;

  @ApiPropertyOptional({
    description: 'Opening stock only: when it was received',
  })
  @IsOptional()
  @IsDateString()
  receivedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty({
    description:
      'New UUID per dialog; a retry with the same key returns the first result',
  })
  @IsUUID()
  idempotencyKey: string;
}

export class QueryUnitsDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ enum: ProductUnitStatus })
  @IsOptional()
  @IsEnum(ProductUnitStatus)
  status?: ProductUnitStatus;

  @ApiPropertyOptional({ enum: ProductUnitCondition })
  @IsOptional()
  @IsEnum(ProductUnitCondition)
  condition?: ProductUnitCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  purchaseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class UpdateUnitDto {
  @ApiPropertyOptional({
    description:
      'Correct a typo — only for an in-stock unit that was never sold',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  serialNumber?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  warrantyStartsAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  warrantyExpiresAt?: string | null;

  @ApiPropertyOptional({
    description: 'Required when correcting the serial or editing warranty',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SetConditionDto {
  @ApiProperty({ enum: ProductUnitCondition })
  @IsEnum(ProductUnitCondition)
  condition: ProductUnitCondition;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class WarrantySwapDto {
  @ApiProperty({
    description: 'Serial of the in-stock, good unit handed to the buyer',
  })
  @IsString()
  @MaxLength(200)
  replacementSerial: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  faultNote?: string;

  @ApiProperty()
  @IsUUID()
  idempotencyKey: string;
}

export class SupplierReplacementDto {
  @ApiProperty({ description: 'Serial of the unit the supplier sent back' })
  @IsString()
  @MaxLength(200)
  serial: string;

  @ApiPropertyOptional({
    description: 'An existing replacement record, if any',
  })
  @IsOptional()
  @IsUUID()
  replacementId?: string;

  @ApiProperty()
  @IsDateString()
  receivedAt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiProperty()
  @IsUUID()
  idempotencyKey: string;
}

export class OrderLineSerialsDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({
    type: [String],
    description: 'The complete desired set for this line',
  })
  @SerialList()
  serials: string[];
}

export class AssignOrderUnitsDto {
  @ApiProperty({ type: [OrderLineSerialsDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderLineSerialsDto)
  lines: OrderLineSerialsDto[];

  @ApiProperty()
  @IsUUID()
  idempotencyKey: string;
}

export class SalesReturnSerialDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  serial: string;

  @ApiProperty({ enum: ProductUnitCondition })
  @IsEnum(ProductUnitCondition)
  condition: ProductUnitCondition;

  @ApiPropertyOptional({
    description: 'What is wrong with this unit, e.g. "no display"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  faultNote?: string;
}
