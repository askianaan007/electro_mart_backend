import { PartialType } from '@nestjs/swagger';
import { CreateChequeFlowDto } from './create-cheque-flow.dto';

export class UpdateChequeFlowDto extends PartialType(CreateChequeFlowDto) {}
