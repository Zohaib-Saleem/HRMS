import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

/**
 * Mail configuration rules.
 *
 * These are the rules that decide whether a deployment can silently deliver no
 * email, so they are asserted directly rather than inferred from a boot that
 * happened not to fail. `validateEnv` is the same function the boot path calls;
 * only the `process.exit` around it is left out.
 */

/** The minimum a valid environment needs, before any mail settings. */
const BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  SESSION_SECRET: 'x'.repeat(32),
} as const;

/** The paths that failed, so an assertion names the field and not a message. */
function failedPaths(result: ReturnType<typeof validateEnv>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('mail configuration validation', () => {
  describe('production must not use the console provider', () => {
    it('rejects console in production', () => {
      const result = validateEnv({ ...BASE, NODE_ENV: 'production', MAIL_PROVIDER: 'console' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('MAIL_PROVIDER');
    });

    it('rejects production with MAIL_PROVIDER unset, because console is the default', () => {
      // The important half of the rule: the mistake is far more likely to be an
      // omission than an explicit `console`.
      const result = validateEnv({ ...BASE, NODE_ENV: 'production' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('MAIL_PROVIDER');
    });

    it('explains what to do instead', () => {
      const result = validateEnv({ ...BASE, NODE_ENV: 'production', MAIL_PROVIDER: 'console' });

      expect(result.success).toBe(false);
      if (result.success) return;
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toContain('MAIL_PROVIDER=smtp');
    });

    it('accepts a fully configured SMTP production environment', () => {
      const result = validateEnv({
        ...BASE,
        NODE_ENV: 'production',
        MAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('console stays available outside production', () => {
    it('accepts console in development', () => {
      expect(validateEnv({ ...BASE, NODE_ENV: 'development', MAIL_PROVIDER: 'console' }).success).toBe(true);
    });

    it('accepts console in test', () => {
      expect(validateEnv({ ...BASE, NODE_ENV: 'test', MAIL_PROVIDER: 'console' }).success).toBe(true);
    });

    it('defaults to console when NODE_ENV is unset', () => {
      const result = validateEnv({ ...BASE });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.MAIL_PROVIDER).toBe('console');
      expect(result.data.NODE_ENV).toBe('development');
    });
  });

  describe('an incomplete SMTP transport is rejected', () => {
    it('rejects smtp with no host', () => {
      const result = validateEnv({ ...BASE, MAIL_PROVIDER: 'smtp', SMTP_PORT: '587' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('SMTP_HOST');
    });

    it('rejects smtp with no port', () => {
      const result = validateEnv({ ...BASE, MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('SMTP_PORT');
    });

    it('rejects a port that is not a port', () => {
      const result = validateEnv({
        ...BASE,
        MAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '70000',
      });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('SMTP_PORT');
    });

    it('rejects a provider name that is neither console nor smtp', () => {
      const result = validateEnv({ ...BASE, MAIL_PROVIDER: 'sendgrid' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('MAIL_PROVIDER');
    });
  });

  describe('SMTP credentials only mean anything as a pair', () => {
    const smtp = { MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587' };

    it('rejects a username with no password', () => {
      const result = validateEnv({ ...BASE, ...smtp, SMTP_USER: 'mailer@example.com' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('SMTP_PASSWORD');
    });

    it('rejects a password with no username', () => {
      const result = validateEnv({ ...BASE, ...smtp, SMTP_PASSWORD: 'hunter2' });

      expect(result.success).toBe(false);
      expect(failedPaths(result)).toContain('SMTP_USER');
    });

    it('accepts both together', () => {
      const result = validateEnv({
        ...BASE,
        ...smtp,
        SMTP_USER: 'mailer@example.com',
        SMTP_PASSWORD: 'hunter2',
      });

      expect(result.success).toBe(true);
    });

    it('accepts neither, for a relay that authenticates by IP', () => {
      expect(validateEnv({ ...BASE, ...smtp }).success).toBe(true);
    });
  });

  describe('SMTP_SECURE', () => {
    const smtp = { MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465' };

    it('parses the string "true" into a boolean, because env values are strings', () => {
      const result = validateEnv({ ...BASE, ...smtp, SMTP_SECURE: 'true' });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.SMTP_SECURE).toBe(true);
    });

    it('defaults to false, which is what port 587 with STARTTLS wants', () => {
      const result = validateEnv({ ...BASE, ...smtp });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.SMTP_SECURE).toBe(false);
    });
  });
});
