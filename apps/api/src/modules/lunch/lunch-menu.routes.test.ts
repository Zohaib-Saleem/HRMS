import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type DataScope, type Permission } from '@hrms/shared';

/**
 * The lunch menu.
 *
 * Ordinary configuration, so the tests are short - but three claims are worth
 * holding, because each one is about money somebody will be charged:
 *
 *   - the grant is its own. Collecting the money for lunch does not let you set
 *     what lunch costs;
 *   - a duplicate name is refused as a field error rather than reaching the
 *     unique index. Two rows called "Biryani" at two prices is an ordering
 *     mistake waiting to happen on a dropdown sixty people use daily;
 *   - items are retired, never deleted. There is no DELETE route here at all,
 *     because orders carry what an item was called and what it cost, and a row
 *     that once had a price outlives the decision to stop selling it.
 */

const COMPANY = 'company-1';

const db = vi.hoisted(() => ({
  lunchMenuItem: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { lunchMenuRoutes } = await import('./lunch-menu.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(
  permissions: Permission[] = [PERMISSIONS.LUNCH_MENU_MANAGE],
  dataScope: DataScope = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-hr',
      companyId: COMPANY,
      email: 'hr@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(lunchMenuRoutes, { prefix: '/lunch/menu-items' });
  await app.ready();
  return app;
}

const NOW = new Date('2026-09-16T08:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'item-1',
  companyId: COMPANY,
  name: 'Chicken Karahi',
  description: null,
  price: 250,
  sortOrder: 0,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.lunchMenuItem.findFirst.mockResolvedValue(null);
  db.lunchMenuItem.findMany.mockResolvedValue([row()]);
  db.lunchMenuItem.create.mockImplementation(async (args: { data: Record<string, unknown> }) =>
    row({ id: 'item-new', ...args.data }),
  );
  db.lunchMenuItem.update.mockImplementation(async (args: { data: Record<string, unknown> }) =>
    row({ ...args.data }),
  );
});

it('adds an item at a price', async () => {
  const app = await appAs();

  const response = await app.inject({
    method: 'POST',
    url: '/lunch/menu-items',
    payload: { name: 'Biryani', price: 280 },
  });

  expect(response.statusCode).toBe(201);
  expect(response.json().data).toMatchObject({ name: 'Biryani', price: 280, isActive: true });
});

it('refuses a name the company already uses, whatever the casing', async () => {
  db.lunchMenuItem.findFirst.mockResolvedValue({ id: 'item-1' });
  const app = await appAs();

  const response = await app.inject({
    method: 'POST',
    url: '/lunch/menu-items',
    payload: { name: 'chicken karahi', price: 250 },
  });

  expect(response.statusCode).toBe(422);
  expect(response.json().error.details.name).toBeTruthy();
  expect(db.lunchMenuItem.create).not.toHaveBeenCalled();
});

it('refuses a price that is not a lunch price', async () => {
  const app = await appAs();

  const response = await app.inject({
    method: 'POST',
    url: '/lunch/menu-items',
    payload: { name: 'Gold Leaf Biryani', price: 250000 },
  });

  expect(response.statusCode).toBe(422);
});

it('retires an item rather than offering any way to delete it', async () => {
  db.lunchMenuItem.findFirst.mockResolvedValue(row());
  const app = await appAs();

  const patched = await app.inject({
    method: 'PATCH',
    url: '/lunch/menu-items/item-1',
    payload: { isActive: false },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().data.isActive).toBe(false);

  const deleted = await app.inject({ method: 'DELETE', url: '/lunch/menu-items/item-1' });
  expect(deleted.statusCode).toBe(404);
});

it('records what actually changed when an item is re-priced', async () => {
  db.lunchMenuItem.findFirst.mockResolvedValue(row({ price: 250 }));
  const app = await appAs();

  await app.inject({ method: 'PATCH', url: '/lunch/menu-items/item-1', payload: { price: 300 } });

  const entry = db.auditLog.create.mock.calls.at(-1)?.[0].data;
  expect(entry).toMatchObject({ action: 'lunch.menu.update', entityId: 'item-1' });
  expect(entry.before).toEqual({ price: 250 });
  expect(entry.after).toEqual({ price: 300 });
});

describe('the grant', () => {
  it('is not held by somebody who only collects the money', async () => {
    const app = await appAs([PERMISSIONS.LUNCH_COLLECTION_READ, PERMISSIONS.LUNCH_PAYMENT_MARK]);

    expect((await app.inject({ method: 'GET', url: '/lunch/menu-items' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/lunch/menu-items',
          payload: { name: 'Free Biryani', price: 0 },
        })
      ).statusCode,
    ).toBe(403);
  });
});
