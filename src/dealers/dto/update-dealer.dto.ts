import { PartialType } from '@nestjs/swagger';
import { CreateDealerDto } from './create-dealer.dto';

export class UpdateDealerDto extends PartialType(CreateDealerDto) {}
