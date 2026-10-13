import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, formatCaseNumber, type Permission } from '@hrms/shared';

/**
 * Who hears about a case, end to end through both sides of the module.
 *
 * The desk used to learn about a new case only by opening the queue, and an
 * "assigned to you" notification led to the employee's own-case screen, which
 * 404s for anybody but the requester. These pin the replacement:
 *
 *   - a new case reaches its department's own desk and head - never the rest
 *     of the department - or, failing both, the company-wide dispatchers;
 *   - one notification per account however many ways it qualifies;
 *   - assignment tells the new assignee and not the old one, and the new
 *     assignee can open the case even when it is filed outside their own
 *     department, while the old one stops being able to;
 *   - the requester's reply goes to whoever holds the case, or its queue;
 *   - every desk notification carries the `CaseDesk` entity, so the bell opens
 *     the desk's view of the case rather than the requester's.
 */

const { table } = await import('./case-store.test-kit.js');

const COMPANY = 'company-1';

const DEPARTMENTS = [
  { id: 'dep-it', companyId: COMPANY, name: 'IT', isActive: true, headEmployeeId: null as string | null },
  { id: 'dep-fin', companyId: COMPANY, name: 'Finance', isActive: true, headEmployeeId: null as string | null },
  { id: 'dep-acc', companyId: COMPANY, name: 'Accounts', isActive: true, headEmployeeId: null as string | null },
];

const CATEGORIES = [
  { id: 'cat-it-laptop', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: null, name: 'Laptop', description: null, sortOrder: 0, isActive: true },
  { id: 'sub-it-screen', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: 'cat-it-laptop', name: 'Screen', description: null, sortOrder: 0, isActive: true },
  { id: 'cat-fin-salary', companyId: COMPANY, departmentId: 'dep-fin', parentCategoryId: null, name: 'Salary', description: null, sortOrder: 0, isActive: true },
  { id: 'cat-acc-claims', companyId: COMPANY, departmentId: 'dep-acc', parentCategoryId: null, name: 'Claims', description: null, sortOrder: 0, isActive: true },
];

const DESK: Permission[] = [
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];
const DISPATCHER: Permission[] = [...DESK, PERMISSIONS.CASE_READ_ALL, PERMISSIONS.CASE_ASSIGN];
const EMPLOYEE: Permission[] = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_REPLY_OWN,
  PERMISSIONS.CASE_REOPEN_OWN,
];

interface Person {
  userId: string;
  employeeId: string;
  departmentId: string | null;
  name: string;
  grants: Permission[];
}

/** The IT desk is one person; Finance has one; Accounts has nobody. */
const IT_AGENT: Person = { userId: 'u-aziz', employeeId: 'e-aziz', departmentId: 'dep-it', name: 'Aziz Qadir', grants: [...EMPLOYEE, ...DESK] };
const IT_SECOND: Person = { userId: 'u-imran', employeeId: 'e-imran', departmentId: 'dep-it', name: 'Imran Khan', grants: [...EMPLOYEE, ...DESK] };
const IT_PLAIN: Person = { userId: 'u-it-plain', employeeId: 'e-it-plain', departmentId: 'dep-it', name: 'Plain Coder', grants: EMPLOYEE };
const FIN_AGENT: Person = { userId: 'u-sana', employeeId: 'e-sana', departmentId: 'dep-fin', name: 'Sana Iqbal', grants: [...EMPLOYEE, ...DESK] };
const ADMIN: Person = { userId: 'u-admin', employeeId: 'e-admin', departmentId: null, name: 'Super Admin', grants: [...EMPLOYEE, ...DISPATCHER] };
/** Reads everything but cannot hand anything on: not a dispatcher. */
const AUDITOR: Person = { userId: 'u-audit', employeeId: 'e-audit', departmentId: null, name: 'Read Only', grants: [PERMISSIONS.CASE_READ_ALL] };
const REQUESTER: Person = { userId: 'u-ayesha', employeeId: 'e-ayesha', departmentId: 'dep-fin', name: 'Ayesha Khan', grants: EMPLOYEE };
const OTHER_EMPLOYEE: Person = { userId: 'u-bilal', employeeId: 'e-bilal', departmentId: 'dep-fin', name: 'Bilal Ahmed', grants: EMPLOYEE };

const PEOPLE = [IT_AGENT, IT_SECOND, IT_PLAIN, FIN_AGENT, ADMIN, AUDITOR, REQUESTER, OTHER_EMPLOYEE];
const DESK_READS: string[] = [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL];

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  department: { findFirst: vi.fn() },
  caseCategory: { findFirst: vi.fn() },
  case: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  caseMessage: { findMany: vi.fn(), create: vi.fn() },
  caseAttachment: { findMany: vi.fn() },
  notification: { create: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/mail/index.js', () => ({
  resolveEmailProvider: () => ({
    name: 'console',
    send: async () => ({ delivered: false, provider: 'console' }),
  }),
  emailErrorCode: () => 'none',
}));

const { caseRoutes } = await import('./cases.routes.js');
const { caseDeskRoutes } = await import('./case-desk.routes.js');
const { caseQueueOwners } = await import('./case-notify.service.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(person: Person): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: person.userId,
      companyId: COMPANY,
      email: `${person.userId}@example.com`,
      permissions: new Set(person.grants),
      dataScope: 'OWN',
      mustChangePassword: false,
    };
  });
  await app.register(caseRoutes, { prefix: '/cases' });
  await app.register(caseDeskRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

function personRow(person: Person) {
  const [firstName, lastName] = person.name.split(' ');
  return {
    id: person.userId,
    firstName,
    lastName,
    employee: {
      id: person.employeeId,
      departmentId: person.departmentId,
      department: person.departmentId
        ? { name: DEPARTMENTS.find((d) => d.id === person.departmentId)?.name ?? '' }
        : null,
    },
    userRoles: [
      { role: { rolePermissions: person.grants.map((key) => ({ permission: { key } })) } },
    ],
  };
}

let caseTable: ReturnType<typeof table>;

function caseRow(over: Partial<Record<string, unknown>> = {}) {
  const departmentId = (over.departmentId as string) ?? 'dep-it';
  const categoryId = (over.categoryId as string) ?? 'cat-it-laptop';
  return {
    id: 'case-1',
    companyId: COMPANY,
    caseNumber: formatCaseNumber(2026, 1),
    requesterEmployeeId: REQUESTER.employeeId,
    departmentId,
    categoryId,
    subcategoryId: null,
    subject: 'Laptop screen flickers',
    description: 'Since this morning the screen flickers every few seconds.',
    priority: 'NORMAL',
    status: 'OPEN',
    assignedUserId: null,
    assignedAt: null,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    updatedAt: new Date('2026-10-01T09:00:00.000Z'),
    lastMessageAt: null,
    resolvedAt: null,
    closedAt: null,
    requester: {
      id: REQUESTER.employeeId,
      firstName: 'Ayesha',
      lastName: 'Khan',
      displayName: null,
      employeeNumber: '1001',
      workEmail: 'ayesha@example.com',
      userId: REQUESTER.userId,
      department: { id: 'dep-fin', name: 'Finance' },
    },
    department: { id: departmentId, name: DEPARTMENTS.find((d) => d.id === departmentId)?.name },
    category: { id: categoryId, name: CATEGORIES.find((c) => c.id === categoryId)?.name },
    subcategory: null,
    assignedTo: null,
    _count: { messages: 0, attachments: 0 },
    ...over,
  };
}

/** Every notification written, as recipient + entity + title. */
function sent() {
  type Written = { data: { userId: string; entityType: string; entityId: string; title: string } };
  return db.notification.create.mock.calls.map((call) => (call[0] as Written).data);
}
const recipients = (entityType = 'CaseDesk') =>
  sent()
    .filter((n) => n.entityType === entityType)
    .map((n) => n.userId)
    .sort();

beforeEach(() => {
  vi.clearAllMocks();
  for (const d of DEPARTMENTS) d.headEmployeeId = null;

  caseTable = table([]);
  const messageTable = table([]);
  const departmentTable = table(DEPARTMENTS);
  const categoryTable = table(CATEGORIES);

  db.case.findFirst.mockImplementation(caseTable.findFirst);
  db.case.findMany.mockImplementation(caseTable.findMany);
  db.case.count.mockImplementation(caseTable.count);
  db.case.update.mockImplementation(caseTable.update);
  db.case.groupBy.mockImplementation(caseTable.groupBy);
  db.case.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    const row = caseRow({ ...args.data, id: `case-${caseTable.rows.length + 1}` });
    caseTable.rows.push(row);
    return Promise.resolve(row);
  });
  db.caseMessage.findMany.mockImplementation(async (args: Parameters<typeof messageTable.findMany>[0]) =>
    (await messageTable.findMany(args)).map((row) => ({ sender: null, attachments: [], ...row })),
  );
  db.caseMessage.create.mockImplementation(messageTable.create);
  db.caseAttachment.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({ id: 'n-1' });
  db.auditLog.create.mockResolvedValue({ id: 'a-1' });

  db.employee.findFirst.mockImplementation((args: { where: { userId?: string } }) => {
    const match = PEOPLE.find((p) => p.userId === args.where.userId);
    return Promise.resolve(match ? { id: match.employeeId, departmentId: match.departmentId } : null);
  });
  db.department.findFirst.mockImplementation(departmentTable.findFirst);
  db.caseCategory.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const row = await categoryTable.findFirst(args as never);
    return row ? { ...row, department: DEPARTMENTS.find((d) => d.id === row.departmentId) } : null;
  });

  // The relational "holds a desk grant" filter is not modelled by the kit, so
  // it is applied here from the same grants the sessions carry.
  const deskPeople = PEOPLE.filter((p) => p.grants.some((g) => DESK_READS.includes(g)));
  db.user.findMany.mockImplementation(() => Promise.resolve(deskPeople.map(personRow)));
  db.user.findFirst.mockImplementation((args: { where: { id?: string } }) => {
    const match = deskPeople.find((p) => p.userId === args.where.id);
    return Promise.resolve(match ? personRow(match) : null);
  });
});

async function raiseItCase(): Promise<string> {
  const app = await appAs(REQUESTER);
  const response = await app.inject({
    method: 'POST',
    url: '/cases',
    payload: {
      departmentId: 'dep-it',
      categoryId: 'cat-it-laptop',
      subcategoryId: 'sub-it-screen',
      subject: 'Laptop screen flickers',
      description: 'Since this morning the screen flickers every few seconds.',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ data: { id: string } }>().data.id;
}

// -----------------------------------------------------------------------------

describe('a new case reaches its queue owners', () => {
  it('tells the IT desk about an IT case, through the desk view, and nobody else in IT', async () => {
    const id = await raiseItCase();

    expect(recipients()).toEqual([IT_SECOND.userId, IT_AGENT.userId].sort());
    // Not the IT employee without a desk grant, not Finance's desk, and not
    // the dispatchers, because IT has a desk of its own.
    expect(recipients()).not.toContain(IT_PLAIN.userId);
    expect(recipients()).not.toContain(FIN_AGENT.userId);
    expect(recipients()).not.toContain(ADMIN.userId);

    const desk = sent().find((n) => n.userId === IT_AGENT.userId);
    expect(desk).toMatchObject({ entityType: 'CaseDesk', entityId: id });
    expect(desk?.title).toContain('New case');

    // The requester still gets their receipt, pointing at their own view.
    expect(recipients('Case')).toEqual([REQUESTER.userId]);
  });

  it('the IT agent opens the case from the notification, and sees it as unassigned in the queue', async () => {
    const id = await raiseItCase();
    const app = await appAs(IT_AGENT);

    const detail = await app.inject({ method: 'GET', url: `/cases/queue/${id}` });
    const unassigned = await app.inject({ method: 'GET', url: '/cases/queue?assignee=unassigned&live=true' });
    const summary = await app.inject({ method: 'GET', url: '/cases/queue/summary' });

    expect(detail.statusCode).toBe(200);
    expect(unassigned.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([id]);
    expect(summary.json<{ data: { unassigned: number } }>().data.unassigned).toBe(1);
  });

  it('adds the department head when they can work the case, and tells them once', async () => {
    DEPARTMENTS[0]!.headEmployeeId = IT_AGENT.employeeId; // head AND desk member

    await raiseItCase();

    expect(recipients().filter((u) => u === IT_AGENT.userId)).toHaveLength(1);
  });

  it('skips a department head who could not open the case', async () => {
    DEPARTMENTS[0]!.headEmployeeId = IT_PLAIN.employeeId;

    await raiseItCase();

    expect(recipients()).not.toContain(IT_PLAIN.userId);
  });

  it('falls back to the company-wide dispatchers when the department has no desk', async () => {
    const owners = await caseQueueOwners(COMPANY, 'dep-acc');

    // Read-all AND assign; a read-only account cannot hand the case on.
    expect(owners).toEqual([ADMIN.userId]);
    expect(owners).not.toContain(AUDITOR.userId);
  });

  it('does not tell the person who raised it, even when they sit on that desk', async () => {
    const app = await appAs(IT_AGENT);
    await app.inject({
      method: 'POST',
      url: '/cases',
      payload: {
        departmentId: 'dep-it',
        categoryId: 'cat-it-laptop',
        subject: 'My own laptop',
        description: 'Raised by the IT agent about their own machine.',
      },
    });

    expect(recipients()).toEqual([IT_SECOND.userId]);
  });
});

describe('assignment and reassignment', () => {
  it('tells the new assignee, not the old one, and moves who can open it', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const admin = await appAs(ADMIN);

    // Handed across departments, to Finance's agent.
    const response = await admin.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: FIN_AGENT.userId },
    });

    expect(response.statusCode).toBe(200);
    expect(recipients()).toEqual([FIN_AGENT.userId]);
    expect(sent()[0]?.title).toContain('assigned to you');
    expect(caseTable.rows[0]?.assignedAt).toBeInstanceOf(Date);

    // The new assignee reaches it although it is filed with IT...
    const sana = await appAs(FIN_AGENT);
    expect((await sana.inject({ method: 'GET', url: '/cases/queue/case-it' })).statusCode).toBe(200);
    const mine = await sana.inject({ method: 'GET', url: '/cases/queue?assignee=me&live=true' });
    expect(mine.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual(['case-it']);

    // ...and Finance's own cases stay Finance's: the reach is the assignment.
    const aziz = await appAs(IT_AGENT);
    const azizMine = await aziz.inject({ method: 'GET', url: '/cases/queue?assignee=me' });
    expect(azizMine.json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('takes the reach away from an out-of-department assignee once reassigned', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: FIN_AGENT.userId }));
    const admin = await appAs(ADMIN);

    await admin.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: IT_AGENT.userId },
    });

    const sana = await appAs(FIN_AGENT);
    expect((await sana.inject({ method: 'GET', url: '/cases/queue/case-it' })).statusCode).toBe(404);
    expect(recipients()).toEqual([IT_AGENT.userId]);
  });

  it('puts an unassigned case in front of the queue owners', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId, assignedAt: new Date() }));
    const admin = await appAs(ADMIN);

    await admin.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: null },
    });

    expect(caseTable.rows[0]?.assignedAt).toBeNull();
    expect(recipients()).toEqual([IT_AGENT.userId, IT_SECOND.userId].sort());
    expect(sent()[0]?.title).toContain('unassigned');
  });

  it('tells the new department when a case is routed to it', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const aziz = await appAs({ ...IT_AGENT, grants: [...IT_AGENT.grants] });

    const response = await aziz.inject({
      method: 'POST',
      url: '/cases/queue/case-it/route',
      payload: { departmentId: 'dep-fin', categoryId: 'cat-fin-salary', subcategoryId: null },
    });

    expect(response.statusCode).toBe(200);
    expect(recipients()).toEqual([FIN_AGENT.userId]);
    // The requester is told too, on their own view.
    expect(recipients('Case')).toEqual([REQUESTER.userId]);
  });

  it('tells the assignee when somebody else moves or re-prioritises their case', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const admin = await appAs(ADMIN);

    await admin.inject({ method: 'POST', url: '/cases/queue/case-it/priority', payload: { priority: 'URGENT' } });
    await admin.inject({ method: 'POST', url: '/cases/queue/case-it/status', payload: { status: 'IN_PROGRESS' } });

    expect(recipients()).toEqual([IT_AGENT.userId, IT_AGENT.userId]);
  });

  it('asks the requester for more information when the case goes to Pending', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const aziz = await appAs(IT_AGENT);

    await aziz.inject({ method: 'POST', url: '/cases/queue/case-it/status', payload: { status: 'PENDING' } });

    const toRequester = sent().find((n) => n.userId === REQUESTER.userId);
    expect(toRequester?.title).toContain('waiting on you');
    // Aziz moved it himself, so Aziz is not told about it.
    expect(recipients()).toEqual([]);
  });
});

describe('the requester answering', () => {
  it('goes to the assignee alone while somebody holds the case', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const app = await appAs(REQUESTER);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/case-it/messages',
      payload: { message: 'It is still flickering.' },
    });

    expect(response.statusCode).toBe(201);
    expect(recipients()).toEqual([IT_AGENT.userId]);
  });

  it('goes to the queue owners while nobody does', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', status: 'RESOLVED' }));
    const app = await appAs(REQUESTER);

    await app.inject({
      method: 'POST',
      url: '/cases/case-it/reopen',
      payload: { reason: 'It started again after lunch.' },
    });

    expect(recipients()).toEqual([IT_AGENT.userId, IT_SECOND.userId].sort());
  });
});

describe('nobody reads a case they have no claim on', () => {
  it('refuses the desk view to an employee, and the requester view to anybody but the requester', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));

    const other = await appAs(OTHER_EMPLOYEE);
    expect((await other.inject({ method: 'GET', url: '/cases/queue/case-it' })).statusCode).toBe(403);
    expect((await other.inject({ method: 'GET', url: '/cases/case-it' })).statusCode).toBe(404);

    // The assignee reads it on the desk, not as if it were their own case.
    const aziz = await appAs(IT_AGENT);
    expect((await aziz.inject({ method: 'GET', url: '/cases/case-it' })).statusCode).toBe(404);
    expect((await aziz.inject({ method: 'GET', url: '/cases/queue/case-it' })).statusCode).toBe(200);
  });

  it('keeps a departmental agent off another department’s unassigned cases', async () => {
    caseTable.rows.push(caseRow({ id: 'case-fin', departmentId: 'dep-fin', categoryId: 'cat-fin-salary' }));

    const aziz = await appAs(IT_AGENT);
    expect((await aziz.inject({ method: 'GET', url: '/cases/queue/case-fin' })).statusCode).toBe(404);
    const list = await aziz.inject({ method: 'GET', url: '/cases/queue' });
    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
  });
});
