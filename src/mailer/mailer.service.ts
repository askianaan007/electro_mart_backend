import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface SendMailInput {
  to: string;
  subject: string;
  html: string;
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly fromAddress: string;

  constructor(private config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    const port = this.config.get<string>('SMTP_PORT');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    this.fromAddress =
      this.config.get<string>('MAIL_FROM') ??
      'Electro Mart <electromarttrade@gmail.com>';

    this.transporter =
      host && port && user && pass
        ? nodemailer.createTransport({
            host,
            port: Number(port),
            secure: Number(port) === 465,
            auth: { user, pass },
          })
        : null;
  }

  private async send(input: SendMailInput): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `SMTP not configured — skipping email to ${input.to}: "${input.subject}"`,
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${input.to}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  notifyAdminNewOrder(
    adminEmail: string,
    orderNumber: string,
    dealerName: string,
  ): Promise<void> {
    return this.send({
      to: adminEmail,
      subject: `New order ${orderNumber} awaiting approval`,
      html: `<p>${dealerName} submitted order <strong>${orderNumber}</strong>. It is pending your approval.</p>`,
    });
  }

  notifyAdminOutOfStock(
    adminEmail: string,
    productName: string,
  ): Promise<void> {
    return this.send({
      to: adminEmail,
      subject: `Out of stock — ${productName}`,
      html: `<p><strong>${productName}</strong> is now out of stock.</p>`,
    });
  }

  notifyDealerOrderApproved(
    dealerEmail: string,
    orderNumber: string,
    invoiceNumber: string,
    grandTotal?: string,
    discountDescription?: string,
  ): Promise<void> {
    const discountLine = discountDescription
      ? ` ${discountDescription} was applied.`
      : '';
    const totalLine = grandTotal
      ? ` Final total: <strong>${grandTotal}</strong>.${discountLine}`
      : '';
    return this.send({
      to: dealerEmail,
      subject: `Order ${orderNumber} approved`,
      html: `<p>Your order <strong>${orderNumber}</strong> has been approved. Invoice <strong>${invoiceNumber}</strong> is ready.${totalLine}</p>`,
    });
  }

  notifyDealerOrderRejected(
    dealerEmail: string,
    orderNumber: string,
    reason: string,
  ): Promise<void> {
    return this.send({
      to: dealerEmail,
      subject: `Order ${orderNumber} rejected`,
      html: `<p>Your order <strong>${orderNumber}</strong> was rejected.</p><p>Reason: ${reason}</p>`,
    });
  }

  notifyPasswordReset(email: string, resetToken: string): Promise<void> {
    return this.send({
      to: email,
      subject: 'Password reset requested',
      html: `<p>Use this token to reset your password: <strong>${resetToken}</strong></p><p>This token expires in 30 minutes. If you did not request this, ignore this email.</p>`,
    });
  }

  notifyDealerWelcome(
    dealerEmail: string,
    businessName: string,
    username: string,
    temporaryPassword: string,
  ): Promise<void> {
    return this.send({
      to: dealerEmail,
      subject: 'Welcome to Electro Mart — your dealer account is ready',
      html: `
        <p>Hello ${businessName},</p>
        <p>Your dealer account has been created. You can now log in to place orders and track invoices.</p>
        <p><strong>Username:</strong> ${username}<br/><strong>Temporary password:</strong> ${temporaryPassword}</p>
        <p>Please log in and change your password as soon as possible.</p>
      `,
    });
  }

  notifyDealerPasswordReset(
    dealerEmail: string,
    businessName: string,
    username: string,
    temporaryPassword: string,
  ): Promise<void> {
    return this.send({
      to: dealerEmail,
      subject: 'Your Electro Mart password has been reset',
      html: `
        <p>Hello ${businessName},</p>
        <p>An administrator has reset your account password.</p>
        <p><strong>Username:</strong> ${username}<br/><strong>New temporary password:</strong> ${temporaryPassword}</p>
        <p>Please log in and change your password as soon as possible.</p>
      `,
    });
  }

  notifyAdminChequeDepositReminder(
    adminEmail: string,
    cheques: {
      supplierName: string;
      amount: string;
      chequeDepositDate: Date;
      reference: string | null;
    }[],
  ): Promise<void> {
    const rows = cheques
      .map(
        (cheque) => `
          <tr>
            <td style="padding:6px 10px;border:1px solid #ddd;">${cheque.supplierName}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;">${cheque.reference ?? '—'}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${cheque.amount}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;">${cheque.chequeDepositDate.toLocaleDateString('en-GB')}</td>
          </tr>`,
      )
      .join('');

    const plural = cheques.length === 1 ? 'cheque' : 'cheques';
    return this.send({
      to: adminEmail,
      subject: `Reminder: ${cheques.length} supplier ${plural} due for bank deposit tomorrow`,
      html: `
        <p>The following supplier ${plural} are due for bank deposit tomorrow:</p>
        <table style="border-collapse:collapse;width:100%;max-width:560px;">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Supplier</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Reference</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">Amount</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Deposit Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `,
    });
  }

  notifyDealerOrderDelivered(
    dealerEmail: string,
    data: {
      orderNumber: string;
      dealerName: string;
      invoiceNumber: string;
      invoiceDate: Date;
      items: {
        productName: string;
        quantity: number;
        unitPrice: string;
        lineTotal: string;
      }[];
      subtotal: string;
      discountTotal: string;
      grandTotal: string;
    },
  ): Promise<void> {
    const rows = data.items
      .map(
        (item) => `
          <tr>
            <td style="padding:6px 10px;border:1px solid #ddd;">${item.productName}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${item.quantity}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${item.unitPrice}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${item.lineTotal}</td>
          </tr>`,
      )
      .join('');

    const discountRow =
      Number(data.discountTotal) > 0
        ? `<tr><td colspan="3" style="padding:6px 10px;text-align:right;">Discount</td><td style="padding:6px 10px;text-align:right;color:#c0392b;">-${data.discountTotal}</td></tr>`
        : '';

    return this.send({
      to: dealerEmail,
      subject: `Order ${data.orderNumber} delivered — Invoice ${data.invoiceNumber}`,
      html: `
        <p>Hello ${data.dealerName},</p>
        <p>Your order <strong>${data.orderNumber}</strong> has been delivered. Here is your invoice <strong>${data.invoiceNumber}</strong>:</p>
        <table style="border-collapse:collapse;width:100%;max-width:560px;">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Item</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">Qty</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">Unit Price</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr><td colspan="3" style="padding:6px 10px;text-align:right;">Subtotal</td><td style="padding:6px 10px;text-align:right;">${data.subtotal}</td></tr>
            ${discountRow}
            <tr><td colspan="3" style="padding:6px 10px;text-align:right;"><strong>Total</strong></td><td style="padding:6px 10px;text-align:right;"><strong>${data.grandTotal}</strong></td></tr>
          </tfoot>
        </table>
        <p>Invoice date: ${data.invoiceDate.toLocaleDateString('en-GB')}</p>
      `,
    });
  }

  // ---------------------------------------------------------------------
  // Representative Portal v2.1 — version2_changes_backend.md §4, §11, §14-§16.
  // All additive methods; nothing above this line is modified.
  // ---------------------------------------------------------------------

  notifyRepWelcome(
    repEmail: string,
    name: string,
    username: string,
    temporaryPassword: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject:
        'Welcome to Electro Mart — you are now an Official Sales Representative',
      html: `
        <p>Congratulations, ${name}.</p>
        <p>You have been appointed as an Official Sales Representative of Electro Mart.</p>
        <p>
          <strong>Login URL:</strong> ${this.config.get<string>('REP_PORTAL_URL') ?? '(see your administrator)'}<br/>
          <strong>Username:</strong> ${username}<br/>
          <strong>Temporary Password:</strong> ${temporaryPassword}
        </p>
        <p>For your security, you will be required to set a new password the first time you log in.</p>
        <p>If you did not expect this email, please contact Electro Mart support immediately.</p>
      `,
    });
  }

  notifyRepPasswordReset(
    repEmail: string,
    name: string,
    username: string,
    temporaryPassword: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: 'Your Electro Mart representative password has been reset',
      html: `
        <p>Hello ${name},</p>
        <p>An administrator has reset your account password.</p>
        <p><strong>Username:</strong> ${username}<br/><strong>New temporary password:</strong> ${temporaryPassword}</p>
        <p>Please log in and change your password as soon as possible.</p>
      `,
    });
  }

  notifyRepStatusChanged(
    repEmail: string,
    name: string,
    status: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Your Electro Mart account status has changed: ${status}`,
      html: `<p>Hello ${name},</p><p>Your representative account status has been updated to <strong>${status}</strong>. Contact your administrator with any questions.</p>`,
    });
  }

  notifyRepOrderApproved(
    repEmail: string,
    orderNumber: string,
    customerName: string,
    invoiceNumber: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Order ${orderNumber} approved`,
      html: `<p>The order <strong>${orderNumber}</strong> you placed for ${customerName} has been approved. Invoice <strong>${invoiceNumber}</strong> is ready.</p>`,
    });
  }

  notifyRepOrderRejected(
    repEmail: string,
    orderNumber: string,
    customerName: string,
    reason: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Order ${orderNumber} rejected`,
      html: `<p>The order <strong>${orderNumber}</strong> you placed for ${customerName} was rejected.</p><p>Reason: ${reason}</p>`,
    });
  }

  notifyRepSettlementPaid(
    repEmail: string,
    name: string,
    settlementNumber: string,
    amount: string,
    mode: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Commission settlement ${settlementNumber} paid`,
      html: `<p>Hello ${name},</p><p>Your commission settlement <strong>${settlementNumber}</strong> of <strong>${amount}</strong> has been paid via ${mode}.</p>`,
    });
  }

  notifyRepSettlementRejected(
    repEmail: string,
    name: string,
    settlementNumber: string,
    reason: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Commission settlement ${settlementNumber} rejected`,
      html: `<p>Hello ${name},</p><p>Your commission settlement <strong>${settlementNumber}</strong> was rejected.</p><p>Reason: ${reason}</p>`,
    });
  }

  notifyRepCollectionConfirmed(
    repEmail: string,
    customerName: string,
    amount: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Collection confirmed — ${customerName}`,
      html: `<p>Your collection of <strong>${amount}</strong> from ${customerName} has been verified and recorded by an administrator.</p>`,
    });
  }

  notifyRepCollectionRejected(
    repEmail: string,
    customerName: string,
    amount: string,
    reason: string,
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Collection rejected — ${customerName}`,
      html: `<p>Your submitted collection of <strong>${amount}</strong> from ${customerName} was rejected.</p><p>Reason: ${reason}</p>`,
    });
  }

  notifyRepChequeReturned(
    repEmail: string,
    data: {
      customerName: string;
      invoiceNumber: string;
      chequeNumber: string;
      chequeAmount: string;
      bankName: string;
      reason: string;
      outstandingBalance: string;
    },
  ): Promise<void> {
    return this.send({
      to: repEmail,
      subject: `Cheque returned — ${data.customerName} (${data.invoiceNumber})`,
      html: `
        <p>A cheque from <strong>${data.customerName}</strong> against invoice <strong>${data.invoiceNumber}</strong> has bounced.</p>
        <table style="border-collapse:collapse;">
          <tr><td style="padding:4px 10px;">Cheque Number</td><td style="padding:4px 10px;"><strong>${data.chequeNumber}</strong></td></tr>
          <tr><td style="padding:4px 10px;">Bank</td><td style="padding:4px 10px;">${data.bankName}</td></tr>
          <tr><td style="padding:4px 10px;">Amount</td><td style="padding:4px 10px;">${data.chequeAmount}</td></tr>
          <tr><td style="padding:4px 10px;">Reason</td><td style="padding:4px 10px;">${data.reason}</td></tr>
          <tr><td style="padding:4px 10px;">Outstanding Balance</td><td style="padding:4px 10px;"><strong>${data.outstandingBalance}</strong></td></tr>
        </table>
        <p><strong>Required next action:</strong> Follow up with the customer to arrange an alternative payment.</p>
      `,
    });
  }

  notifyRepCollectionReminder(
    repEmail: string,
    data: {
      customerName: string;
      invoiceNumber: string;
      outstandingAmount: string;
      daysRemaining: number;
      overdueDays: number;
      priority: 'NORMAL' | 'HIGH' | 'OVERDUE';
    },
  ): Promise<void> {
    const statusLine =
      data.priority === 'OVERDUE'
        ? `<strong style="color:#c0392b;">${data.overdueDays} day(s) overdue</strong>`
        : `${data.daysRemaining} day(s) remaining in the grace period`;
    return this.send({
      to: repEmail,
      subject: `Collection reminder — ${data.customerName} (${data.invoiceNumber})`,
      html: `
        <p>This is a reminder that a collection is still outstanding:</p>
        <table style="border-collapse:collapse;">
          <tr><td style="padding:4px 10px;">Customer</td><td style="padding:4px 10px;"><strong>${data.customerName}</strong></td></tr>
          <tr><td style="padding:4px 10px;">Invoice</td><td style="padding:4px 10px;">${data.invoiceNumber}</td></tr>
          <tr><td style="padding:4px 10px;">Outstanding Amount</td><td style="padding:4px 10px;"><strong>${data.outstandingAmount}</strong></td></tr>
          <tr><td style="padding:4px 10px;">Status</td><td style="padding:4px 10px;">${statusLine}</td></tr>
        </table>
      `,
    });
  }
}
