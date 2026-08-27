import type { FastifyBaseLogger } from 'fastify';
import type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

/**
 * Development provider. Writes the message to the log instead of sending it,
 * so the whole notification path can be exercised without a mail server.
 *
 * The body is logged deliberately - in development the reset link needs to be
 * reachable. It is never used in production: env validation defaults to this
 * provider only when MAIL_PROVIDER is left at `console`, and production
 * deployments are expected to set `smtp`.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  constructor(private readonly logger: FastifyBaseLogger) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    this.logger.info(
      {
        mail: {
          provider: this.name,
          to: message.to,
          subject: message.subject,
          body: message.text,
        },
      },
      'email (console provider - not actually sent)',
    );

    return { delivered: false, provider: this.name, messageId: `console-${Date.now()}` };
  }
}
