import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The console provider must not write message bodies to the log outside
 * development.
 *
 * This is a security assertion, not a formatting one. A password reset body
 * carries a live single-use token, and the console provider is what production
 * was running on when the audit found it - so the interesting case is the one
 * where `isDevelopment` is false.
 */

const env = vi.hoisted(() => ({ isDevelopment: true }));

vi.mock('../../config/env.js', () => ({
  get isDevelopment() {
    return env.isDevelopment;
  },
  isProduction: false,
  env: { NODE_ENV: 'test' },
}));

const { ConsoleEmailProvider } = await import('./console-provider.js');

/** Captures what was logged, so the assertions can read it back. */
function recordingLogger() {
  const entries: Array<Record<string, unknown>> = [];
  const logger = {
    info: (payload: Record<string, unknown>) => entries.push(payload),
  } as unknown as FastifyBaseLogger;
  return { logger, entries };
}

const RESET_TOKEN = 'a-live-single-use-reset-token';

const MESSAGE = {
  to: 'someone@example.com',
  subject: 'Reset your HRMS password',
  text: `Use this link: https://hrms.example.com/reset-password?token=${RESET_TOKEN}`,
};

describe('ConsoleEmailProvider', () => {
  beforeEach(() => {
    env.isDevelopment = true;
  });

  it('never reports the message as delivered', async () => {
    const { logger } = recordingLogger();

    const result = await new ConsoleEmailProvider(logger).send(MESSAGE);

    // The whole point of the provider: it did not send anything, and callers
    // must be able to tell.
    expect(result.delivered).toBe(false);
    expect(result.provider).toBe('console');
  });

  describe('outside development', () => {
    beforeEach(() => {
      env.isDevelopment = false;
    });

    it('does not write the message body to the log', async () => {
      const { logger, entries } = recordingLogger();

      await new ConsoleEmailProvider(logger).send(MESSAGE);

      const logged = JSON.stringify(entries);
      expect(logged).not.toContain(RESET_TOKEN);
      expect(logged).not.toContain('reset-password?token=');
    });

    it('still records the recipient and subject, so delivery stays auditable', async () => {
      const { logger, entries } = recordingLogger();

      await new ConsoleEmailProvider(logger).send(MESSAGE);

      const mail = entries[0]?.mail as Record<string, unknown>;
      expect(mail.to).toBe(MESSAGE.to);
      expect(mail.subject).toBe(MESSAGE.subject);
    });

    it('says the body was withheld rather than omitting the field silently', async () => {
      const { logger, entries } = recordingLogger();

      await new ConsoleEmailProvider(logger).send(MESSAGE);

      const mail = entries[0]?.mail as Record<string, unknown>;
      expect(String(mail.body)).toContain('withheld');
    });
  });

  describe('in development', () => {
    it('logs the body, because the reset link has to be reachable', async () => {
      const { logger, entries } = recordingLogger();

      await new ConsoleEmailProvider(logger).send(MESSAGE);

      expect(JSON.stringify(entries)).toContain(RESET_TOKEN);
    });
  });
});
