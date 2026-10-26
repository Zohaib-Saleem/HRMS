import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CASE_STATUSES,
  PERMISSIONS,
  canRequesterReopen,
  canRequesterReply,
  canRequesterTransition,
  canTransitionCase,
  formatCaseNumber,
  parseCaseNumberSequence,
  safeAttachmentName,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * The employee's side of the cases module.
 *
 * Phase 1 gives an employee four things - raise a case, watch it, reply to it,
 * reopen it - and the security story behind all four is the same sentence: the
 * requester comes from the session and goes into the WHERE clause. These tests
 * drive the endpoints the way anybody with a session cookie and a terminal
 * would, and pin the boundaries no UI can enforce:
 *
 *   - a case is raised FOR the caller. The body carries no employee id, and
 *     adding one changes nothing;
 *   - one employee cannot read, reply to or reopen another's case, with a valid
 *     id, a valid attachment id, or both;
 *   - a guessed id answers 404, not 403 - a 403 would confirm the id exists;
 *   - the routing is re-read on the server: a category that belongs to another
 *     department, or a subcategory that belongs to another category, is refused
 *     however convincing the request looked;
 *   - the four permissions are four permissions. Holding `case.read.own` does
 *     not let you raise one, and holding `case.create` does not let you reopen.
 *
 * The Prisma stand-in evaluates the route's real `where` against real rows (see
 * `case-store.test-kit`), so a route that dropped the requester id would fail
 * these rather than passing them with a wider query.
 */

const { table } = await import('./case-store.test-kit.js');

const COMPANY = 'company-1';

/** Two employees in one company. Everything below is about the gap between them. */
const ME = { id: 'emp-me', userId: 'user-me' };
const COLLEAGUE = { id: 'emp-colleague', userId: 'user-colleague' };

const DEPARTMENTS = [
  { id: 'dep-it', companyId: COMPANY, name: 'IT', isActive: true },
  { id: 'dep-fin', companyId: COMPANY, name: 'Finance', isActive: true },
  { id: 'dep-old', companyId: COMPANY, name: 'Archive', isActive: false },
];

const CATEGORIES = [
  // IT
  { id: 'cat-it-email', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: null, name: 'Email', description: null, sortOrder: 0, isActive: true },
  { id: 'cat-it-laptop', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: null, name: 'Computer / Laptop', description: null, sortOrder: 1, isActive: true },
  { id: 'sub-it-signin', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: 'cat-it-email', name: 'Cannot sign in', description: null, sortOrder: 0, isActive: true },
  // Finance
  { id: 'cat-fin-salary', companyId: COMPANY, departmentId: 'dep-fin', parentCategoryId: null, name: 'Salary', description: null, sortOrder: 0, isActive: true },
  { id: 'sub-fin-amount', companyId: COMPANY, departmentId: 'dep-fin', parentCategoryId: 'cat-fin-salary', name: 'Incorrect amount', description: null, sortOrder: 0, isActive: true },
  // Retired, so it must not appear on the form and must not be usable.
  { id: 'cat-it-retired', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: null, name: 'Fax', description: null, sortOrder: 9, isActive: false },
];

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  user: { findMany: vi.fn() },
  department: { findFirst: vi.fn(), findMany: vi.fn() },
  caseCategory: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  // No routing rules unless a test sets one: a queue nobody configured
  // behaves exactly as it did before rules existed.
  caseRoutingRule: { findMany: vi.fn(async (_args: never): Promise<unknown[]> => []) },
  case: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  caseMessage: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  caseAttachment: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  notification: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  /** The route builds an array of prisma calls; the mocks resolve immediately. */
  $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));
// The mail side of a notification is not what these tests are about, and
// resolving a provider reads the environment.
vi.mock('../../core/mail/index.js', () => ({
  resolveEmailProvider: () => ({ name: 'console', send: async () => ({ delivered: false, provider: 'console' }) }),
  emailErrorCode: () => 'none',
}));

const { caseRoutes } = await import('./cases.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** What the Employee system role actually holds for cases. */
const EMPLOYEE: Permission[] = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_REPLY_OWN,
  PERMISSIONS.CASE_REOPEN_OWN,
];

async function appAs(
  permissions: Permission[] = EMPLOYEE,
  userId: string = ME.userId,
  dataScope: DataScope = 'OWN',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: COMPANY,
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(caseRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

// --- the world the routes see ------------------------------------------------

const employeeRow = (id: string) => ({
  id,
  firstName: id === ME.id ? 'Ayesha' : 'Bilal',
  lastName: id === ME.id ? 'Khan' : 'Ahmed',
  displayName: null,
  employeeNumber: id === ME.id ? '1001' : '1002',
});

let caseTable: ReturnType<typeof table>;
let messageTable: ReturnType<typeof table>;
let attachmentTable: ReturnType<typeof table>;

/**
 * One case row, shaped the way `CASE_INCLUDE` returns it.
 *
 * The relations are baked in rather than joined, because what these tests are
 * about is the WHERE clause, not Prisma's join planner.
 */
function caseRow(over: Partial<Record<string, unknown>> = {}) {
  const departmentId = (over.departmentId as string) ?? 'dep-it';
  const categoryId = (over.categoryId as string) ?? 'cat-it-email';
  const requesterEmployeeId = (over.requesterEmployeeId as string) ?? ME.id;
  const department = DEPARTMENTS.find((d) => d.id === departmentId);
  const category = CATEGORIES.find((c) => c.id === categoryId);

  return {
    id: 'case-1',
    companyId: COMPANY,
    caseNumber: formatCaseNumber(2026, 1),
    requesterEmployeeId,
    departmentId,
    categoryId,
    subcategoryId: null,
    subject: 'Cannot sign in to email',
    description: 'My mailbox stopped accepting my password this morning.',
    priority: 'NORMAL',
    status: 'OPEN',
    assignedUserId: null,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-01T09:00:00.000Z'),
    lastMessageAt: null,
    resolvedAt: null,
    closedAt: null,
    // relations
    requester: employeeRow(requesterEmployeeId),
    department: { id: departmentId, name: department?.name ?? 'IT' },
    category: { id: categoryId, name: category?.name ?? 'Email' },
    subcategory: null,
    assignedTo: null,
    _count: { messages: 0, attachments: 0 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  caseTable = table([]);
  messageTable = table([]);
  attachmentTable = table([]);

  db.case.findFirst.mockImplementation(caseTable.findFirst);
  db.case.findMany.mockImplementation(caseTable.findMany);
  db.case.count.mockImplementation(caseTable.count);
  db.case.update.mockImplementation(caseTable.update);
  db.case.groupBy.mockImplementation(caseTable.groupBy);
  db.caseMessage.findMany.mockImplementation(messageTable.findMany);
  db.caseMessage.findFirst.mockImplementation(messageTable.findFirst);
  db.caseMessage.create.mockImplementation(messageTable.create);
  db.caseAttachment.findMany.mockImplementation(attachmentTable.findMany);
  db.caseAttachment.findFirst.mockImplementation(attachmentTable.findFirst);
  db.caseAttachment.count.mockImplementation(attachmentTable.count);

  /*
   * A create that allocates the number the route asked for and materialises the
   * relations, so the response shape is the real one rather than a stub.
   */
  db.case.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    const row = caseRow({ ...args.data, id: `case-${caseTable.rows.length + 1}` });
    caseTable.rows.push(row);
    return Promise.resolve(row);
  });

  // The session's employee record. Resolved by userId, exactly as the route does.
  db.employee.findFirst.mockImplementation((args: { where: { userId?: string } }) => {
    const match = [ME, COLLEAGUE].find((e) => e.userId === args.where.userId);
    return Promise.resolve(match ? { id: match.id } : null);
  });

  const departmentTable = table(DEPARTMENTS);
  const categoryTable = table(CATEGORIES);
  db.department.findFirst.mockImplementation(departmentTable.findFirst);
  db.department.findMany.mockImplementation(departmentTable.findMany);
  db.caseCategory.findFirst.mockImplementation(categoryTable.findFirst);
  // The catalogue endpoint selects the department relation; bake it in.
  db.caseCategory.findMany.mockImplementation(async (args: Parameters<typeof categoryTable.findMany>[0]) => {
    const rows = await categoryTable.findMany({
      // `department: { isActive: true }` is a relation filter the test kit does
      // not model, so it is applied here instead of being silently ignored.
      ...args,
      where: stripRelationFilter(args?.where),
    });
    return rows
      .filter((row) => DEPARTMENTS.find((d) => d.id === row.departmentId)?.isActive)
      .map((row) => ({
        ...row,
        department: DEPARTMENTS.find((d) => d.id === row.departmentId),
      }));
  });

  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.notification.create.mockResolvedValue({ id: 'notification-1' });
  // Nobody holds a desk grant unless a test says so.
  db.user.findMany.mockResolvedValue([]);
});

/** Removes `department: {...}`, which is a join rather than a column. */
function stripRelationFilter(where: unknown): unknown {
  if (!where || typeof where !== 'object') return where;
  const { department: _relation, ...rest } = where as Record<string, unknown>;
  return rest;
}

const json = (response: { payload: string }) => JSON.parse(response.payload) as Record<string, never>;

// -----------------------------------------------------------------------------

describe('the case number', () => {
  it('reads as CASE-<year>-<six digits>, and is not a uuid', () => {
    expect(formatCaseNumber(2026, 1)).toBe('CASE-2026-000001');
    expect(formatCaseNumber(2026, 42)).toBe('CASE-2026-000042');
    expect(formatCaseNumber(2026, 1_234_567)).toBe('CASE-2026-1234567');
  });

  it('round-trips its sequence, and refuses a number from another year', () => {
    expect(parseCaseNumberSequence('CASE-2026-000007', 2026)).toBe(7);
    expect(parseCaseNumberSequence('CASE-2025-000007', 2026)).toBeNull();
    expect(parseCaseNumberSequence('CASE-2026-00ab07', 2026)).toBeNull();
    expect(parseCaseNumberSequence('not-a-case-number', 2026)).toBeNull();
  });

  it('gives consecutive cases consecutive numbers', async () => {
    const app = await appAs();

    const body = {
      departmentId: 'dep-it',
      categoryId: 'cat-it-email',
      subject: 'Mail is down',
      description: 'Nothing has arrived since nine this morning.',
    };

    const first = await app.inject({ method: 'POST', url: '/cases', payload: body });
    const second = await app.inject({ method: 'POST', url: '/cases', payload: body });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const year = new Date().getUTCFullYear();
    expect(json(first).data).toMatchObject({ caseNumber: formatCaseNumber(year, 1) });
    expect(json(second).data).toMatchObject({ caseNumber: formatCaseNumber(year, 2) });
  });

  it('retries onto the next number when another request took it first', async () => {
    const app = await appAs();

    /*
     * The race, made deterministic: the first insert fails the unique index the
     * way PostgreSQL would, and the route must read again and try again rather
     * than failing somebody's case with a conflict they did not cause.
     */
    let attempts = 0;
    db.case.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      attempts += 1;
      if (attempts === 1) {
        // Somebody else committed CASE-<year>-000001 between our read and write.
        caseTable.rows.push(caseRow({ id: 'case-theirs', requesterEmployeeId: COLLEAGUE.id }));
        return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }));
      }
      const row = caseRow({ ...args.data, id: 'case-mine' });
      caseTable.rows.push(row);
      return Promise.resolve(row);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: {
        departmentId: 'dep-it',
        categoryId: 'cat-it-email',
        subject: 'Mail is down',
        description: 'Nothing has arrived since nine this morning.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(attempts).toBe(2);
    expect(json(response).data).toMatchObject({
      caseNumber: formatCaseNumber(new Date().getUTCFullYear(), 2),
    });
  });
});

describe('raising a case', () => {
  const VALID = {
    departmentId: 'dep-it',
    categoryId: 'cat-it-email',
    subcategoryId: 'sub-it-signin',
    subject: 'Cannot sign in to email',
    description: 'My mailbox stopped accepting my password this morning.',
    priority: 'HIGH' as const,
  };

  it('records it against the CALLER, whatever the body says', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      // The two fields somebody would reach for to raise a case as another
      // person. Neither is in the schema, so both are stripped before the
      // route ever sees them.
      payload: { ...VALID, requesterEmployeeId: COLLEAGUE.id, employeeId: COLLEAGUE.id },
    });

    expect(response.statusCode).toBe(201);
    expect(db.case.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requesterEmployeeId: ME.id, companyId: COMPANY }),
      }),
    );
  });

  it('starts every new case OPEN', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'POST', url: '/cases', payload: VALID });

    expect(json(response).data).toMatchObject({ status: 'OPEN' });
  });

  it('defaults the priority to NORMAL when none is chosen', async () => {
    const app = await appAs();
    const { priority: _omitted, ...withoutPriority } = VALID;

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: withoutPriority,
    });

    expect(response.statusCode).toBe(201);
    expect(json(response).data).toMatchObject({ priority: 'NORMAL' });
  });

  it('refuses a priority that is not one of the four', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { ...VALID, priority: 'CRITICAL' },
    });

    expect(response.statusCode).toBe(422);
    expect(json(response).error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('refuses a case with no subject or no description', async () => {
    const app = await appAs();

    for (const payload of [
      { ...VALID, subject: '' },
      { ...VALID, description: 'short' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/cases', payload });
      expect(response.statusCode).toBe(422);
    }
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('writes an audit entry and a notification for the requester', async () => {
    const app = await appAs();
    await app.inject({ method: 'POST', url: '/cases', payload: VALID });

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'case.create',
          entityType: 'Case',
          companyId: COMPANY,
          actorId: ME.userId,
        }),
      }),
    );
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'CASE_UPDATE', userId: ME.userId }),
      }),
    );
  });
});

describe('department and category validation', () => {
  const base = {
    subject: 'Something is wrong',
    description: 'A description long enough to satisfy the schema.',
  };

  it('refuses a department that is not this company&apos;s, or is inactive', async () => {
    const app = await appAs();

    for (const departmentId of ['dep-somewhere-else', 'dep-old']) {
      const response = await app.inject({
        method: 'POST',
        url: '/cases',
        payload: { ...base, departmentId, categoryId: 'cat-it-email' },
      });
      expect(response.statusCode).toBe(422);
      expect(json(response).error).toMatchObject({
        details: expect.objectContaining({ departmentId: expect.any(Array) }),
      });
    }
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('refuses a category that belongs to a DIFFERENT department', async () => {
    const app = await appAs();

    // Finance's Salary queue, filed as an IT case. The dropdowns would never
    // produce this; a hand-built request would.
    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { ...base, departmentId: 'dep-it', categoryId: 'cat-fin-salary' },
    });

    expect(response.statusCode).toBe(422);
    expect(json(response).error).toMatchObject({
      details: expect.objectContaining({ categoryId: expect.any(Array) }),
    });
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('refuses a SUBCATEGORY passed off as a category', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { ...base, departmentId: 'dep-it', categoryId: 'sub-it-signin' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('refuses a subcategory belonging to another category', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: {
        ...base,
        departmentId: 'dep-it',
        categoryId: 'cat-it-email',
        subcategoryId: 'sub-fin-amount',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(json(response).error).toMatchObject({
      details: expect.objectContaining({ subcategoryId: expect.any(Array) }),
    });
    expect(db.case.create).not.toHaveBeenCalled();
  });

  it('refuses a retired category', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { ...base, departmentId: 'dep-it', categoryId: 'cat-it-retired' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('accepts a category with no subcategory chosen', async () => {
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases',
      payload: { ...base, departmentId: 'dep-fin', categoryId: 'cat-fin-salary' },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe('the catalogue', () => {
  it('offers the company&apos;s own departments, with their queues nested', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/categories' });

    expect(response.statusCode).toBe(200);
    const data = json(response).data as unknown as Array<{
      departmentName: string;
      categories: Array<{ name: string; subcategories: Array<{ name: string }> }>;
    }>;

    expect(data.map((d) => d.departmentName)).toEqual(['Finance', 'IT']);

    const it = data.find((d) => d.departmentName === 'IT');
    expect(it?.categories.map((c) => c.name)).toEqual(['Email', 'Computer / Laptop']);
    // Retired queues are absent, so nothing on the form can select one.
    expect(it?.categories.map((c) => c.name)).not.toContain('Fax');
    expect(it?.categories[0]?.subcategories.map((s) => s.name)).toEqual(['Cannot sign in']);
  });
});

describe('my cases', () => {
  beforeEach(() => {
    caseTable.rows.push(
      caseRow({
        id: 'case-mine-1',
        caseNumber: 'CASE-2026-000001',
        subject: 'Laptop will not start',
        categoryId: 'cat-it-laptop',
        departmentId: 'dep-it',
        priority: 'URGENT',
        status: 'OPEN',
        createdAt: new Date('2026-09-01T09:00:00.000Z'),
      }),
      caseRow({
        id: 'case-mine-2',
        caseNumber: 'CASE-2026-000002',
        subject: 'Salary short by one day',
        categoryId: 'cat-fin-salary',
        departmentId: 'dep-fin',
        priority: 'NORMAL',
        status: 'RESOLVED',
        createdAt: new Date('2026-09-05T09:00:00.000Z'),
      }),
      caseRow({
        id: 'case-mine-3',
        caseNumber: 'CASE-2026-000003',
        subject: 'New mailbox for a joiner',
        priority: 'LOW',
        status: 'PENDING',
        createdAt: new Date('2026-09-10T09:00:00.000Z'),
      }),
      // The colleague's. Present in the table precisely so the list has
      // something to wrongly include.
      caseRow({
        id: 'case-theirs',
        caseNumber: 'CASE-2026-000004',
        subject: 'Parking slot request',
        requesterEmployeeId: COLLEAGUE.id,
        createdAt: new Date('2026-09-11T09:00:00.000Z'),
      }),
    );
  });

  it('returns only the caller&apos;s own cases', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases' });

    const body = json(response) as unknown as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.data.map((row) => row.id).sort()).toEqual([
      'case-mine-1',
      'case-mine-2',
      'case-mine-3',
    ]);
    expect(body.meta.total).toBe(3);
  });

  it('does not widen for a caller with a company-wide data scope', async () => {
    /*
     * The claim that matters most in this file. A data scope is granted for
     * line-management reasons and is not a reason to read what somebody asked
     * HR about, so ALL must buy exactly nothing here.
     */
    const app = await appAs(EMPLOYEE, ME.userId, 'ALL');
    const response = await app.inject({ method: 'GET', url: '/cases' });

    const body = json(response) as unknown as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(3);
    expect(body.data.map((row) => row.id)).not.toContain('case-theirs');
  });

  it('pages server-side rather than sending everything', async () => {
    const app = await appAs();

    const page1 = await app.inject({ method: 'GET', url: '/cases?page=1&limit=2' });
    const page2 = await app.inject({ method: 'GET', url: '/cases?page=2&limit=2' });

    const first = json(page1) as unknown as { data: unknown[]; meta: Record<string, number> };
    const second = json(page2) as unknown as { data: unknown[]; meta: Record<string, number> };

    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(1);
    expect(first.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });

    // The colleague's case is not on page two, or anywhere else.
    const ids = [...(first.data as Array<{ id: string }>), ...(second.data as Array<{ id: string }>)];
    expect(ids.map((row) => row.id)).not.toContain('case-theirs');
  });

  it('searches the case number and the subject, and nothing else', async () => {
    const app = await appAs();

    const byNumber = await app.inject({ method: 'GET', url: '/cases?q=000002' });
    expect((json(byNumber) as unknown as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual([
      'case-mine-2',
    ]);

    const bySubject = await app.inject({ method: 'GET', url: '/cases?q=laptop' });
    expect((json(bySubject) as unknown as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual([
      'case-mine-1',
    ]);

    // The description is deliberately not searched - it would make the index
    // useless and turn the search box into a way to confirm a case's contents.
    const byDescription = await app.inject({ method: 'GET', url: '/cases?q=password' });
    expect((json(byDescription) as unknown as { data: unknown[] }).data).toHaveLength(0);
  });

  it('cannot be searched into somebody else&apos;s case', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases?q=parking' });

    expect((json(response) as unknown as { data: unknown[] }).data).toHaveLength(0);
  });

  it('filters by status, priority, department, category and date range', async () => {
    const app = await appAs();

    const ids = async (query: string) => {
      const response = await app.inject({ method: 'GET', url: `/cases?${query}` });
      return (json(response) as unknown as { data: Array<{ id: string }> }).data.map((r) => r.id);
    };

    expect(await ids('status=RESOLVED')).toEqual(['case-mine-2']);
    expect(await ids('priority=URGENT')).toEqual(['case-mine-1']);
    expect(await ids('departmentId=dep-fin')).toEqual(['case-mine-2']);
    expect(await ids('categoryId=cat-it-laptop')).toEqual(['case-mine-1']);
    expect((await ids('from=2026-09-05&to=2026-09-10')).sort()).toEqual([
      'case-mine-2',
      'case-mine-3',
    ]);
    // The whole of the closing day is included, not just its first instant.
    expect(await ids('from=2026-09-10&to=2026-09-10')).toEqual(['case-mine-3']);
  });

  it('refuses a status or priority filter that is not one of ours', async () => {
    const app = await appAs();

    for (const query of ['status=BANANA', 'priority=WHENEVER']) {
      const response = await app.inject({ method: 'GET', url: `/cases?${query}` });
      expect(response.statusCode).toBe(422);
    }
  });
});

describe('one case', () => {
  beforeEach(() => {
    caseTable.rows.push(
      caseRow({ id: 'case-mine', caseNumber: 'CASE-2026-000001' }),
      caseRow({
        id: 'case-theirs',
        caseNumber: 'CASE-2026-000002',
        requesterEmployeeId: COLLEAGUE.id,
      }),
    );
    messageTable.rows.push(
      {
        id: 'msg-visible',
        companyId: COMPANY,
        caseId: 'case-mine',
        senderUserId: ME.userId,
        message: 'Any news?',
        isInternal: false,
        createdAt: new Date('2026-09-02T09:00:00.000Z'),
        sender: { id: ME.userId, firstName: 'Ayesha', lastName: 'Khan' },
        attachments: [],
      },
      {
        id: 'msg-internal',
        companyId: COMPANY,
        caseId: 'case-mine',
        senderUserId: 'user-agent',
        message: 'Requester is on the old VPN build, do not tell them yet.',
        isInternal: true,
        createdAt: new Date('2026-09-02T10:00:00.000Z'),
        sender: { id: 'user-agent', firstName: 'IT', lastName: 'Desk' },
        attachments: [],
      },
    );
  });

  it('opens the caller&apos;s own case, with its conversation', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/case-mine' });

    expect(response.statusCode).toBe(200);
    const data = json(response).data as unknown as {
      caseNumber: string;
      description: string;
      messages: Array<{ id: string; fromRequester: boolean; internal: boolean }>;
    };
    expect(data.caseNumber).toBe('CASE-2026-000001');
    expect(data.description).toContain('mailbox');
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]).toMatchObject({ id: 'msg-visible', fromRequester: true });
  });

  it('never returns a staff-only note, even as a filtered-out field', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/case-mine' });

    // Absent from the response, not merely hidden in it: the phrase itself is
    // nowhere in the bytes that reached the browser.
    expect(response.payload).not.toContain('old VPN build');
    expect(db.caseMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isInternal: false }) }),
    );
  });

  it('answers 404 - not 403 - for a colleague&apos;s case', async () => {
    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/case-theirs' });

    /*
     * A 403 would confirm that `case-theirs` exists, which is precisely the
     * fact somebody changing the id in the URL is trying to establish.
     */
    expect(response.statusCode).toBe(404);
    expect(json(response).error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers 404 for an id from another company', async () => {
    caseTable.rows.push(
      caseRow({ id: 'case-other-tenant', companyId: 'company-2', requesterEmployeeId: ME.id }),
    );

    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/case-other-tenant' });

    expect(response.statusCode).toBe(404);
  });

  it('puts the requester id in the query rather than checking it afterwards', async () => {
    const app = await appAs();
    await app.inject({ method: 'GET', url: '/cases/case-mine' });

    expect(db.case.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'case-mine',
          companyId: COMPANY,
          requesterEmployeeId: ME.id,
        }),
      }),
    );
  });
});

describe('replying', () => {
  beforeEach(() => {
    caseTable.rows.push(
      caseRow({ id: 'case-mine' }),
      caseRow({ id: 'case-theirs', requesterEmployeeId: COLLEAGUE.id }),
      caseRow({ id: 'case-resolved', status: 'RESOLVED' }),
      caseRow({ id: 'case-closed', status: 'CLOSED' }),
    );
  });

  it('adds a reply to the caller&apos;s own case', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-mine/messages',
      payload: { message: 'It is still happening this morning.' },
    });

    expect(response.statusCode).toBe(201);
    expect(db.caseMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: 'case-mine',
          senderUserId: ME.userId,
          message: 'It is still happening this morning.',
        }),
      }),
    );
  });

  it('writes the reply as visible, whatever the body asked for', async () => {
    const app = await appAs();
    await app.inject({
      method: 'POST',
      url: '/cases/case-mine/messages',
      // There is no `internal` field in the schema, and the route writes false
      // unconditionally - so an employee cannot smuggle a staff-only note in.
      payload: { message: 'Still broken.', internal: true, isInternal: true },
    });

    expect(db.caseMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isInternal: false }) }),
    );
  });

  it('moves the case&apos;s last-activity stamp, so the list is honest', async () => {
    const app = await appAs();
    await app.inject({
      method: 'POST',
      url: '/cases/case-mine/messages',
      payload: { message: 'Any update?' },
    });

    expect(db.case.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'case-mine' },
        data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
      }),
    );
  });

  it('cannot reply to a colleague&apos;s case', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-theirs/messages',
      payload: { message: 'Let me help with that.' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.caseMessage.create).not.toHaveBeenCalled();
  });

  it('still takes a reply on a RESOLVED case', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-resolved/messages',
      payload: { message: 'That did not fix it.' },
    });

    // The most useful sentence on a helpdesk. Making somebody reopen the case
    // before they can say it buries it.
    expect(response.statusCode).toBe(201);
  });

  it('refuses a reply on a CLOSED case, and says what to do instead', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-closed/messages',
      payload: { message: 'Hello?' },
    });

    expect(response.statusCode).toBe(409);
    expect(json(response).error).toMatchObject({ message: expect.stringContaining('Reopen') });
  });

  it('refuses an empty reply', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-mine/messages',
      payload: { message: '   ' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('does not write the reply text into the audit log', async () => {
    const app = await appAs();
    await app.inject({
      method: 'POST',
      url: '/cases/case-mine/messages',
      payload: { message: 'My bank account number is on the payslip attached.' },
    });

    const audit = db.auditLog.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> };
    expect(audit.data.action).toBe('case.reply');
    expect(JSON.stringify(audit.data)).not.toContain('bank account number');
  });
});

describe('reopening', () => {
  beforeEach(() => {
    caseTable.rows.push(
      caseRow({ id: 'case-open', status: 'OPEN' }),
      caseRow({
        id: 'case-resolved',
        status: 'RESOLVED',
        resolvedAt: new Date('2026-09-08T09:00:00.000Z'),
      }),
      caseRow({
        id: 'case-closed',
        status: 'CLOSED',
        resolvedAt: new Date('2026-09-08T09:00:00.000Z'),
        closedAt: new Date('2026-09-09T09:00:00.000Z'),
      }),
      caseRow({ id: 'case-theirs', status: 'RESOLVED', requesterEmployeeId: COLLEAGUE.id }),
    );
  });

  it('reopens a resolved case and clears its settlement dates', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-resolved/reopen',
      payload: { reason: 'The mailbox locked again overnight.' },
    });

    expect(response.statusCode).toBe(200);
    expect(json(response).data).toMatchObject({ status: 'REOPENED' });
    expect(db.case.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REOPENED',
          resolvedAt: null,
          closedAt: null,
        }),
      }),
    );
  });

  it('reopens a closed case too', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-closed/reopen',
      payload: { reason: 'It came back a week later.' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('keeps the reason as the first message of the reopened conversation', async () => {
    const app = await appAs();
    await app.inject({
      method: 'POST',
      url: '/cases/case-resolved/reopen',
      payload: { reason: 'The mailbox locked again overnight.' },
    });

    expect(db.caseMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: 'The mailbox locked again overnight.',
          isInternal: false,
        }),
      }),
    );
  });

  it('refuses to reopen a case that was never settled', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-open/reopen',
      payload: { reason: 'Trying my luck.' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.case.update).not.toHaveBeenCalled();
  });

  it('cannot reopen a colleague&apos;s case', async () => {
    const app = await appAs();
    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-theirs/reopen',
      payload: { reason: 'Helping out.' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.case.update).not.toHaveBeenCalled();
  });

  it('records the status change in the audit trail', async () => {
    const app = await appAs();
    await app.inject({
      method: 'POST',
      url: '/cases/case-resolved/reopen',
      payload: { reason: 'The mailbox locked again overnight.' },
    });

    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'case.status.change',
          entityType: 'Case',
          entityId: 'case-resolved',
        }),
      }),
    );
  });
});

describe('the status workflow', () => {
  it('lets a requester reopen a settled case and nothing else', () => {
    for (const status of CASE_STATUSES) {
      const settled = status === 'RESOLVED' || status === 'CLOSED';
      expect(canRequesterReopen(status)).toBe(settled);

      // The transitions a requester may make are a strict subset of the ones
      // the workflow allows at all, and REOPENED is the only one in it.
      for (const target of CASE_STATUSES) {
        if (canRequesterTransition(status, target)) {
          expect(target).toBe('REOPENED');
          expect(canTransitionCase(status, target)).toBe(true);
        }
      }
    }
  });

  it('takes a reply on everything but a closed case', () => {
    for (const status of CASE_STATUSES) {
      expect(canRequesterReply(status)).toBe(status !== 'CLOSED');
    }
  });

  it('leaves no status stranded - every one can still reach an end', () => {
    for (const status of CASE_STATUSES) {
      if (status === 'CLOSED') {
        expect(canTransitionCase(status, 'REOPENED')).toBe(true);
        continue;
      }
      expect(
        CASE_STATUSES.some((target) => target !== status && canTransitionCase(status, target)),
      ).toBe(true);
    }
  });
});

describe('the dashboard summary', () => {
  it('counts the caller&apos;s own cases by status, in the database', async () => {
    caseTable.rows.push(
      caseRow({ id: 'c1', status: 'OPEN' }),
      caseRow({ id: 'c2', status: 'OPEN' }),
      caseRow({ id: 'c3', status: 'PENDING' }),
      caseRow({ id: 'c4', status: 'RESOLVED' }),
      caseRow({ id: 'c5', status: 'IN_PROGRESS' }),
      // Four of the colleague's, which must appear in none of the figures.
      caseRow({ id: 'c6', status: 'OPEN', requesterEmployeeId: COLLEAGUE.id }),
      caseRow({ id: 'c7', status: 'RESOLVED', requesterEmployeeId: COLLEAGUE.id }),
    );

    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/summary' });

    expect(response.statusCode).toBe(200);
    expect(json(response).data).toMatchObject({
      counts: { OPEN: 2, IN_PROGRESS: 1, PENDING: 1, ON_HOLD: 0, RESOLVED: 1, CLOSED: 0, REOPENED: 0 },
      live: 4,
      total: 5,
    });

    // Counted, not fetched. A card that paged through cases to tally them would
    // be wrong the moment somebody had more than a page of them.
    expect(db.case.groupBy).toHaveBeenCalled();
    expect(db.case.findMany).not.toHaveBeenCalled();
  });

  it('answers zeroes for a login with no employee record', async () => {
    const app = await appAs(EMPLOYEE, 'user-with-no-employee');
    const response = await app.inject({ method: 'GET', url: '/cases/summary' });

    expect(response.statusCode).toBe(200);
    expect(json(response).data).toMatchObject({ total: 0, live: 0 });
  });

  it('is matched ahead of /cases/:id', async () => {
    // `summary` is a static segment, so Fastify must not read it as an id.
    caseTable.rows.push(caseRow({ id: 'summary' }));

    const app = await appAs();
    const response = await app.inject({ method: 'GET', url: '/cases/summary' });

    expect(json(response).data).toHaveProperty('counts');
  });
});

describe('permission enforcement', () => {
  beforeEach(() => {
    caseTable.rows.push(caseRow({ id: 'case-mine', status: 'RESOLVED' }));
  });

  const body = {
    departmentId: 'dep-it',
    categoryId: 'cat-it-email',
    subject: 'A subject',
    description: 'A description long enough to satisfy the schema.',
  };

  it('refuses every route to a signed-in caller with no case grants', async () => {
    const app = await appAs([]);

    const calls: Array<[string, string, unknown]> = [
      ['GET', '/cases', undefined],
      ['GET', '/cases/summary', undefined],
      ['GET', '/cases/case-mine', undefined],
      ['GET', '/cases/categories', undefined],
      ['POST', '/cases', body],
      ['POST', '/cases/case-mine/messages', { message: 'Hello' }],
      ['POST', '/cases/case-mine/reopen', { reason: 'Still broken' }],
    ];

    for (const [method, url, payload] of calls) {
      const response = await app.inject({ method: method as 'GET', url, payload: payload as never });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('keeps the four grants genuinely separate', async () => {
    // Read only: can look, cannot raise, reply or reopen.
    const reader = await appAs([PERMISSIONS.CASE_READ_OWN]);
    expect((await reader.inject({ method: 'GET', url: '/cases' })).statusCode).toBe(200);
    expect((await reader.inject({ method: 'POST', url: '/cases', payload: body })).statusCode).toBe(403);
    expect(
      (await reader.inject({ method: 'POST', url: '/cases/case-mine/messages', payload: { message: 'Hi' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await reader.inject({ method: 'POST', url: '/cases/case-mine/reopen', payload: { reason: 'Nope' } }))
        .statusCode,
    ).toBe(403);

    // Create only: can raise, cannot read the list back.
    const creator = await appAs([PERMISSIONS.CASE_CREATE]);
    expect((await creator.inject({ method: 'POST', url: '/cases', payload: body })).statusCode).toBe(201);
    expect((await creator.inject({ method: 'GET', url: '/cases' })).statusCode).toBe(403);

    // Reply without reopen.
    const replier = await appAs([PERMISSIONS.CASE_READ_OWN, PERMISSIONS.CASE_REPLY_OWN]);
    expect(
      (await replier.inject({ method: 'POST', url: '/cases/case-mine/messages', payload: { message: 'Hi' } }))
        .statusCode,
    ).toBe(201);
    expect(
      (await replier.inject({ method: 'POST', url: '/cases/case-mine/reopen', payload: { reason: 'Broken' } }))
        .statusCode,
    ).toBe(403);
  });

  it('reports what the caller may do, from their permissions', async () => {
    const reader = await appAs([PERMISSIONS.CASE_READ_OWN]);
    const asReader = json(await reader.inject({ method: 'GET', url: '/cases/case-mine' })).data;
    expect(asReader).toMatchObject({ canReply: false, canReopen: false, canAttach: false });

    const full = await appAs(EMPLOYEE);
    const asEmployee = json(await full.inject({ method: 'GET', url: '/cases/case-mine' })).data;
    expect(asEmployee).toMatchObject({ canReply: true, canReopen: true, canAttach: true });
  });
});

describe('the attachment filename sanitiser', () => {
  it('keeps an ordinary name intact', () => {
    expect(safeAttachmentName('payslip-march 2026.pdf')).toBe('payslip-march 2026.pdf');
  });

  it('turns a path into a label', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('etc-passwd');
    expect(safeAttachmentName('C:\\Users\\me\\secret.txt')).toBe('C-Users-me-secret.txt');
  });

  it('refuses to produce a dotfile or an empty name', () => {
    expect(safeAttachmentName('.bashrc')).toBe('bashrc');
    expect(safeAttachmentName('...')).toBe('attachment');
    expect(safeAttachmentName('')).toBe('attachment');
    expect(safeAttachmentName('   ')).toBe('attachment');
  });

  it('strips what would break a Content-Disposition header', () => {
    const cleaned = safeAttachmentName('re"port\r\nSet-Cookie: a=b.pdf');
    expect(cleaned).not.toContain('"');
    expect(cleaned).not.toMatch(/[\r\n]/);
  });

  it('caps the length', () => {
    expect(safeAttachmentName(`${'a'.repeat(400)}.pdf`)).toHaveLength(150);
  });
});
