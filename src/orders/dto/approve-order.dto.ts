import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class ApproveOrderDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    default: 0,
    description:
      'Discount percentage off the order subtotal. Mutually exclusive with discountAmount.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPercentage?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Fixed discount amount off the order subtotal. Mutually exclusive with discountPercentage.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;
}
