import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ClearDealerDataDto {
  @ApiProperty({
    description: "The admin's own account password, required to confirm this irreversible action",
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
