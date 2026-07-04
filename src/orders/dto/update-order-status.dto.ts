import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ['PACKED', 'DELIVERED', 'COMPLETED'] })
  @IsIn(['PACKED', 'DELIVERED', 'COMPLETED'])
  status: 'PACKED' | 'DELIVERED' | 'COMPLETED';
}
