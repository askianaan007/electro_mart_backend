import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class UndoPaymentDto {
  @ApiPropertyOptional({
    description:
      "The lastChange.id the client is undoing. If the payment's latest change is no longer this one, the request is refused instead of undoing an older change.",
  })
  @IsOptional()
  @IsUUID()
  revisionId?: string;
}
