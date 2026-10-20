import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class LinkPurchaseReturnDto {
  @ApiProperty({ description: 'The purchase the returned goods came from' })
  @IsUUID()
  purchaseId: string;
}
