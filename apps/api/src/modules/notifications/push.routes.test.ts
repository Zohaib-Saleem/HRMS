import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

/**
 * A person's browser push registrations, and the notification a click opens.
 *
 * The rule throughout: a person acts on their own rows and nobody else's. No
 * route takes a user id; every query carries the caller's, so another
 * person's subscription id, endpoint or notification is "not found". The one
 * place a row changes hands is a deliberate Enable in a browser somebody else
 * registered - and even then only by holding that browser's own endpoint.
 */

const db = vi.hoisted(() => ({
  notification: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  pushSubscription: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
  notificationPreference: { findUnique: vi.fn(), upsert: vi.fn() },
  pushDelivery: { count: vi.fn() },
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));

const pushService = vi.hoisted(() => ({
  configured: true,
  enqueuePush: vi.fn(),
}));
vi.mock('../../core/notifications/push.service.js', async (load) => {
  const actual = await load<typeof import('../../core/notifications/push.service.js')>();
  return {
    ...actual,
    pushConfigured: () => pushService.configured,
    vapidPublicKey: () => (pushService.configured ? 'BPublicVapidKey' : null),
    enqueuePush: pushService.enqueuePush,
  };
});

const { notificationRoutes } = await import('./notifications.routes.js');
const { decryptSecret } = await import('../../core/secrets.js');

const ME = 'u-hira';
const SOMEONE_ELSE = 'u-asim';
const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/abc';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

async function appAs(userId = ME, options: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const { registerErrorHandler } = await import('../../core/error-handler.js');
  const app = Fastify();
  registerErrorHandler(app);
  if (options.rateLimit) await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: 'company-1',
      email: 'someone@example.com',
      permissions: new Set(),
      dataScope: 'OWN',
      mustChangePassword: false,
    };
  });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  pushService.configured = true;
  db.pushSubscription.findMany.mockResolvedValue([]);
  db.notificationPreference.findUnique.mockResolvedValue(null);
  db.pushSubscription.findUnique.mockResolvedValue(null);
  db.pushSubscription.upsert.mockResolvedValue({});
  db.pushSubscription.update.mockResolvedValue({});
  db.pushSubscription.updateMany.mockResolvedValue({ count: 1 });
  db.pushSubscription.delete.mockResolvedValue({});
  db.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
  db.notification.create.mockResolvedValue({ id: 'n-test' });
  db.pushDelivery.count.mockResolvedValue(2);
  db.pushSubscription.count.mockResolvedValue(2);
});

describe('settings', () => {
  it('lists only the caller\'s browsers, never their endpoint or keys, and marks this one', async () => {
    db.pushSubscription.findMany.mockResolvedValue([
      {
        id: 's-1',
        endpoint: ENDPOINT,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0',
        status: 'ACTIVE',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        lastSuccessAt: new Date('2026-10-13T00:00:00Z'),
        lastFailureAt: null,
        lastErrorCode: null,
      },
    ]);
    db.notificationPreference.findUnique.mockResolvedValue({ pushMutedCategories: ['PAYROLL', 'RETIRED_CATEGORY'] });

    const app = await appAs();
    const response = await app.inject({
      method: 'GET',
      url: `/notifications/push?endpoint=${encodeURIComponent(ENDPOINT)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(db.pushSubscription.findMany.mock.calls[0]![0].where).toEqual({ userId: ME });
    const data = response.json().data;
    expect(data).toMatchObject({
      configured: true,
      publicKey: 'BPublicVapidKey',
      mutedCategories: ['PAYROLL'],
      devices: [{ id: 's-1', label: 'Firefox on Windows', status: 'ACTIVE', isCurrent: true }],
    });
    expect(response.body).not.toContain('mozilla.com');
    expect(response.body).not.toContain('authSecret');
  });

  it('says plainly when the server has no keys', async () => {
    pushService.configured = false;
    const app = await appAs();
    const data = (await app.inject({ method: 'GET', url: '/notifications/push' })).json().data;
    expect(data).toMatchObject({ configured: false, publicKey: null });
  });
});

describe('turning a browser on', () => {
  it('registers it to the caller, with the auth secret encrypted at rest', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/129.0 Safari/537.36' },
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'enable' },
    });

    expect(response.statusCode).toBe(200);
    const args = db.pushSubscription.upsert.mock.calls[0]![0];
    expect(args.where).toEqual({ endpoint: ENDPOINT });
    expect(args.create).toMatchObject({ userId: ME, companyId: 'company-1', p256dh: KEYS.p256dh });
    expect(args.create.authSecret).not.toBe(KEYS.auth);
    expect(decryptSecret(args.create.authSecret)).toBe(KEYS.auth);
    // Pressing Enable in a browser somebody else registered makes it yours.
    expect(args.update).toMatchObject({ userId: ME, status: 'ACTIVE' });
  });

  it('refuses an endpoint that is not https', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: 'http://10.0.0.5/internal', keys: KEYS, mode: 'enable' },
    });
    expect(response.statusCode).toBe(422);
    expect(db.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('refuses when push is not configured', async () => {
    pushService.configured = false;
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'enable' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('the silent re-sync on each visit', () => {
  it('never creates a registration the person did not ask for', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'sync' },
    });
    expect(response.json().data).toEqual({ active: false });
    expect(db.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("drops another person's registration rather than taking it over", async () => {
    db.pushSubscription.findUnique.mockResolvedValue({ id: 's-asim', userId: SOMEONE_ELSE, status: 'ACTIVE' });

    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'sync' },
    });

    expect(response.json().data).toEqual({ active: false });
    expect(db.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 's-asim' } });
    expect(db.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(db.pushSubscription.update).not.toHaveBeenCalled();
  });

  it('does not turn back on a browser the person turned off', async () => {
    db.pushSubscription.findUnique.mockResolvedValue({ id: 's-1', userId: ME, status: 'DISABLED' });
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'sync' },
    });
    expect(response.json().data).toEqual({ active: false });
    expect(db.pushSubscription.update.mock.calls[0]![0].data.status).toBeUndefined();
  });

  it('revives a registration the server had to expire', async () => {
    db.pushSubscription.findUnique.mockResolvedValue({ id: 's-1', userId: ME, status: 'EXPIRED' });
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'sync' },
    });
    expect(response.json().data).toEqual({ active: true });
    expect(db.pushSubscription.update.mock.calls[0]![0].data).toMatchObject({ status: 'ACTIVE' });
  });

  it("follows a rotated subscription - only the caller's own, active one", async () => {
    const app = await appAs();
    await app.inject({
      method: 'PUT',
      url: '/notifications/push/subscription',
      payload: { endpoint: ENDPOINT, keys: KEYS, mode: 'sync', previousEndpoint: 'https://fcm.googleapis.com/old' },
    });
    expect(db.pushSubscription.updateMany.mock.calls[0]![0].where).toEqual({
      endpoint: 'https://fcm.googleapis.com/old',
      userId: ME,
      status: 'ACTIVE',
    });
  });
});

describe('turning browsers off', () => {
  it('removes only the caller\'s registration for that endpoint', async () => {
    const app = await appAs();
    await app.inject({ method: 'POST', url: '/notifications/push/unsubscribe', payload: { endpoint: ENDPOINT } });
    expect(db.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { endpoint: ENDPOINT, userId: ME } });
  });

  it("cannot turn off somebody else's browser - it is not found", async () => {
    db.pushSubscription.updateMany.mockResolvedValue({ count: 0 });
    const app = await appAs();
    const response = await app.inject({ method: 'POST', url: '/notifications/push/devices/s-asim/disable' });
    expect(response.statusCode).toBe(404);
    expect(db.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's-asim', userId: ME },
      data: { status: 'DISABLED' },
    });
  });
});

describe('preferences', () => {
  it('stores the muted categories for the caller', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/preferences',
      payload: { mutedCategories: ['PAYROLL', 'PAYROLL', 'ASSETS'] },
    });
    expect(response.json().data).toEqual({ mutedCategories: ['PAYROLL', 'ASSETS'] });
    expect(db.notificationPreference.upsert.mock.calls[0]![0].where).toEqual({ userId: ME });
  });

  it('rejects a category that does not exist', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/notifications/push/preferences',
      payload: { mutedCategories: ['EVERYTHING'] },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('the test notification', () => {
  it('goes through the real pipeline and reports queued, not delivered', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'POST', url: '/notifications/push/test' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ queued: 2 });
    expect(db.notification.create.mock.calls[0]![0].data).toMatchObject({ userId: ME, entityType: 'PushTest' });
    expect(pushService.enqueuePush).toHaveBeenCalledWith('n-test');
  });

  it('asks the person to turn a browser on first', async () => {
    db.pushSubscription.count.mockResolvedValue(0);
    const app = await appAs();
    const response = await app.inject({ method: 'POST', url: '/notifications/push/test' });
    expect(response.statusCode).toBe(409);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it('is rate-limited', async () => {
    const app = await appAs(ME, { rateLimit: true });
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      codes.push((await app.inject({ method: 'POST', url: '/notifications/push/test' })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});

describe('opening a clicked push', () => {
  it("returns the caller's own notification", async () => {
    db.notification.findFirst.mockResolvedValue({
      id: 'n-1',
      type: 'CASE_UPDATE',
      title: 't',
      message: 'm',
      entityType: 'CaseDesk',
      entityId: 'case-1',
      readAt: null,
      createdAt: new Date(),
    });
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/notifications/n-1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ entityType: 'CaseDesk', entityId: 'case-1' });
    expect(db.notification.findFirst).toHaveBeenCalledWith({ where: { id: 'n-1', userId: ME } });
  });

  it("is 404 for anybody else's - the id in a push is not authority", async () => {
    db.notification.findFirst.mockResolvedValue(null);
    const app = await appAs(SOMEONE_ELSE);
    const response = await app.inject({ method: 'GET', url: '/notifications/n-1' });
    expect(response.statusCode).toBe(404);
    expect(db.notification.findFirst).toHaveBeenCalledWith({ where: { id: 'n-1', userId: SOMEONE_ELSE } });
  });
});
