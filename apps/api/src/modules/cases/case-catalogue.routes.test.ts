import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The routing catalogue, as its administrator edits it.
 *
 * Four rules live in the route rather than in the schema, because the database
 * cannot express them, and these are what pin them:
 *
 *   - a top-level name is unique within its department. The unique index cannot
 *     enforce this - the parent column is null and PostgreSQL treats nulls as
 *     distinct - so if this check is ever dropped, nothing else catches it;
 *   - the tree is two deep: a subcategory cannot be given a subcategory;
 *   - a subcategory inherits its parent's department, whatever the request said;
 *   - a queue with cases behind it is retired, never deleted, because deleting
 *     it would orphan the history of why a case was routed somewhere.
 */

const { table } = await import('./case-store.test-kit.js');

const COMPANY = 'company-1';

const DEPARTMENTS = [
  { id: 'dep-it', companyId: COMPANY, name: 'IT', isActive: true },
  { id: 'dep-fin', companyId: COMPANY, name: 'Finance', isActive: true },
  // No queues at all. It must still appear, or nobody can give it its first.
  { id: 'dep-ops', companyId: COMPANY, name: 'Operations', isActive: true },
];

const db = vi.hoisted(() => ({
  department: { findFirst: vi.fn(), findMany: vi.fn() },
  caseCategory: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  case: { count: vi.fn(), groupBy: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { caseCatalogueRoutes } = await import('./case-catalogue.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(
  permissions: Permission[] = [PERMISSIONS.CASE_CATEGORY_MANAGE],
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-admin',
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

let categoryTable: ReturnType<typeof table>;

const category = (over: Record<string, unknown>) => ({
  companyId: COMPANY,
  parentCategoryId: null,
  description: null,
  sortOrder: 0,
  isActive: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();

  categoryTable = table([
    category({ id: 'cat-email', departmentId: 'dep-it', name: 'Email' }),
    category({ id: 'sub-signin', departmentId: 'dep-it', parentCategoryId: 'cat-email', name: 'Cannot sign in' }),
    category({ id: 'cat-fax', departmentId: 'dep-it', name: 'Fax', isActive: false }),
    category({ id: 'cat-salary', departmentId: 'dep-fin', name: 'Salary' }),
  ]);

  db.caseCategory.findFirst.mockImplementation(categoryTable.findFirst);
  db.caseCategory.findMany.mockImplementation(categoryTable.findMany);
  db.caseCategory.create.mockImplementation(categoryTable.create);
  db.caseCategory.update.mockImplementation(categoryTable.update);
  db.caseCategory.updateMany.mockImplementation(
    (args: { where: { parentCategoryId?: string }; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of categoryTable.rows) {
        if (row.parentCategoryId === args.where.parentCategoryId) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    },
  );
  db.caseCategory.delete.mockImplementation((args: { where: { id: string } }) => {
    const index = categoryTable.rows.findIndex((row) => row.id === args.where.id);
    const [removed] = categoryTable.rows.splice(index, 1);
    return Promise.resolve(removed);
  });

  const departmentTable = table(DEPARTMENTS);
  db.department.findFirst.mockImplementation(departmentTable.findFirst);
  db.department.findMany.mockImplementation(departmentTable.findMany);

  db.case.count.mockResolvedValue(0);
  db.case.groupBy.mockResolvedValue([]);
});

describe('reading the catalogue', () => {
  it('lists every department, empty ones and retired queues included', async () => {
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/catalogue' });

    expect(response.statusCode).toBe(200);
    const groups = response.json<{
      data: Array<{
        departmentName: string;
        categories: Array<{ id: string; isActive: boolean; children: Array<{ id: string }> }>;
      }>;
    }>().data;

    expect(groups.map((group) => group.departmentName)).toEqual(['Finance', 'IT', 'Operations']);

    const it = groups.find((group) => group.departmentName === 'IT');
    expect(it?.categories.map((c) => c.id).sort()).toEqual(['cat-email', 'cat-fax']);
    // A retired queue is on this screen precisely so somebody can bring it back.
    expect(it?.categories.find((c) => c.id === 'cat-fax')?.isActive).toBe(false);
    expect(it?.categories.find((c) => c.id === 'cat-email')?.children.map((c) => c.id)).toEqual([
      'sub-signin',
    ]);

    // The department nobody has given a queue to is here, empty.
    expect(groups.find((g) => g.departmentName === 'Operations')?.categories).toEqual([]);
  });

  it('carries the case count that makes retiring a decidable question', async () => {
    db.case.groupBy.mockResolvedValue([
      { categoryId: 'cat-email', subcategoryId: 'sub-signin', _count: { _all: 3 } },
      { categoryId: 'cat-email', subcategoryId: null, _count: { _all: 1 } },
    ]);
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/catalogue' });

    const groups = response.json<{
      data: Array<{
        departmentName: string;
        categories: Array<{ id: string; caseCount: number; children: Array<{ caseCount: number }> }>;
      }>;
    }>().data;
    const email = groups
      .find((group) => group.departmentName === 'IT')
      ?.categories.find((c) => c.id === 'cat-email');

    expect(email?.caseCount).toBe(4);
    expect(email?.children[0]?.caseCount).toBe(3);
  });

  it('is closed to anybody without the grant', async () => {
    const app = await appAs([PERMISSIONS.CASE_READ_OWN]);

    const response = await app.inject({ method: 'GET', url: '/cases/catalogue' });

    expect(response.statusCode).toBe(403);
  });
});

describe('adding a queue', () => {
  it('creates a top-level category under a department', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      payload: { departmentId: 'dep-ops', name: 'Facilities', sortOrder: 2 },
    });

    expect(response.statusCode).toBe(201);
    expect(categoryTable.rows.at(-1)).toMatchObject({
      departmentId: 'dep-ops',
      parentCategoryId: null,
      name: 'Facilities',
      sortOrder: 2,
    });
  });

  it('takes a subcategory\'s department from its parent, not from the request', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      payload: {
        parentCategoryId: 'cat-email',
        // A different department, which must be ignored rather than believed.
        departmentId: 'dep-fin',
        name: 'Mailbox full',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(categoryTable.rows.at(-1)).toMatchObject({
      departmentId: 'dep-it',
      parentCategoryId: 'cat-email',
    });
  });

  it('refuses a third level', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      payload: { parentCategoryId: 'sub-signin', name: 'Deeper still' },
    });

    expect(response.statusCode).toBe(422);
    expect(categoryTable.rows).toHaveLength(4);
  });

  it('refuses a duplicate top-level name, which no index can catch', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      // Same name, different case. A duplicate either way.
      payload: { departmentId: 'dep-it', name: 'email' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { details: Record<string, string[]> } }>().error.details).toHaveProperty(
      'name',
    );
  });

  it('allows the same name in a different department', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      payload: { departmentId: 'dep-fin', name: 'Email' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('needs a department when there is no parent to inherit one from', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/catalogue',
      payload: { name: 'Homeless' },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('editing a queue', () => {
  it('renames it', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'PATCH',
      url: '/cases/catalogue/cat-email',
      payload: { name: 'Email & mailboxes', description: 'Anything about mail.' },
    });

    expect(response.statusCode).toBe(200);
    expect(categoryTable.rows.find((row) => row.id === 'cat-email')).toMatchObject({
      name: 'Email & mailboxes',
      description: 'Anything about mail.',
    });
  });

  it('takes the subcategories down with a retired category', async () => {
    const app = await appAs();

    await app.inject({
      method: 'PATCH',
      url: '/cases/catalogue/cat-email',
      payload: { isActive: false },
    });

    // Otherwise a reader that forgets to check the parent offers a queue that
    // cannot be reached.
    expect(categoryTable.rows.find((row) => row.id === 'sub-signin')?.isActive).toBe(false);
  });

  it('refuses a rename onto a name already used at that level', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'PATCH',
      url: '/cases/catalogue/cat-fax',
      payload: { name: 'Email' },
    });

    expect(response.statusCode).toBe(422);
    expect(categoryTable.rows.find((row) => row.id === 'cat-fax')?.name).toBe('Fax');
  });

  it('is a 404 for a category in another company', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'PATCH',
      url: '/cases/catalogue/cat-somebody-elses',
      payload: { name: 'Mine now' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('deleting a queue', () => {
  it('deletes one nothing has ever been filed under', async () => {
    const app = await appAs();

    const response = await app.inject({ method: 'DELETE', url: '/cases/catalogue/cat-salary' });

    expect(response.statusCode).toBe(204);
    expect(categoryTable.rows.find((row) => row.id === 'cat-salary')).toBeUndefined();
  });

  it('refuses one with cases behind it, and says to retire it instead', async () => {
    db.case.count.mockResolvedValue(7);
    const app = await appAs();

    const response = await app.inject({ method: 'DELETE', url: '/cases/catalogue/cat-email' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('Retire it');
    expect(categoryTable.rows.find((row) => row.id === 'cat-email')).toBeDefined();
  });

  it('counts a subcategory\'s cases against its parent', async () => {
    const app = await appAs();

    await app.inject({ method: 'DELETE', url: '/cases/catalogue/cat-email' });

    // Both ids go into the count, so a parent whose only cases are on a child
    // is still protected.
    const where = db.case.count.mock.calls[0]?.[0] as { where: { OR: Array<Record<string, unknown>> } };
    expect(JSON.stringify(where)).toContain('sub-signin');
  });
});
