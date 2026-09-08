import type { FastifyBaseLogger } from 'fastify';
import { isDevelopment } from '../../config/env.js';
import type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

/**
 * Development provider. Writes the message to the log instead of sending it,
 * so the whole notification path can be exercised without a mail server.
 *
 * The body is logged only in development, where the reset link needs to be
 * reachable and the log is a terminal on somebody's laptop. Anywhere else the
 * body is withheld: a password reset mail contains a live single-use token, and
 * writing it to a log file hands account takeover to anyone who can read that
 * file - or to whatever ships those logs elsewhere. Recipient and subject are
 * still recorded, which is what makes "did this notification fire?" answerable
 * without also making it exploitable.
 *
 * Env validation refuses to boot with this provider under NODE_ENV=production,
 * so the withheld case is reachable only in `test` or a misconfigured staging
 * environment. It is written defensively anyway, because the cost of being
 * wrong here is a leaked credential.
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
          // Never the body outside development - see the note above.
          ...(isDevelopment
            ? { body: message.text }
            : { body: '[withheld: message bodies are only logged in development]' }),
        },
      },
      'email (console provider - NOT actually sent)',
    );

    return { delivered: false, provider: this.name, messageId: `console-${Date.now()}` };
  }
}
