import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Configuring who a queue's new cases go to.
 *
 * The boundaries: only somebody who manages the case catalogue can change
 * routing; a rule can only name people a case could actually be handed to;
 * the backup is a different person; every change is audited with what it
 * replaced; and changing a rule never rewrites a case already assigned.
 */

const db = vi.hoisted(() => ({
  department: { findFirst: vi.fn() },
  caseCategory: { findFirst: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  caseRoutingRule: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  case: { update: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));

const { caseCatalogueRoutes } = await import('./case-catalogue.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const COMPANY = 'company-1';
const DESK_AGENTS = new Set(['u-hr-manager', 'u-it-manager', 'u-admin-manager', 'u-accountant']);
const ACTIVE_USERS = new Set([...DESK_AGENTS, 'u-ceo', 'u-plain']);

async function appAs(permissions: Permission[] = [PERMISSIONS.CASE_CATEGORY_MANAGE]) {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 's',
      userId: 'u-superadmin',
      companyId: COMPANY,
      email: 'admin@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(caseCatalogueRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

let stored: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  db.department.findFirst.mockImplementation(async (args: { where: { id: string } }) =>
    ['dep-hr', 'dep-it', 'dep-admin', 'dep-accounts'].includes(args.where.id)
      ? { id: args.where.id, name: args.where.id.slice(4).toUpperCase() }
      : null,
  );
  db.caseCategory.findFirst.mockImplementation(
    async (args: { where: { id: string; departmentId: string } }) =>
      args.where.id === 'cat-it-email' && args.where.departmentId === 'dep-it' ? { id: 'cat-it-email' } : null,
  );
  // Desk eligibility: active and holding a desk grant, for the ids asked about.
  db.user.findMany.mockImplementation(async (args: { where: { id?: { in?: string[] } } }) =>
    [...DESK_AGENTS]
      .filter((id) => !args.where.id?.in || args.where.id.in.includes(id))
      .map((id) => ({ id, firstName: id, lastName: '', employee: null })),
  );
  db.user.findFirst.mockImplementation(async (args: { where: { id: string } }) =>
    ACTIVE_USERS.has(args.where.id) ? { id: args.where.id } : null,
  );
  db.caseRoutingRule.findFirst.mockImplementation(
    async (args: { where: { departmentId?: string; categoryId?: string | null; id?: string } }) => {
      const row = stored.find((r) =>
        args.where.id
          ? r.id === args.where.id
          : r.departmentId === args.where.departmentId && r.categoryId === args.where.categoryId,
      );
      // A copy, as the database returns: an update must not rewrite what was read.
      return row ? { ...row } : null;
    },
  );
  db.caseRoutingRule.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `rule-${stored.length + 1}`, updatedAt: new Date(), ...args.data };
    stored.push(row);
    return row;
  });
  db.caseRoutingRule.update.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = stored.find((r) => r.id === args.where.id)!;
      Object.assign(row, args.data);
      return row;
    },
  );
  const person = (id: unknown) =>
    typeof id === 'string' ? { id, firstName: id, lastName: '', email: `${id}@example.com` } : null;
  db.caseRoutingRule.findMany.mockImplementation(async () =>
    stored.map((r) => ({
      ...r,
      department: { name: String(r.departmentId) },
      category: r.categoryId ? { name: 'Email', parent: null } : null,
      responsible: person(r.responsibleUserId),
      backup: person(r.backupUserId),
      escalation: person(r.escalationUserId),
    })),
  );
  db.auditLog.create.mockResolvedValue({});
});

const audit = () =>
  db.auditLog.create.mock.calls.map(
    (c) => (c[0] as { data: { action: string; before?: unknown; after: Record<string, unknown> } }).data,
  );

describe('who may change routing', () => {
  it('is refused without the catalogue permission, even to a dispatcher', async () => {
    const app = await appAs([PERMISSIONS.CASE_READ_ALL, PERMISSIONS.CASE_ASSIGN]);
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId: 'dep-hr', responsibleUserId: 'u-hr-manager' },
    });
    expect(response.statusCode).toBe(403);
    expect(db.caseRoutingRule.create).not.toHaveBeenCalled();
  });
});

describe('setting a rule', () => {
  it.each([
    ['HR', 'dep-hr', 'u-hr-manager'],
    ['IT', 'dep-it', 'u-it-manager'],
    ['Admin', 'dep-admin', 'u-admin-manager'],
    ['Accounts', 'dep-accounts', 'u-accountant'],
  ])('%s: sets the department default to its manager, audited', async (_label, departmentId, userId) => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId, responsibleUserId: userId, escalationUserId: 'u-ceo' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      departmentId,
      categoryId: null,
      responsible: { userId, eligible: true },
      escalation: { userId: 'u-ceo' },
      isActive: true,
    });
    expect(audit()[0]).toMatchObject({ action: 'case.routing.create' });
  });

  it('refuses a responsible person who cannot work cases', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId: 'dep-hr', responsibleUserId: 'u-plain' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.responsibleUserId).toBeDefined();
  });

  it('refuses the same person as responsible and backup', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId: 'dep-hr', responsibleUserId: 'u-hr-manager', backupUserId: 'u-hr-manager' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a queue from another department', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId: 'dep-hr', categoryId: 'cat-it-email', responsibleUserId: 'u-hr-manager' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.categoryId).toBeDefined();
  });

  it('replaces the rule for the same scope, records what it replaced, and moves no existing case', async () => {
    const app = await appAs();
    await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: { departmentId: 'dep-it', categoryId: 'cat-it-email', responsibleUserId: 'u-it-manager' },
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/cases/catalogue/routing',
      payload: {
        departmentId: 'dep-it',
        categoryId: 'cat-it-email',
        responsibleUserId: 'u-admin-manager',
        backupUserId: 'u-it-manager',
        isActive: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ responsibleUserId: 'u-admin-manager', isActive: false });
    expect(audit()[1]).toMatchObject({
      action: 'case.routing.update',
      before: { responsibleUserId: 'u-it-manager', isActive: true },
      after: { responsibleUserId: 'u-admin-manager', backupUserId: 'u-it-manager', isActive: false },
    });
    // Historical assignments are the cases' own: changing routing touches none.
    expect(db.case.update).not.toHaveBeenCalled();
    expect(db.case.updateMany).not.toHaveBeenCalled();
  });

  it('shows a rule whose responsible person can no longer take cases as ineligible', async () => {
    stored.push({
      id: 'rule-old',
      departmentId: 'dep-hr',
      categoryId: null,
      responsibleUserId: 'u-left-company',
      backupUserId: null,
      escalationUserId: null,
      isActive: true,
      updatedAt: new Date(),
    });
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/catalogue/routing' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.rules[0].responsible).toMatchObject({
      userId: 'u-left-company',
      eligible: false,
    });
  });
});
