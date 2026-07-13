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
      'Electro Mart <no-reply@electromart.com>';

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
}
