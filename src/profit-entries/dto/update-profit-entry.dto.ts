import { PartialType } from '@nestjs/swagger';
import { CreateProfitEntryDto } from './create-profit-entry.dto';

export class UpdateProfitEntryDto extends PartialType(CreateProfitEntryDto) {}
