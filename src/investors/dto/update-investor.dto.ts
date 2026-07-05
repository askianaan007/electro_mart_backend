import { PartialType } from '@nestjs/swagger';
import { CreateInvestorDto } from './create-investor.dto';

export class UpdateInvestorDto extends PartialType(CreateInvestorDto) {}
