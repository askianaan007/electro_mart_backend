import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ConfirmCollectionDto {
  @ApiPropertyOptional({
    description:
      'Which invoice to apply this collection against, if the representative did not specify one at submission time',
  })
  @IsOptional()
  @IsUUID()
  invoiceId?: string;
}
