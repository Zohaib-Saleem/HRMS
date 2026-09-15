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
 * NODE_ENV=production - is normally rejected by env validation before this
 * runs; it reaches here only when MAIL_REQUIRE_SMTP=false has waived that rule,
 * and the error below is then the single visible record, on every boot, that
 * no mail is leaving the server.
 */
export async function verifyEmailProvider(logger: FastifyBaseLogger): Promise<void> {
  const active = resolveEmailProvider(logger);

  if (active.name === 'console' && env.NODE_ENV !== 'development') {
    logger.error(
      {
        provider: active.name,
        nodeEnv: env.NODE_ENV,
        mailRequireSmtp: env.MAIL_REQUIRE_SMTP,
      },
      'mail is set to the console provider outside development: NO email will be delivered, so password reset is unavailable. Set MAIL_PROVIDER=smtp with SMTP_HOST and SMTP_PORT, then MAIL_REQUIRE_SMTP=true.',
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

/**
 * A short, non-sensitive identifier for a transport failure, safe to show an
 * administrator and safe to put in an API response.
 *
 * Only a bare code is ever taken - `EAUTH`, `ECONNECTION`, `ETIMEDOUT` and the
 * like, which nodemailer sets. The message is deliberately discarded: a relay's
 * text can quote the host, the envelope, the authenticating username, and in
 * some cases the greeting it was rejected with. A code says what went wrong
 * without saying who we are.
 */
export function emailErrorCode(error: unknown): string {
  const raw = (error as { code?: unknown } | null)?.code;
  return typeof raw === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(raw)
    ? raw
    : 'EMAIL_SEND_FAILED';
}
