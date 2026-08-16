import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateRepresentativeDto } from './create-representative.dto';

// Password is not editable here — use the dedicated reset-password /
// force-password-change endpoints, mirroring the existing Dealer pattern.
export class UpdateRepresentativeDto extends PartialType(
  OmitType(CreateRepresentativeDto, ['password'] as const),
) {}
