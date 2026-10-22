import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { UndoPaymentDto } from './dto/undo-payment.dto';
import { UpdatePaymentChequeStatusDto } from './dto/update-payment-cheque-status.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/interfaces/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';

@ApiTags('Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private paymentsService: PaymentsService,
    // Only used for the post-commit rep-notification hook below
    // (version2_changes_backend.md §15.4) — PaymentsService itself is not
    // touched by this addition.
    private prisma: PrismaService,
    private mailer: MailerService,
  ) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Record a payment against an invoice' })
  create(@Body() dto: CreatePaymentDto, @CurrentUser('sub') adminId: string) {
    return this.paymentsService.create(dto, adminId);
  }

  @Get()
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({
    summary: 'List payments (admins see all, dealers see their own)',
  })
  findAll(@CurrentUser() user: JwtPayload, @Query() query: QueryPaymentDto) {
    return user.role === Role.ADMIN
      ? this.paymentsService.findAllForAdmin(query)
      : this.paymentsService.findAllForDealer(user.sub, query);
  }

  @Get('deleted')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List deleted payments that can still be restored' })
  findDeleted(@Query() query: QueryPaymentDto) {
    return this.paymentsService.findDeleted(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.DEALER)
  @ApiOperation({ summary: 'Get payment details' })
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.paymentsService.findOne(id, { role: user.role, id: user.sub });
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Edit a payment at any time (the previous version is kept and can be restored with undo)',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.paymentsService.update(id, dto, adminId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Delete a payment, restoring the dealer balance and invoice status (restorable with undo)',
  })
  remove(@Param('id') id: string, @CurrentUser('sub') adminId: string) {
    return this.paymentsService.remove(id, adminId);
  }

  @Post(':id/undo')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      "Undo the payment's most recent edit, cheque-status change or delete",
  })
  undo(
    @Param('id') id: string,
    @Body() dto: UndoPaymentDto,
    @CurrentUser('sub') adminId: string,
  ) {
    return this.paymentsService.undo(id, adminId, dto.revisionId);
  }

  @Patch(':id/cheque-status')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      'Change a cheque payment to pending, cleared or returned (bounced) at any time',
  })
  async updateChequeStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePaymentChequeStatusDto,
    @CurrentUser('sub') adminId: string,
  ) {
    const result = await this.paymentsService.updateChequeStatus(
      id,
      dto.status,
      adminId,
      !!dto.excessToWallet,
    );

    if (dto.status === 'RETURNED') {
      // Fire-and-forget, strictly after the update above has already
      // committed — a failure here can never affect the cheque-status
      // transition that already happened (§15.4/§15.11).
      this.notifyRepIfChequeReturned(id).catch(() => undefined);
    }

    return result;
  }

  /** version2_changes_backend.md §15.4 — the one place new code sits directly next to (not inside) existing payment logic. */
  private async notifyRepIfChequeReturned(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          include: { order: { include: { createdByRep: true } }, dealer: true },
        },
      },
    });
    const rep = payment?.invoice?.order.createdByRep;
    if (!payment || !payment.invoice || !rep) return;

    await this.mailer.notifyRepChequeReturned(rep.email, {
      customerName: payment.invoice.dealer.businessName,
      invoiceNumber: payment.invoice.invoiceNumber,
      chequeNumber: payment.chequeNumber ?? '—',
      chequeAmount: payment.amount.toString(),
      bankName: payment.bankName ?? '—',
      reason: 'Cheque returned by bank',
      outstandingBalance: payment.invoice.dealer.outstandingBalance.toString(),
    });
  }
}
