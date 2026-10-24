import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DealerWalletService } from './dealer-wallet.service';
import { UseWalletCreditDto } from './dto/use-wallet-credit.dto';

@ApiTags('Dealer wallet')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller()
export class DealerWalletController {
  constructor(private walletService: DealerWalletService) {}

  @Get('dealers/:id/wallet')
  @ApiOperation({
    summary:
      "A dealer's wallet: money paid above their invoices, kept for later purchases",
  })
  getWallet(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.getWallet(id);
  }

  @Post('invoices/:id/wallet-credit')
  @ApiOperation({
    summary: "Pay part or all of an invoice from the dealer's wallet",
  })
  useCredit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UseWalletCreditDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.walletService.useCredit(id, dto.amount, adminId, dto.note);
  }

  @Delete('wallet-credit/:id')
  @ApiOperation({
    summary: 'Undo a wallet credit use — the money goes back to the wallet',
  })
  removeUse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.walletService.removeUse(id, adminId);
  }
}
