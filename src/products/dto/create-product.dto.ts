import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  barcode?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  costPrice: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  wholesalePrice: number;

  @ApiPropertyOptional({
    description:
      'Representative Portal display price — falls back to wholesalePrice when unset',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  retailPrice?: number;

  @ApiPropertyOptional({
    description:
      'Struck-through "was" price, for showing a discount on the Representative Portal',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  compareAtPrice?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Surfaces this product in Representative Portal featured rails',
  })
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  currentStock?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warranty?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Track each unit by its serial/barcode (scanned at purchase and when packing orders). Optional per product.',
  })
  @IsOptional()
  @IsBoolean()
  trackSerials?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Warranty length in months, used to stamp each sold unit’s warranty expiry. Empty = no expiry date.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(240)
  warrantyMonths?: number | null;

  @ApiPropertyOptional({ enum: AccountStatus, default: AccountStatus.ACTIVE })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;
}
