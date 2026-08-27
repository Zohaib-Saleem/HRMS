import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../config/env.js';
import type { EmailProvider } from './email-provider.js';
import { ConsoleEmailProvider } from './console-provider.js';
import { SmtpEmailProvider } from './smtp-provider.js';

export type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

let provider: EmailProvider | null = null;

/**
 * The single place that knows which transport is in use. Adding a hosted API
 * provider later means one more case here and nothing else.
 */
export function resolveEmailProvider(logger: FastifyBaseLogger): EmailProvider {
  if (provider) return provider;

  provider =
    env.MAIL_PROVIDER === 'smtp'
      ? new SmtpEmailProvider(logger)
      : new ConsoleEmailProvider(logger);

  return provider;
}

/**
 * Boot-time check. A broken SMTP configuration is logged loudly but does not
 * stop the API: mail is a side channel, and refusing to serve HR data because a
 * relay is unreachable would be the wrong trade.
 */
export async function verifyEmailProvider(logger: FastifyBaseLogger): Promise<void> {
  const active = resolveEmailProvider(logger);
  if (!active.verify) return;

  try {
    await active.verify();
  } catch (error) {
    logger.error(
      { err: error, provider: active.name },
      'email provider failed verification - notifications will still be recorded in-app',
    );
  }
}

/** Test seam: lets a future test suite inject a fake provider. */
export function setEmailProviderForTesting(next: EmailProvider | null): void {
  provider = next;
}
