import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { RepCollectionsService } from './rep-collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { QueryCollectionDto } from './dto/query-collection.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Rep Portal — Collections')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.REPRESENTATIVE)
@Controller('rep-portal/collections')
export class RepCollectionsController {
  constructor(private repCollectionsService: RepCollectionsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a collection for admin verification' })
  submit(@Body() dto: CreateCollectionDto, @CurrentUser('sub') repId: string) {
    return this.repCollectionsService.submit(dto, repId);
  }

  @Get()
  @ApiOperation({ summary: "The caller's own collection submissions" })
  list(@CurrentUser('sub') repId: string, @Query() query: QueryCollectionDto) {
    return this.repCollectionsService.list(repId, query);
  }

  @Get('customer/:customerId')
  @ApiOperation({
    summary:
      'Outstanding balance, invoices, pending cheques, and collection history for one customer',
  })
  getCustomerSummary(@Param('customerId') customerId: string) {
    return this.repCollectionsService.getCustomerCollectionsSummary(customerId);
  }
}
