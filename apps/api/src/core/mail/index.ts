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

/** The default MAIL_FROM, which no real relay will accept as a sender. */
const PLACEHOLDER_MAIL_FROM = 'HRMS <no-reply@hrms.local>';

/**
 * Boot-time check. A broken SMTP configuration is logged loudly but does not
 * stop the API: mail is a side channel, and refusing to serve HR data because a
 * relay is unreachable would be the wrong trade.
 *
 * The two configuration warnings below are deliberately not fatal for the same
 * reason. The one genuinely unsafe combination - the console provider under
 * NODE_ENV=production - is rejected by env validation before this runs, so it
 * cannot reach here; the check is repeated anyway because a provider that
 * silently delivers nothing is exactly the failure this function exists to
 * make visible.
 */
export async function verifyEmailProvider(logger: FastifyBaseLogger): Promise<void> {
  const active = resolveEmailProvider(logger);

  if (active.name === 'console' && env.NODE_ENV !== 'development') {
    logger.error(
      { provider: active.name, nodeEnv: env.NODE_ENV },
      'mail is set to the console provider outside development: NO email will be delivered. Set MAIL_PROVIDER=smtp.',
    );
  }

  if (active.name === 'smtp' && env.MAIL_FROM === PLACEHOLDER_MAIL_FROM) {
    logger.warn(
      { provider: active.name },
      'MAIL_FROM is still the placeholder address; most relays will reject mail from it. Set MAIL_FROM to a sender your relay accepts.',
    );
  }

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
