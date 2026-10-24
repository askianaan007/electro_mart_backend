import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';

export class UpdatePaymentChequeStatusDto {
  @ApiProperty({
    enum: ['CLEARED', 'RETURNED', 'PENDING'],
    description: "Any status other than the cheque's current one.",
  })
  @IsIn(['CLEARED', 'RETURNED', 'PENDING'])
  status: 'CLEARED' | 'RETURNED' | 'PENDING';

  @ApiPropertyOptional({
    description:
      'Re-presenting a returned cheque that now pays more than is due: put the extra in the dealer wallet instead of refusing.',
  })
  @IsOptional()
  @IsBoolean()
  excessToWallet?: boolean;
}
