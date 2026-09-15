import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

/**
 * The two email paths that actually exist, end to end through the notification
 * service, against a recording transport.
 *
 * No SMTP server, no real relay and no real recipient: the provider is injected
 * through the seam the mail module already exposes for exactly this. What is
 * being asserted is that the two flows reach a transport at all, and carry what
 * they are supposed to carry - which is what stopped happening when production
 * was left on the console provider.
 *
 * The database is mocked rather than reached. These are assertions about mail,
 * and nothing here should depend on a schema or a live connection.
 */

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  passwordResetToken: { updateMany: vi.fn(), create: vi.fn() },
  notification: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  approvalStep: { findFirst: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { setEmailProviderForTesting } = await import('./index.js');
const { requestPasswordReset } = await import('../../auth/password-reset.service.js');
const { notifyApprover } = await import('../approvals/approval.service.js');

/** A transport that records instead of sending. */
function recordingProvider(): EmailProvider & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'recording',
    sent,
    async send(message: EmailMessage): Promise<EmailResult> {
      sent.push(message);
      return { delivered: true, provider: 'recording', messageId: 'test' };
    },
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

/** Enough of a request for `clientIp` and the audit writer. */
const request = { log: logger, headers: {}, ip: '203.0.113.10' } as unknown as FastifyRequest;

/**
 * The approval path dispatches without awaiting, so let the microtask queue
 * drain before asserting on it. Password reset waits for the transport now and
 * does not need this.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

let provider: ReturnType<typeof recordingProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  provider = recordingProvider();
  setEmailProviderForTesting(provider);
  db.notification.create.mockResolvedValue({ id: 'notification-1' });
  db.auditLog.create.mockResolvedValue({});
  db.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
  db.passwordResetToken.create.mockResolvedValue({});
});

afterEach(() => {
  setEmailProviderForTesting(null);
});

describe('password reset email', () => {
  const user = {
    id: 'user-1',
    email: 'employee@example.com',
    firstName: 'Sam',
    status: 'ACTIVE',
    companyId: 'company-1',
  };

  it('sends one email to the account address', async () => {
    db.user.findUnique.mockResolvedValue(user);

    await requestPasswordReset(user.email, request);
    await flush();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe(user.email);
  });

  /**
   * The destination is the account row's own address, not the string the
   * caller looked it up with. It matters now that the sign-in address can be
   * changed: whatever route or form arrives here, the link goes to where the
   * account currently signs in and nowhere else.
   */
  it('sends to the address on the account, not the one it was asked about', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, email: 'current@example.com' });

    await requestPasswordReset('Old.Address@Example.com', request);
    await flush();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe('current@example.com');
  });

  it('carries a usable reset link', async () => {
    db.user.findUnique.mockResolvedValue(user);

    await requestPasswordReset(user.email, request);
    await flush();

    expect(provider.sent[0]?.text).toContain('/reset-password?token=');
  });

  it('sends to an INVITED account, for whom the link is the whole invitation', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, status: 'INVITED' });

    await requestPasswordReset(user.email, request);
    await flush();

    expect(provider.sent).toHaveLength(1);
  });

  it('sends nothing for an unknown address', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await requestPasswordReset('nobody@example.com', request);
    await flush();

    expect(provider.sent).toHaveLength(0);
  });

  it('sends nothing for a suspended account, so a reset cannot walk around a suspension', async () => {
    db.user.findUnique.mockResolvedValue({ ...user, status: 'SUSPENDED' });

    await requestPasswordReset(user.email, request);
    await flush();

    expect(provider.sent).toHaveLength(0);
  });

  it('keeps the reset link out of the in-app notification', async () => {
    db.user.findUnique.mockResolvedValue(user);

    await requestPasswordReset(user.email, request);
    await flush();

    const written = db.notification.create.mock.calls[0]?.[0]?.data as { message: string };
    expect(written.message).not.toContain('token=');
  });
});

describe('approval notification email', () => {
  const step = {
    approverEmployee: {
      id: 'employee-2',
      userId: 'user-2',
      workEmail: 'manager@example.com',
      user: { email: 'manager@example.com' },
    },
    approvalRequest: {
      id: 'approval-1',
      companyId: 'company-1',
      title: 'Leave request: 12-14 October',
      summary: 'Annual Leave, 3 days',
    },
  };

  it('emails the approver who owns the step', async () => {
    db.approvalStep.findFirst.mockResolvedValue(step);

    await notifyApprover('approval-1', 1, request);
    await flush();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe('manager@example.com');
  });

  it('names the request in the subject, so the inbox is scannable', async () => {
    db.approvalStep.findFirst.mockResolvedValue(step);

    await notifyApprover('approval-1', 1, request);
    await flush();

    expect(provider.sent[0]?.subject).toContain(step.approvalRequest.title);
  });

  it('sends nothing when the approver has no login account', async () => {
    // The production case today: managers exist as employees, with no user.
    db.approvalStep.findFirst.mockResolvedValue({
      ...step,
      approverEmployee: { ...step.approverEmployee, userId: null },
    });

    await notifyApprover('approval-1', 1, request);
    await flush();

    expect(provider.sent).toHaveLength(0);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it('records the in-app notification even so', async () => {
    db.approvalStep.findFirst.mockResolvedValue(step);

    await notifyApprover('approval-1', 1, request);
    await flush();

    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });
});

const activeUser = {
  id: 'user-1',
  email: 'employee@example.com',
  firstName: 'Sam',
  status: 'ACTIVE',
  companyId: 'company-1',
};

describe('delivery failure', () => {
  /** A transport that fails the way a real relay does: an error with a code. */
  function brokenProvider(code?: string): EmailProvider {
    return {
      name: 'broken',
      async send(): Promise<EmailResult> {
        const error = Object.assign(new Error('relay refused the connection'), { code });
        throw error;
      },
    };
  }

  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(activeUser);
  });

  it('does not fail the caller when the transport throws', async () => {
    setEmailProviderForTesting(brokenProvider());

    // The in-app notification is already durable; a dead relay must not turn a
    // password reset request into a 500.
    await expect(requestPasswordReset(activeUser.email, request)).resolves.toBeDefined();

    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });

  it('reports the failure instead of swallowing it into a silent success', async () => {
    setEmailProviderForTesting(brokenProvider());

    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.status).toBe('failed');
  });

  it('still writes the reset token, so the link exists even when the mail did not go', async () => {
    setEmailProviderForTesting(brokenProvider());

    await requestPasswordReset(activeUser.email, request);

    expect(db.passwordResetToken.create).toHaveBeenCalledTimes(1);
  });

  it("carries the transport's own code, which is what an administrator can act on", async () => {
    setEmailProviderForTesting(brokenProvider('EAUTH'));

    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.errorCode).toBe('EAUTH');
  });

  it('falls back to a generic code rather than leaking the relay message', async () => {
    // A message can quote the host, the envelope and the account we sign in
    // as, so nothing but a recognisable code is ever passed on.
    setEmailProviderForTesting(brokenProvider());

    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.errorCode).toBe('EMAIL_SEND_FAILED');
    expect(JSON.stringify(result)).not.toContain('relay refused');
  });

  it('logs the failure, so a dead relay is visible in the logs as well as the response', async () => {
    setEmailProviderForTesting(brokenProvider('ECONNECTION'));

    await requestPasswordReset(activeUser.email, request);

    expect(logger.error).toHaveBeenCalled();
  });
});

describe('delivery reporting', () => {
  beforeEach(() => {
    db.user.findUnique.mockResolvedValue(activeUser);
  });

  it('reports delivered when a transport accepted the message', async () => {
    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.status).toBe('delivered');
  });

  /**
   * The bug this whole file exists around. The console provider creates a
   * perfectly good token and delivers nothing, and the API used to answer
   * "sent" regardless - so a production server left on it looked healthy while
   * every reset link died in a log line.
   */
  it('reports unconfirmed for a provider that accepts without delivering', async () => {
    setEmailProviderForTesting({
      name: 'console',
      async send(): Promise<EmailResult> {
        return { delivered: false, provider: 'console' };
      },
    });

    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.status).toBe('unconfirmed');
  });

  it('reports skipped for an address with no account, and sends nothing', async () => {
    db.user.findUnique.mockResolvedValue(null);

    const result = await requestPasswordReset('nobody@example.com', request);

    expect(result.status).toBe('skipped');
    expect(provider.sent).toHaveLength(0);
  });

  it('names the transport but never a host, a user or a credential', async () => {
    const result = await requestPasswordReset(activeUser.email, request);

    expect(result.provider).toBe('recording');
    expect(Object.keys(result)).toEqual(
      expect.not.arrayContaining(['host', 'user', 'password', 'token', 'url']),
    );
  });

  it('never returns the reset token or the link', async () => {
    const result = await requestPasswordReset(activeUser.email, request);

    // The token is in the email body and nowhere else. Whatever the API hands
    // back about delivery, it cannot be turned into a login.
    const linkBody = provider.sent[0]?.text ?? '';
    expect(linkBody).toContain('/reset-password?token=');
    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('reset-password');
  });

  it('records the outcome in the audit summary, without the link', async () => {
    await requestPasswordReset(activeUser.email, request);

    const summary = db.auditLog.create.mock.calls[0]?.[0]?.data?.summary as string;
    expect(summary).toContain('delivered');
    expect(summary).not.toContain('token=');
  });
});

/**
 * Where a reset link goes after the sign-in address has been changed.
 *
 * The login-email-change feature made `User.email` mutable for the first time,
 * and a reset is keyed on nothing else. These hold that down explicitly, since
 * an employee has a second address - `Employee.workEmail` - that looks like a
 * plausible destination and must never be one.
 */
describe('reset destination follows the login address', () => {
  it('looks the account up by its sign-in address and nothing else', async () => {
    db.user.findUnique.mockResolvedValue(activeUser);

    await requestPasswordReset('employee@example.com', request);

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'employee@example.com' } }),
    );
  });

  it('mails the address on the account row, so a changed login takes the link with it', async () => {
    // The row as it reads after a change-email: the new address is what the
    // account is, and the old one is not on it any more.
    db.user.findUnique.mockResolvedValue({ ...activeUser, email: 'new@example.com' });

    await requestPasswordReset('new@example.com', request);

    expect(provider.sent[0]?.to).toBe('new@example.com');
  });

  it('sends nothing to the old address, which no account holds any more', async () => {
    db.user.findUnique.mockResolvedValue(null);

    const result = await requestPasswordReset('old@example.com', request);

    expect(provider.sent).toHaveLength(0);
    expect(result.status).toBe('skipped');
  });

  it('never consults the employee work email, which is a different address', async () => {
    // A work email that differs is legitimate and must not redirect a login
    // credential. Nothing in this flow may read the employee row at all.
    db.user.findUnique.mockResolvedValue(activeUser);

    await requestPasswordReset(activeUser.email, request);

    const selected = db.user.findUnique.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(selected).not.toHaveProperty('workEmail');
    expect(selected).not.toHaveProperty('employee');
    expect(provider.sent[0]?.to).toBe(activeUser.email);
  });
});
