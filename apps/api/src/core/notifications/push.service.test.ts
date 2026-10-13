import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Browser push delivery: the outbox and its worker.
 *
 * What is pinned here is the reliability contract the feature was asked for:
 *
 *   - a push is QUEUED next to the notification and SENT by the worker, and
 *     neither step can fail the request that caused it;
 *   - queueing twice, or a business event retried, does not push twice;
 *   - a muted category is not pushed, and the in-app row is untouched;
 *   - a gone subscription (404/410/403) is expired, a transient failure
 *     (429/5xx/network) is retried with backoff and then given up on;
 *   - SENT is recorded only when the push service accepted the message;
 *   - nothing logged carries the endpoint, the keys or the payload.
 */

const db = vi.hoisted(() => ({
  notification: { create: vi.fn(), findUnique: vi.fn() },
  pushSubscription: { findMany: vi.fn(), update: vi.fn() },
  notificationPreference: { findUnique: vi.fn() },
  pushDelivery: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  approvalRequest: { findUnique: vi.fn() },
}));
vi.mock('../db.js', () => ({ prisma: db }));

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: log }));

const push = await import('./push.service.js');
const { encryptSecret } = await import('../secrets.js');
const { notify } = await import('./notification.service.js');

const NOW = new Date('2026-10-13T10:00:00Z');
const now = () => NOW;

const NOTIFICATION = {
  id: 'n-1',
  userId: 'u-aziz',
  type: 'CASE_UPDATE',
  title: 'Case CASE-2026-000020 assigned to you',
  message: 'Laptop is not working - high priority',
  entityType: 'CaseDesk',
  entityId: 'case-20',
  createdAt: new Date(NOW.getTime() - 1000),
};

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-endpoint-token';
const AUTH = 'browser-auth-secret';

function dueRow(overrides: { attempts?: number; status?: string; createdAt?: Date; authSecret?: string } = {}) {
  return {
    id: 'd-1',
    attempts: overrides.attempts ?? 0,
    notification: { ...NOTIFICATION, createdAt: overrides.createdAt ?? NOTIFICATION.createdAt },
    subscription: {
      id: 's-1',
      endpoint: ENDPOINT,
      p256dh: 'BPublicKeyOfTheBrowser',
      authSecret: overrides.authSecret ?? encryptSecret(AUTH),
      status: overrides.status ?? 'ACTIVE',
    },
  };
}

const sender = { send: vi.fn() };

/** The data of the last `pushDelivery.update` - what the row was left as. */
function lastDeliveryUpdate() {
  return db.pushDelivery.update.mock.calls.at(-1)?.[0]?.data;
}

beforeEach(async () => {
  // Let a worker run kicked by the previous test's enqueue finish, so it
  // cannot hold the one-run-at-a-time guard when this test drives the queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  push.setPushTransportForTests({ sender, configured: true });
  db.notification.findUnique.mockResolvedValue(NOTIFICATION);
  db.pushSubscription.findMany.mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);
  db.notificationPreference.findUnique.mockResolvedValue(null);
  db.pushDelivery.findFirst.mockResolvedValue(null);
  db.pushDelivery.createMany.mockResolvedValue({ count: 2 });
  // The worker the enqueue kicks finds nothing; each test drives it itself.
  db.pushDelivery.findMany.mockResolvedValue([]);
  db.pushDelivery.updateMany.mockResolvedValue({ count: 1 });
  db.pushDelivery.update.mockResolvedValue({});
  db.pushSubscription.update.mockResolvedValue({});
  sender.send.mockResolvedValue(undefined);
});

// ------------------------------------------------------------------ enqueue

describe('queueing a push', () => {
  it('queues one delivery per active browser of the recipient, idempotently', async () => {
    expect(await push.enqueuePush('n-1')).toBe(2);

    expect(db.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 'u-aziz', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(db.pushDelivery.createMany).toHaveBeenCalledWith({
      data: [
        { notificationId: 'n-1', subscriptionId: 's-1' },
        { notificationId: 'n-1', subscriptionId: 's-2' },
      ],
      // Unique (notification, browser): queueing the same notification again
      // is a no-op, not a second push.
      skipDuplicates: true,
    });
  });

  it('does nothing at all when the server has no VAPID keys', async () => {
    push.setPushTransportForTests({ configured: false });
    expect(await push.enqueuePush('n-1')).toBe(0);
    expect(db.notification.findUnique).not.toHaveBeenCalled();
  });

  it('does nothing for somebody with no browser turned on', async () => {
    db.pushSubscription.findMany.mockResolvedValue([]);
    expect(await push.enqueuePush('n-1')).toBe(0);
    expect(db.pushDelivery.createMany).not.toHaveBeenCalled();
  });

  it('respects a muted category', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ pushMutedCategories: ['CASES'] });
    expect(await push.enqueuePush('n-1')).toBe(0);
    expect(db.pushDelivery.createMany).not.toHaveBeenCalled();
  });

  it('never mutes the test push', async () => {
    db.notification.findUnique.mockResolvedValue({ ...NOTIFICATION, type: 'SYSTEM', entityType: 'PushTest', entityId: null });
    db.notificationPreference.findUnique.mockResolvedValue({ pushMutedCategories: ['GENERAL', 'CASES'] });
    expect(await push.enqueuePush('n-1')).toBe(2);
  });

  it('skips the push for a retried business event - same person, same thing, minutes apart', async () => {
    db.pushDelivery.findFirst.mockResolvedValue({ id: 'earlier' });

    expect(await push.enqueuePush('n-1')).toBe(0);
    const where = db.pushDelivery.findFirst.mock.calls[0]![0].where.notification;
    expect(where).toMatchObject({
      id: { not: 'n-1' },
      userId: 'u-aziz',
      title: NOTIFICATION.title,
      entityType: 'CaseDesk',
      entityId: 'case-20',
    });
    expect(where.createdAt.gte.getTime()).toBe(NOTIFICATION.createdAt.getTime() - push.PUSH_DUPLICATE_WINDOW_MS);
  });

  it('swallows a database failure: the in-app notification is already written', async () => {
    db.pushSubscription.findMany.mockRejectedValue(new Error('connection reset'));
    await expect(push.enqueuePush('n-1')).resolves.toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'PUSH_ENQUEUE_FAILED', notificationId: 'n-1' }),
      expect.any(String),
    );
  });
});

describe('notify() and push together', () => {
  it('writes the in-app notification and queues its push', async () => {
    db.notification.create.mockResolvedValue({ id: 'n-1' });
    const result = await notify({ companyId: 'c', userId: 'u-aziz', type: 'CASE_UPDATE', title: 't', message: 'm' });
    expect(result.id).toBe('n-1');
    expect(db.pushDelivery.createMany).toHaveBeenCalled();
  });

  it('still succeeds when push is broken, so the business transaction is untouched', async () => {
    db.notification.create.mockResolvedValue({ id: 'n-1' });
    db.notification.findUnique.mockRejectedValue(new Error('push tables missing'));
    await expect(
      notify({ companyId: 'c', userId: 'u-aziz', type: 'CASE_UPDATE', title: 't', message: 'm' }),
    ).resolves.toMatchObject({ id: 'n-1', emailStatus: 'skipped' });
  });
});

// ------------------------------------------------------------------- worker

describe('sending', () => {
  it('sends the lock-screen content and records SENT only once the push service accepted it', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);

    const stats = await push.processPushQueue(now);

    expect(stats).toEqual({ sent: 1, retried: 0, failed: 0, expired: 0 });
    const [target, payload] = sender.send.mock.calls[0]!;
    expect(target).toEqual({ endpoint: ENDPOINT, keys: { p256dh: 'BPublicKeyOfTheBrowser', auth: AUTH } });
    expect(JSON.parse(payload)).toEqual({
      v: 1,
      notificationId: 'n-1',
      title: 'Case CASE-2026-000020 assigned to you',
      body: 'Open HRMS to view it.',
      tag: 'CaseDesk:case-20',
    });
    // No link and no case subject in the payload.
    expect(payload).not.toMatch(/Laptop|https?:/);
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'SENT', sentAt: NOW, lastErrorCode: null });
    expect(db.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { lastSuccessAt: NOW, lastErrorCode: null },
    });
  });

  it('claims a row before sending it, and skips one another worker already took', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);
    db.pushDelivery.updateMany
      .mockResolvedValueOnce({ count: 0 }) // stale-claim reset
      .mockResolvedValueOnce({ count: 0 }); // the claim itself: lost

    await push.processPushQueue(now);

    expect(db.pushDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'd-1', status: 'PENDING' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([404, 410, 403])('expires the subscription on %i and stops sending to it', async (statusCode) => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);
    sender.send.mockRejectedValue(Object.assign(new Error('gone'), { statusCode, endpoint: ENDPOINT, body: 'x' }));

    const stats = await push.processPushQueue(now);

    expect(stats.expired).toBe(1);
    expect(db.pushSubscription.update).toHaveBeenCalledWith({
      where: { id: 's-1' },
      data: { status: 'EXPIRED', lastFailureAt: NOW, lastErrorCode: String(statusCode) },
    });
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'EXPIRED', lastErrorCode: String(statusCode) });
  });

  it('retries a transient failure with backoff', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow({ attempts: 1 })]);
    sender.send.mockRejectedValue(Object.assign(new Error('unavailable'), { statusCode: 503 }));

    const stats = await push.processPushQueue(now);

    expect(stats.retried).toBe(1);
    expect(lastDeliveryUpdate()).toEqual({
      status: 'PENDING',
      lastErrorCode: '503',
      nextAttemptAt: new Date(NOW.getTime() + push.PUSH_RETRY_DELAYS_MS[1]),
    });
  });

  it('retries a network error, which has no HTTP status', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);
    sender.send.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await push.processPushQueue(now);

    expect(lastDeliveryUpdate()).toMatchObject({ status: 'PENDING', lastErrorCode: 'NETWORK' });
  });

  it('gives up after the last attempt and says FAILED, not sent', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow({ attempts: push.PUSH_MAX_ATTEMPTS - 1 })]);
    sender.send.mockRejectedValue(Object.assign(new Error('rate limited'), { statusCode: 429 }));

    const stats = await push.processPushQueue(now);

    expect(stats.failed).toBe(1);
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'FAILED', lastErrorCode: '429', sentAt: null });
  });

  it('does not retry a request the push service called malformed', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);
    sender.send.mockRejectedValue(Object.assign(new Error('bad'), { statusCode: 400 }));
    await push.processPushQueue(now);
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'FAILED', lastErrorCode: '400' });
  });

  it('does not send a push that is a day old', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([
      dueRow({ createdAt: new Date(NOW.getTime() - push.PUSH_MAX_AGE_MS - 1) }),
    ]);
    await push.processPushQueue(now);
    expect(sender.send).not.toHaveBeenCalled();
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'FAILED', lastErrorCode: 'STALE' });
  });

  it('does not send to a browser the person turned off after it was queued', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow({ status: 'DISABLED' })]);
    await push.processPushQueue(now);
    expect(sender.send).not.toHaveBeenCalled();
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'FAILED', lastErrorCode: 'SUBSCRIPTION_INACTIVE' });
  });

  it('expires a subscription whose secret can no longer be decrypted', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow({ authSecret: 'v1.not.real.cipher' })]);
    await push.processPushQueue(now);
    expect(sender.send).not.toHaveBeenCalled();
    expect(lastDeliveryUpdate()).toMatchObject({ status: 'EXPIRED', lastErrorCode: 'KEY_UNREADABLE' });
  });

  it('hands back rows a crashed worker left mid-send', async () => {
    await push.processPushQueue(now);
    expect(db.pushDelivery.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENDING', updatedAt: { lt: new Date(NOW.getTime() - 5 * 60_000) } },
      data: { status: 'PENDING' },
    });
  });

  it('never logs the endpoint, the keys or the payload', async () => {
    db.pushDelivery.findMany.mockResolvedValueOnce([dueRow()]);
    sender.send.mockRejectedValue(
      Object.assign(new Error(`Received unexpected response code for ${ENDPOINT}`), {
        statusCode: 503,
        endpoint: ENDPOINT,
        body: 'response body',
      }),
    );

    await push.processPushQueue(now);

    const logged = JSON.stringify([...log.warn.mock.calls, ...log.info.mock.calls, ...log.error.mock.calls]);
    expect(logged).toContain('PUSH_SEND_FAILED');
    expect(logged).not.toContain('secret-endpoint-token');
    expect(logged).not.toContain(AUTH);
    expect(logged).not.toContain('BPublicKeyOfTheBrowser');
    expect(logged).not.toContain('assigned to you');
  });
});

describe('classifyFailure', () => {
  it.each([
    [410, false, 'expire'],
    [404, false, 'expire'],
    [403, false, 'expire'],
    [429, false, 'retry'],
    [500, false, 'retry'],
    [502, false, 'retry'],
    [null, true, 'retry'],
    [400, false, 'drop'],
    [413, false, 'drop'],
    [null, false, 'drop'],
  ] as const)('%s (network: %s) -> %s', (status, network, outcome) => {
    expect(push.classifyFailure(status, network)).toBe(outcome);
  });
});
