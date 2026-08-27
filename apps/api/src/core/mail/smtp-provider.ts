import nodemailer, { type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../config/env.js';
import type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

/**
 * SMTP provider.
 *
 * Credentials come only from environment variables - nothing is hardcoded, and
 * nothing is defaulted to a real host. Env validation guarantees SMTP_HOST and
 * SMTP_PORT exist before this class is constructed.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly logger: FastifyBaseLogger) {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // Omit auth entirely for relays that do not use it, rather than sending
      // undefined credentials.
      ...(env.SMTP_USER
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }
        : {}),
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
    this.logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'SMTP transport ready');
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const info = await this.transporter.sendMail({
      from: env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });

    // Recipient and subject only - the body can contain a reset link.
    this.logger.info(
      { mail: { provider: this.name, to: message.to, subject: message.subject, messageId: info.messageId } },
      'email sent',
    );

    return { delivered: true, provider: this.name, messageId: info.messageId };
  }
}
