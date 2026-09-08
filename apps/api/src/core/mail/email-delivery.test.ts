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

/** `notify` sends without awaiting, so let the microtask queue drain. */
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

describe('delivery failure', () => {
  it('does not fail the caller when the transport throws', async () => {
    db.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'employee@example.com',
      firstName: 'Sam',
      status: 'ACTIVE',
      companyId: 'company-1',
    });
    setEmailProviderForTesting({
      name: 'broken',
      async send(): Promise<EmailResult> {
        throw new Error('relay refused the connection');
      },
    });

    // The in-app notification is already durable; a dead relay must not turn a
    // password reset request into a 500.
    await expect(requestPasswordReset('employee@example.com', request)).resolves.toBeUndefined();
    await flush();

    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });
});
