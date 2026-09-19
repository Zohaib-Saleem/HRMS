import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, roleKeyFromName, type Permission } from '@hrms/shared';

/**
 * Creating, renaming and deleting a role.
 *
 * Until this existed, `role.manage` could edit an existing role's permissions
 * and nothing else - so the two non-system roles in production were inserted
 * into the database by hand and exist nowhere in this repository. These tests
 * hold down the three rules that keep the new routes from producing the same
 * kind of orphan:
 *
 *   - the KEY is derived and permanent. Callers name roles; they do not name
 *     identifiers, and a hand-typed key eventually collides with a seeded one.
 *   - a SYSTEM role can be renamed but never deleted, because
 *     `syncPermissionCatalogue` recreates it on the next boot - a delete that
 *     silently undoes itself is worse than a refusal.
 *   - a role somebody still HOLDS is never deleted, because `users.routes.ts`
 *     refuses an account with no role at all.
 */

const db = vi.hoisted(() => ({
  role: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  permission: { findMany: vi.fn() },
  rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? ops : [])),
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(), diff: vi.fn(() => ({})) }));
vi.mock('../../core/audit.js', () => audit);

const { rolesRoutes } = await import('./roles.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(permissions: readonly Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's1',
      userId: 'actor',
      companyId: 'company-1',
      email: 'admin@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(rolesRoutes, { prefix: '/roles' });
  await app.ready();
  return app;
}

const ADMIN = DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN;

const aRole = (o: Record<string, unknown> = {}) => ({
  id: 'role-1',
  companyId: 'company-1',
  key: 'IT_MANAGER',
  name: 'IT Manager',
  description: null,
  dataScope: 'ALL',
  isSystem: false,
  isProtected: false,
  _count: { userRoles: 0 },
  ...o,
});

const create = (app: FastifyInstance, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/roles', payload: body });

beforeEach(() => {
  vi.clearAllMocks();
  db.role.findFirst.mockResolvedValue(null); // no name clash, no role found
  db.role.findMany.mockResolvedValue([]); // no key collisions
  db.permission.findMany.mockResolvedValue([]);
  db.role.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    aRole({ ...data, id: 'role-new' }),
  );
});

afterEach(() => vi.restoreAllMocks());

describe('deriving a key from a name', () => {
  it('turns a display name into an identifier', () => {
    expect(roleKeyFromName('IT Manager')).toBe('IT_MANAGER');
    expect(roleKeyFromName('Office Boy')).toBe('OFFICE_BOY');
  });

  it('collapses punctuation rather than carrying it into code', () => {
    expect(roleKeyFromName('I.T. Manager')).toBe('I_T_MANAGER');
    expect(roleKeyFromName('  Night   Shift  ')).toBe('NIGHT_SHIFT');
  });

  it('never starts with a digit', () => {
    expect(roleKeyFromName('2nd Line Support')).toBe('ROLE_2ND_LINE_SUPPORT');
  });

  it('always returns something usable', () => {
    expect(roleKeyFromName('!!!')).toBe('ROLE');
  });
});

describe('POST /roles', () => {
  it('refuses a caller without role.manage', async () => {
    const app = await appAs([PERMISSIONS.ROLE_READ]);
    const res = await create(app, { name: 'IT Manager', dataScope: 'ALL' });

    expect(res.statusCode).toBe(403);
    expect(db.role.create).not.toHaveBeenCalled();
  });

  it('creates the role with a derived key and the chosen scope', async () => {
    const app = await appAs(ADMIN);
    const res = await create(app, {
      name: 'IT Manager',
      description: 'Runs IT.',
      dataScope: 'ALL',
    });

    expect(res.statusCode).toBe(201);
    expect(db.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: 'company-1',
          key: 'IT_MANAGER',
          name: 'IT Manager',
          description: 'Runs IT.',
          dataScope: 'ALL',
          isSystem: false,
          isProtected: false,
        }),
      }),
    );
  });

  it('never marks a company role as system or protected', async () => {
    const app = await appAs(ADMIN);
    // Even when the caller asks for it outright.
    await create(app, {
      name: 'IT Manager',
      dataScope: 'ALL',
      isSystem: true,
      isProtected: true,
    });

    const { data } = db.role.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.isSystem).toBe(false);
    expect(data.isProtected).toBe(false);
  });

  it('refuses a name another role already uses', async () => {
    db.role.findFirst.mockResolvedValue({ id: 'other' });
    const app = await appAs(ADMIN);
    const res = await create(app, { name: 'it manager', dataScope: 'ALL' });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.name[0]).toMatch(/already exists/i);
    expect(db.role.create).not.toHaveBeenCalled();
  });

  it('suffixes a derived key that collides, rather than refusing a distinct name', async () => {
    // "IT-Manager" and an existing "IT Manager" are different names that both
    // derive to IT_MANAGER - the clash is on a value the caller never typed.
    db.role.findMany.mockResolvedValue([{ key: 'IT_MANAGER' }]);
    const app = await appAs(ADMIN);
    await create(app, { name: 'IT-Manager', dataScope: 'ALL' });

    const { data } = db.role.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.key).toBe('IT_MANAGER_2');
  });

  it('allows a role with no permissions, as a starting point', async () => {
    const app = await appAs(ADMIN);
    const res = await create(app, { name: 'IT Manager', dataScope: 'ALL' });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.permissions).toEqual([]);
  });

  it('refuses a scope that is not offered', async () => {
    const app = await appAs(ADMIN);
    const res = await create(app, { name: 'IT Manager', dataScope: 'EVERYTHING' });

    expect(res.statusCode).toBe(422);
    expect(db.role.create).not.toHaveBeenCalled();
  });

  it('records the creation, naming the key and the scope', async () => {
    const app = await appAs(ADMIN);
    await create(app, { name: 'IT Manager', dataScope: 'ALL' });

    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.create', entityType: 'Role' }),
    );
    expect(audit.recordAudit.mock.calls[0]![0].summary).toMatch(/IT_MANAGER.*scope ALL/);
  });
});

describe('PATCH /roles/:id', () => {
  const patch = (app: FastifyInstance, body: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/roles/role-1', payload: body });

  beforeEach(() => {
    db.role.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      aRole(data),
    );
  });

  it('renames and re-scopes', async () => {
    db.role.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      'name' in args.where ? null : aRole({ dataScope: 'OWN' }),
    );
    const app = await appAs(ADMIN);
    const res = await patch(app, { name: 'IT Lead', dataScope: 'ALL' });

    expect(res.statusCode).toBe(200);
    expect(db.role.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'IT Lead', dataScope: 'ALL' }) }),
    );
  });

  it('never changes the key, whatever the body says', async () => {
    db.role.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      'name' in args.where ? null : aRole(),
    );
    const app = await appAs(ADMIN);
    await patch(app, { name: 'IT Lead', dataScope: 'ALL', key: 'SOMETHING_ELSE' });

    const { data } = db.role.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('key');
  });

  it('refuses the protected role', async () => {
    db.role.findFirst.mockResolvedValue(aRole({ isProtected: true, name: 'Super Admin' }));
    const app = await appAs(ADMIN);
    const res = await patch(app, { name: 'Owner', dataScope: 'ALL' });

    expect(res.statusCode).toBe(403);
    expect(db.role.update).not.toHaveBeenCalled();
  });

  it('allows a system role to be renamed', async () => {
    db.role.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      'name' in args.where ? null : aRole({ isSystem: true, key: 'LUNCH_OPERATOR', name: 'Office Boy' }),
    );
    const app = await appAs(ADMIN);
    const res = await patch(app, { name: 'Pantry Staff', dataScope: 'OWN' });

    expect(res.statusCode).toBe(200);
  });

  it('404s for a role in another company', async () => {
    db.role.findFirst.mockResolvedValue(null);
    const app = await appAs(ADMIN);
    expect((await patch(app, { name: 'X Y', dataScope: 'OWN' })).statusCode).toBe(404);
  });
});

describe('DELETE /roles/:id', () => {
  const del = (app: FastifyInstance) =>
    app.inject({ method: 'DELETE', url: '/roles/role-1' });

  it('deletes a company role nobody holds', async () => {
    db.role.findFirst.mockResolvedValue(aRole({ _count: { userRoles: 0 } }));
    const app = await appAs(ADMIN);
    const res = await del(app);

    expect(res.statusCode).toBe(200);
    expect(db.role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.delete' }),
    );
  });

  it('refuses a system role, because the catalogue would recreate it', async () => {
    db.role.findFirst.mockResolvedValue(aRole({ isSystem: true, name: 'Employee' }));
    const app = await appAs(ADMIN);
    const res = await del(app);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/built-in/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it('refuses a role somebody still holds, and says how many', async () => {
    db.role.findFirst.mockResolvedValue(aRole({ _count: { userRoles: 4 } }));
    const app = await appAs(ADMIN);
    const res = await del(app);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/4 accounts still hold/i);
    expect(db.role.delete).not.toHaveBeenCalled();
  });

  it('refuses a caller without role.manage', async () => {
    const app = await appAs([PERMISSIONS.ROLE_READ]);
    expect((await del(app)).statusCode).toBe(403);
    expect(db.role.delete).not.toHaveBeenCalled();
  });
});
