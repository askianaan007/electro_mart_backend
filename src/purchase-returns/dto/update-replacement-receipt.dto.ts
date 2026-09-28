import { OmitType } from '@nestjs/swagger';
import { CreateReplacementReceiptDto } from './create-replacement-receipt.dto';

// Same fields as create minus the idempotency key — an edit replays safely
// on its own (resending it just re-applies the same final state).
export class UpdateReplacementReceiptDto extends OmitType(
  CreateReplacementReceiptDto,
  ['idempotencyKey'] as const,
) {}
