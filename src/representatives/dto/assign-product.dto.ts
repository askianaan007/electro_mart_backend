import { ApiProperty } from '@nestjs/swagger';
import { AssignmentScopeType } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class AssignProductDto {
  @ApiProperty({ enum: AssignmentScopeType })
  @IsEnum(AssignmentScopeType)
  scopeType: AssignmentScopeType;

  @ApiProperty({
    description:
      'Product id / category name / brand name / campaign key, depending on scopeType',
  })
  @IsString()
  scopeValue: string;
}
