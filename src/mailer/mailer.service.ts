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

  notifyAdminOutOfStock(adminEmail: string, productName: string): Promise<void> {
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
  ): Promise<void> {
    return this.send({
      to: dealerEmail,
      subject: `Order ${orderNumber} approved`,
      html: `<p>Your order <strong>${orderNumber}</strong> has been approved. Invoice <strong>${invoiceNumber}</strong> is ready.</p>`,
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
}
