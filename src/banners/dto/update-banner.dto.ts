import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateBannerDto } from './create-banner.dto';

export class UpdateBannerDto extends PartialType(
  OmitType(CreateBannerDto, ['image'] as const),
) {}
