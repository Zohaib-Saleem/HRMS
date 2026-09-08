import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The SMTP provider, against a mocked nodemailer.
 *
 * No relay is contacted and no message leaves the process. What matters here is
 * that the transport is built from the environment and nothing else - a
 * hardcoded host or a defaulted credential would be invisible in a test that
 * only checked "did it send?".
 */

const settings = vi.hoisted(() => ({
  env: {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: undefined as string | undefined,
    SMTP_PASSWORD: undefined as string | undefined,
    MAIL_FROM: 'HRMS <no-reply@example.com>',
  },
}));

/** Typed with its argument, so `mock.calls[0][0]` is the transport options. */
const createTransport = vi.hoisted(() =>
  vi.fn((_options: Record<string, unknown>) => ({
    verify: vi.fn().mockResolvedValue(true),
    sendMail: vi.fn().mockResolvedValue({ messageId: 'message-1' }),
  })),
);

vi.mock('nodemailer', () => ({ default: { createTransport } }));
vi.mock('../../config/env.js', () => ({
  get env() {
    return settings.env;
  },
  isProduction: true,
  isDevelopment: false,
}));

const { SmtpEmailProvider } = await import('./smtp-provider.js');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

const MESSAGE = { to: 'someone@example.com', subject: 'Subject', text: 'Body' };

beforeEach(() => {
  vi.clearAllMocks();
  settings.env.SMTP_USER = undefined;
  settings.env.SMTP_PASSWORD = undefined;
  settings.env.SMTP_SECURE = false;
  settings.env.SMTP_PORT = 587;
});

describe('SmtpEmailProvider', () => {
  it('builds the transport from the environment', () => {
    new SmtpEmailProvider(logger);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com', port: 587, secure: false }),
    );
  });

  it('omits auth entirely for a relay that authenticates by IP', () => {
    new SmtpEmailProvider(logger);

    // Not `auth: { user: undefined }` - nodemailer would try to authenticate.
    expect(createTransport.mock.calls[0]?.[0]).not.toHaveProperty('auth');
  });

  it('passes credentials through when both are set', () => {
    settings.env.SMTP_USER = 'mailer@example.com';
    settings.env.SMTP_PASSWORD = 'a-relay-password';

    new SmtpEmailProvider(logger);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'mailer@example.com', pass: 'a-relay-password' } }),
    );
  });

  it('honours implicit TLS on port 465', () => {
    settings.env.SMTP_SECURE = true;
    settings.env.SMTP_PORT = 465;

    new SmtpEmailProvider(logger);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true }),
    );
  });

  it('sends from MAIL_FROM and reports delivery', async () => {
    const provider = new SmtpEmailProvider(logger);

    const result = await provider.send(MESSAGE);

    const transport = createTransport.mock.results[0]?.value as { sendMail: ReturnType<typeof vi.fn> };
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'HRMS <no-reply@example.com>', to: MESSAGE.to }),
    );
    expect(result.delivered).toBe(true);
    expect(result.provider).toBe('smtp');
  });

  it('never writes the message body to the log', async () => {
    const provider = new SmtpEmailProvider(logger);

    await provider.send({ ...MESSAGE, text: 'https://hrms.example.com/reset?token=SECRET' });

    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('SECRET');
  });

  it('surfaces a relay that cannot be reached, so boot verification can report it', async () => {
    createTransport.mockReturnValueOnce({
      verify: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      sendMail: vi.fn(),
    } as never);

    await expect(new SmtpEmailProvider(logger).verify()).rejects.toThrow('ECONNREFUSED');
  });
});
