import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSIONS,
  canDeskReply,
  canTransitionCase,
  formatCaseNumber,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * The desk's side of the cases module.
 *
 * The employee tests next door pin one sentence: the requester goes in the
 * WHERE clause. These pin the other one: the caller's QUEUES go in the WHERE
 * clause, and the two sentences never meet.
 *
 * What is actually at stake here is worth stating, because it is the whole
 * reason this side of the module is a separate set of routes:
 *
 *   - a departmental agent sees their department's cases and no others. Not on
 *     a list, not by id, not through an attachment, and not because they also
 *     hold a wide DataScope for employee records;
 *   - a case outside the caller's queues answers 404, never 403 - a refusal
 *     would confirm the case exists, which is the fact a guesser is after;
 *   - an internal note is written only by somebody holding the grant for it,
 *     is never sent to the requester, and is never implied to them by a
 *     notification about the status change it accompanied;
 *   - the workflow is the shared transition map. A status the map does not
 *     allow is refused however the request was built;
 *   - a case cannot be assigned to somebody who could not open it.
 *
 * The Prisma stand-in evaluates the route's real `where` against real rows (see
 * `case-store.test-kit`), so a route that dropped the scope clause would fail
 * these rather than passing them with a wider query.
 */

const { table } = await import('./case-store.test-kit.js');

const COMPANY = 'company-1';

/** Two departments, and an agent on exactly one of them. */
const DEPARTMENTS = [
  { id: 'dep-it', companyId: COMPANY, name: 'IT', isActive: true },
  { id: 'dep-fin', companyId: COMPANY, name: 'Finance', isActive: true },
];

const CATEGORIES = [
  { id: 'cat-it-email', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: null, name: 'Email', description: null, sortOrder: 0, isActive: true },
  { id: 'sub-it-signin', companyId: COMPANY, departmentId: 'dep-it', parentCategoryId: 'cat-it-email', name: 'Cannot sign in', description: null, sortOrder: 0, isActive: true },
  { id: 'cat-fin-salary', companyId: COMPANY, departmentId: 'dep-fin', parentCategoryId: null, name: 'Salary', description: null, sortOrder: 0, isActive: true },
];

/** The IT agent, the Finance agent, the helpdesk manager, and the requester. */
const IT_AGENT = { userId: 'user-it', employeeId: 'emp-it', departmentId: 'dep-it' };
const FIN_AGENT = { userId: 'user-fin', employeeId: 'emp-fin', departmentId: 'dep-fin' };
const ROVING = { userId: 'user-roving', employeeId: 'emp-roving', departmentId: null };
const REQUESTER = { userId: 'user-emp', employeeId: 'emp-1', departmentId: 'dep-fin' };

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn() },
  department: { findFirst: vi.fn(), findMany: vi.fn() },
  caseCategory: { findFirst: vi.fn(), findMany: vi.fn() },
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  case: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
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

const { caseDeskRoutes } = await import('./case-desk.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** What a full member of the desk holds, short of the company-wide read. */
const DESK: Permission[] = [
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_ASSIGN,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];

async function appAs(
  permissions: Permission[] = DESK,
  userId: string = IT_AGENT.userId,
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
      email: 'agent@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(caseDeskRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

// --- the world the routes see ------------------------------------------------

let caseTable: ReturnType<typeof table>;
let messageTable: ReturnType<typeof table>;

function caseRow(over: Partial<Record<string, unknown>> = {}) {
  const departmentId = (over.departmentId as string) ?? 'dep-it';
  const categoryId = (over.categoryId as string) ?? 'cat-it-email';
  const department = DEPARTMENTS.find((d) => d.id === departmentId);
  const category = CATEGORIES.find((c) => c.id === categoryId);

  return {
    id: 'case-1',
    companyId: COMPANY,
    caseNumber: formatCaseNumber(2026, 1),
    requesterEmployeeId: REQUESTER.employeeId,
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
    department: { id: departmentId, name: department?.name ?? 'IT' },
    category: { id: categoryId, name: category?.name ?? 'Email' },
    subcategory: null,
    assignedTo: null,
    _count: { messages: 0, attachments: 0 },
    ...over,
  };
}

/**
 * A desk member as both user lookups read them: the assignable-agents list
 * (name, department name) and `caseQueueOwners` (department id, grants).
 */
function deskUser(
  who: { userId: string; employeeId: string; departmentId: string | null },
  firstName: string,
  lastName: string,
  departmentName: string,
  grants: Permission[] = DESK,
) {
  return {
    id: who.userId,
    firstName,
    lastName,
    employee: { id: who.employeeId, departmentId: who.departmentId, department: { name: departmentName } },
    userRoles: [{ role: { rolePermissions: grants.map((key) => ({ permission: { key } })) } }],
  };
}

/** The agents' own employee records, which is where their department comes from. */
const AGENT_EMPLOYEES = [IT_AGENT, FIN_AGENT, ROVING, REQUESTER];

beforeEach(() => {
  vi.clearAllMocks();

  caseTable = table([]);
  messageTable = table([]);

  db.case.findFirst.mockImplementation(caseTable.findFirst);
  db.case.findMany.mockImplementation(caseTable.findMany);
  db.case.count.mockImplementation(caseTable.count);
  db.case.update.mockImplementation(caseTable.update);
  db.case.groupBy.mockImplementation(caseTable.groupBy);
  db.caseMessage.findMany.mockImplementation(messageTable.findMany);
  db.caseMessage.create.mockImplementation(messageTable.create);
  db.caseAttachment.findMany.mockResolvedValue([]);
  db.notification.create.mockResolvedValue({ id: 'notification-1' });
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });

  db.employee.findFirst.mockImplementation((args: { where: { userId?: string } }) => {
    const match = AGENT_EMPLOYEES.find((e) => e.userId === args.where.userId);
    return Promise.resolve(match ? { id: match.employeeId, departmentId: match.departmentId } : null);
  });

  const departmentTable = table(DEPARTMENTS);
  const categoryTable = table(CATEGORIES);
  db.department.findFirst.mockImplementation(departmentTable.findFirst);
  db.caseCategory.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const row = await categoryTable.findFirst(args as never);
    if (!row) return null;
    return {
      ...row,
      name: row.name,
      department: DEPARTMENTS.find((d) => d.id === row.departmentId),
    };
  });

  /*
   * The assignable-agents lookup asks for users whose roles carry a desk grant.
   * The relation filter is not something the test kit models, so the two people
   * who hold one are answered directly - what these tests are about is that the
   * route ASKS, and refuses anybody the answer does not contain.
   */
  const deskUsers = [
    deskUser(IT_AGENT, 'Bilal', 'Ahmed', 'IT'),
    deskUser(FIN_AGENT, 'Sana', 'Iqbal', 'Finance'),
  ];
  db.user.findMany.mockResolvedValue(deskUsers);
  db.user.findFirst.mockImplementation((args: { where: { id?: string } }) =>
    Promise.resolve(deskUsers.find((user) => user.id === args.where.id) ?? null),
  );
});

/** Both departments' cases, so every scope assertion has something to exclude. */
function seedBothQueues() {
  caseTable.rows.push(
    caseRow({ id: 'case-it', departmentId: 'dep-it', subject: 'Email is down' }),
    caseRow({ id: 'case-fin', departmentId: 'dep-fin', categoryId: 'cat-fin-salary', subject: 'Salary short' }),
  );
}

describe('the queue is the caller\'s own', () => {
  it('shows a departmental agent their department and nothing else', async () => {
    seedBothQueues();
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/queue' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: Array<{ id: string }> }>();
    expect(body.data.map((row) => row.id)).toEqual(['case-it']);
  });

  it('shows every department to a caller holding the company-wide grant', async () => {
    seedBothQueues();
    const app = await appAs([PERMISSIONS.CASE_READ_ALL]);

    const response = await app.inject({ method: 'GET', url: '/cases/queue' });

    const body = response.json<{ data: Array<{ id: string }> }>();
    expect(body.data.map((row) => row.id).sort()).toEqual(['case-fin', 'case-it']);
  });

  it('answers 404 for a case in another department, with a valid id', async () => {
    seedBothQueues();
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/queue/case-fin' });

    // Not 403: a refusal would confirm the case exists.
    expect(response.statusCode).toBe(404);
  });

  it('shows nothing to an agent whose own record has no department', async () => {
    seedBothQueues();
    const app = await appAs(DESK, ROVING.userId);

    const list = await app.inject({ method: 'GET', url: '/cases/queue' });
    const detail = await app.inject({ method: 'GET', url: '/cases/queue/case-it' });

    expect(list.json<{ data: unknown[] }>().data).toEqual([]);
    expect(detail.statusCode).toBe(404);
  });

  it('refuses the queue entirely without a read grant', async () => {
    seedBothQueues();
    const app = await appAs([PERMISSIONS.CASE_READ_OWN, PERMISSIONS.CASE_CREATE]);

    const response = await app.inject({ method: 'GET', url: '/cases/queue' });

    expect(response.statusCode).toBe(403);
  });

  it('is not widened by a company-wide DataScope for employee records', async () => {
    seedBothQueues();
    // The scope that lets somebody read every employee record in the company.
    const app = await appAs(DESK, IT_AGENT.userId, 'ALL');

    const response = await app.inject({ method: 'GET', url: '/cases/queue' });

    expect(response.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([
      'case-it',
    ]);
  });

  it('filters to mine, to unassigned, and to what is still live', async () => {
    caseTable.rows.push(
      caseRow({ id: 'case-mine', assignedUserId: IT_AGENT.userId }),
      caseRow({ id: 'case-theirs', assignedUserId: FIN_AGENT.userId }),
      caseRow({ id: 'case-nobody' }),
      caseRow({ id: 'case-done', status: 'CLOSED' }),
    );
    const app = await appAs();

    const mine = await app.inject({ method: 'GET', url: '/cases/queue?assignee=me' });
    const unassigned = await app.inject({ method: 'GET', url: '/cases/queue?assignee=unassigned' });
    const live = await app.inject({ method: 'GET', url: '/cases/queue?live=true' });

    expect(mine.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([
      'case-mine',
    ]);
    // Unassigned on its own says nothing about status, so the closed one is in
    // it too - that is what `live` is for, and the two filters compose.
    expect(
      unassigned.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id).sort(),
    ).toEqual(['case-done', 'case-nobody']);
    expect(live.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).not.toContain(
      'case-done',
    );
  });

  it('searches by who raised a case, which is how the desk looks for one', async () => {
    caseTable.rows.push(
      caseRow({ id: 'case-ayesha', subject: 'Laptop dead' }),
      caseRow({
        id: 'case-other',
        subject: 'Printer jam',
        requester: {
          id: 'emp-2',
          firstName: 'Usman',
          lastName: 'Tariq',
          displayName: null,
          employeeNumber: '1002',
          workEmail: null,
          userId: 'user-usman',
          department: { id: 'dep-it', name: 'IT' },
        },
      }),
    );
    const app = await appAs();

    const byName = await app.inject({ method: 'GET', url: '/cases/queue?q=ayesha' });
    const byNumber = await app.inject({ method: 'GET', url: '/cases/queue?q=1002' });

    expect(byName.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([
      'case-ayesha',
    ]);
    expect(byNumber.json<{ data: Array<{ id: string }> }>().data.map((r) => r.id)).toEqual([
      'case-other',
    ]);
  });

  it('is ordered worst-first unless somebody asks otherwise', async () => {
    seedBothQueues();
    const app = await appAs();

    await app.inject({ method: 'GET', url: '/cases/queue' });
    const byDefault = db.case.findMany.mock.calls[0]?.[0] as { orderBy: unknown };

    await app.inject({ method: 'GET', url: '/cases/queue?sort=createdAt&order=asc' });
    const asked = db.case.findMany.mock.calls[1]?.[0] as { orderBy: unknown };

    /*
     * Asserted as the ORDER BY that was sent rather than as the order of the
     * rows that came back, deliberately. `priority desc` is worst-first because
     * PostgreSQL orders an enum by its declaration order, which no in-memory
     * stand-in reproduces - a test that sorted these rows itself would be
     * testing the stand-in's alphabet.
     */
    expect(byDefault.orderBy).toEqual([{ priority: 'desc' }, { createdAt: 'asc' }]);
    expect(asked.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('counts the queue over the caller\'s own scope', async () => {
    caseTable.rows.push(
      caseRow({ id: 'case-it-1', status: 'OPEN', priority: 'URGENT' }),
      caseRow({ id: 'case-it-2', status: 'IN_PROGRESS', assignedUserId: IT_AGENT.userId }),
      caseRow({ id: 'case-it-3', status: 'CLOSED' }),
      caseRow({ id: 'case-fin-1', departmentId: 'dep-fin', status: 'OPEN' }),
    );
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/queue/summary' });

    const summary = response.json<{
      data: { live: number; unassigned: number; mine: number; urgent: number };
    }>().data;
    // The Finance case is in none of these numbers.
    expect(summary.live).toBe(2);
    expect(summary.unassigned).toBe(1);
    expect(summary.mine).toBe(1);
    expect(summary.urgent).toBe(1);
  });
});

describe('what the desk can see on a case', () => {
  it('returns internal notes, which the employee endpoint does not', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    messageTable.rows.push(
      {
        id: 'msg-public',
        caseId: 'case-it',
        senderUserId: REQUESTER.userId,
        message: 'Still cannot sign in.',
        isInternal: false,
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        sender: { id: REQUESTER.userId, firstName: 'Ayesha', lastName: 'Khan' },
        attachments: [],
      },
      {
        id: 'msg-note',
        caseId: 'case-it',
        senderUserId: IT_AGENT.userId,
        message: 'Account was locked by the password policy.',
        isInternal: true,
        createdAt: new Date('2026-09-01T10:05:00.000Z'),
        sender: { id: IT_AGENT.userId, firstName: 'Bilal', lastName: 'Ahmed' },
        attachments: [],
      },
    );
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/queue/case-it' });

    const detail = response.json<{
      data: {
        messages: Array<{ id: string; internal: boolean; fromRequester: boolean }>;
        requesterEmail: string | null;
        abilities: { nextStatuses: string[]; canNote: boolean };
      };
    }>().data;

    expect(detail.messages.map((m) => m.id)).toEqual(['msg-public', 'msg-note']);
    expect(detail.messages.find((m) => m.id === 'msg-note')?.internal).toBe(true);
    // Whose words they are is judged against the REQUESTER's account, not the
    // reader's - so the employee's message is still the employee's.
    expect(detail.messages.find((m) => m.id === 'msg-public')?.fromRequester).toBe(true);
    expect(detail.requesterEmail).toBe('ayesha@example.com');
    expect(detail.abilities.canNote).toBe(true);
    expect(detail.abilities.nextStatuses).toContain('IN_PROGRESS');
  });

  it('offers no transitions to somebody who cannot move a case', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs([PERMISSIONS.CASE_READ_DEPARTMENT]);

    const response = await app.inject({ method: 'GET', url: '/cases/queue/case-it' });

    const abilities = response.json<{ data: { abilities: Record<string, unknown> } }>().data
      .abilities;
    expect(abilities.nextStatuses).toEqual([]);
    expect(abilities.canUpdate).toBe(false);
    expect(abilities.canRespond).toBe(false);
  });

  it('does not hand the desk the requester\'s own controls', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', status: 'RESOLVED' }));
    // Everybody holds the `.own` grants, agents included - for their OWN cases.
    const app = await appAs([...DESK, PERMISSIONS.CASE_REPLY_OWN, PERMISSIONS.CASE_REOPEN_OWN]);

    const response = await app.inject({ method: 'GET', url: '/cases/queue/case-it' });

    const detail = response.json<{
      data: { canReply: boolean; canReopen: boolean; canAttach: boolean };
    }>().data;
    expect(detail).toMatchObject({ canReply: false, canReopen: false, canAttach: false });
  });
});

describe('moving a case along', () => {
  it('records the change, writes an event and tells the requester', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'IN_PROGRESS', note: 'Looking at it now.' },
    });

    expect(response.statusCode).toBe(200);
    expect(caseTable.rows[0]?.status).toBe('IN_PROGRESS');

    // The event, and the agent's own note, in the conversation.
    expect(messageTable.rows.map((row) => row.message)).toEqual([
      'Status changed from Open to In progress.',
      'Looking at it now.',
    ]);
    expect(messageTable.rows[0]?.senderUserId).toBeNull();
    expect(messageTable.rows[1]?.senderUserId).toBe(IT_AGENT.userId);

    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'CASE_UPDATE', userId: REQUESTER.userId }),
      }),
    );
  });

  it('refuses a transition the shared map does not allow', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', status: 'CLOSED' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'IN_PROGRESS' },
    });

    expect(canTransitionCase('CLOSED', 'IN_PROGRESS')).toBe(false);
    expect(response.statusCode).toBe(409);
    expect(caseTable.rows[0]?.status).toBe('CLOSED');
  });

  it('refuses a status the case is already in', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', status: 'OPEN' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'OPEN' },
    });

    expect(response.statusCode).toBe(409);
  });

  it('stamps a resolution and clears it again on the way back', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'RESOLVED' },
    });
    expect(caseTable.rows[0]?.resolvedAt).toBeInstanceOf(Date);

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'REOPENED' },
    });
    // A live case must never carry a resolution date: it would put one on a
    // report about work that is still going on.
    expect(caseTable.rows[0]?.resolvedAt).toBeNull();
    expect(caseTable.rows[0]?.closedAt).toBeNull();
  });

  it('refuses an internal note from somebody without the grant for one', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs([
      PERMISSIONS.CASE_READ_DEPARTMENT,
      PERMISSIONS.CASE_UPDATE,
      PERMISSIONS.CASE_RESPOND,
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'ON_HOLD', note: 'Vendor is slow.', internal: true },
    });

    // Refused rather than quietly published to the requester.
    expect(response.statusCode).toBe(403);
    expect(caseTable.rows[0]?.status).toBe('OPEN');
  });

  it('never puts an internal note into the requester\'s notification', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'ON_HOLD', note: 'Waiting on the vendor we are dropping.', internal: true },
    });

    const notification = db.notification.create.mock.calls[0]?.[0] as
      | { data: { message: string } }
      | undefined;
    expect(notification?.data.message).not.toContain('vendor');
    expect(messageTable.rows.at(-1)?.isInternal).toBe(true);
  });

  it('cannot be done from another department', async () => {
    caseTable.rows.push(caseRow({ id: 'case-fin', departmentId: 'dep-fin' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/status',
      payload: { status: 'IN_PROGRESS' },
    });

    expect(response.statusCode).toBe(404);
    expect(caseTable.rows[0]?.status).toBe('OPEN');
  });
});

describe('assigning', () => {
  it('assigns, unassigns, and tells the person who was handed it', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    const assigned = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: FIN_AGENT.userId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(caseTable.rows[0]?.assignedUserId).toBe(FIN_AGENT.userId);
    expect(db.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: FIN_AGENT.userId, type: 'CASE_UPDATE' }),
      }),
    );

    // Null is a real value: putting a case back is something people do.
    const cleared = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(caseTable.rows[0]?.assignedUserId).toBeNull();
  });

  it('does not notify somebody about their own click', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: IT_AGENT.userId },
    });

    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it('refuses somebody who could not open the case', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    db.user.findFirst.mockResolvedValue(null);
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: REQUESTER.userId },
    });

    // A case assigned into a hole looks handled and is not.
    expect(response.statusCode).toBe(422);
    expect(caseTable.rows[0]?.assignedUserId).toBeNull();
  });

  it('keeps the assignable list to people who hold a desk grant', async () => {
    const app = await appAs();

    const response = await app.inject({ method: 'GET', url: '/cases/queue/agents' });

    expect(response.statusCode).toBe(200);
    const where = db.user.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(JSON.stringify(where)).toContain('case.read.department');
    expect(response.json<{ data: Array<{ userId: string }> }>().data).toHaveLength(2);
  });
});

describe('replying and noting', () => {
  it('sends a reply to the requester and notifies them', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Your account is unlocked - try again.' },
    });

    expect(response.statusCode).toBe(201);
    expect(messageTable.rows[0]?.isInternal).toBe(false);
    expect(db.notification.create).toHaveBeenCalled();
  });

  it('writes a note without notifying anybody', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Second time this month for this user.', internal: true },
    });

    expect(messageTable.rows[0]?.isInternal).toBe(true);
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it('needs the reply grant to reach the requester', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs([PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_NOTE_INTERNAL]);

    const reply = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Hello.' },
    });
    const note = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Hello.', internal: true },
    });

    expect(reply.statusCode).toBe(403);
    expect(note.statusCode).toBe(201);
  });

  it('needs the note grant to write a note', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs([PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_RESPOND]);

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Between us.', internal: true },
    });

    expect(response.statusCode).toBe(403);
    expect(messageTable.rows).toHaveLength(0);
  });

  it('takes nothing on a closed case', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', status: 'CLOSED' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'One more thing.' },
    });

    expect(canDeskReply('CLOSED')).toBe(false);
    expect(response.statusCode).toBe(409);
  });
});

describe('re-routing a misfiled case', () => {
  it('moves it, unassigns it and tells the requester', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it', assignedUserId: IT_AGENT.userId }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/route',
      payload: {
        departmentId: 'dep-fin',
        categoryId: 'cat-fin-salary',
        note: 'This is a payroll question, not an email one.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(caseTable.rows[0]).toMatchObject({
      departmentId: 'dep-fin',
      categoryId: 'cat-fin-salary',
      // The old owner is on the old desk; leaving them on it would hide the
      // case from the new department's unassigned queue.
      assignedUserId: null,
    });
    expect(db.notification.create).toHaveBeenCalled();
  });

  it('refuses a category that belongs to another department', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/route',
      payload: { departmentId: 'dep-fin', categoryId: 'cat-it-email' },
    });

    expect(response.statusCode).toBe(422);
    expect(caseTable.rows[0]?.departmentId).toBe('dep-it');
  });

  it('refuses a move to where the case already is', async () => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
    const app = await appAs();

    const response = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/route',
      payload: { departmentId: 'dep-it', categoryId: 'cat-it-email' },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('the company-wide desk', () => {
  /**
   * What the `Helpdesk Manager` role actually is: `case.read.all` plus the four
   * action grants. Deliberately played by the agent whose own employee record
   * has NO department, because that is the claim worth pinning - a company-wide
   * reader does not depend on where they sit on the org chart, which is the
   * whole reason the role exists for desks nobody is recorded against.
   */
  const MANAGER: Permission[] = [
    PERMISSIONS.CASE_READ_ALL,
    PERMISSIONS.CASE_ASSIGN,
    PERMISSIONS.CASE_UPDATE,
    PERMISSIONS.CASE_RESPOND,
    PERMISSIONS.CASE_NOTE_INTERNAL,
  ];

  const managerApp = () => appAs(MANAGER, ROVING.userId);

  it('reads a case in a department its holder is not in', async () => {
    seedBothQueues();
    const app = await managerApp();

    const response = await app.inject({ method: 'GET', url: '/cases/queue/case-fin' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { abilities: { canUpdate: boolean } } }>().data.abilities.canUpdate).toBe(
      true,
    );
  });

  it('moves, assigns and re-routes a case in any department', async () => {
    seedBothQueues();
    const app = await managerApp();

    const moved = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/status',
      payload: { status: 'IN_PROGRESS' },
    });
    const assigned = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/assign',
      payload: { assignedUserId: IT_AGENT.userId },
    });
    const routed = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/route',
      payload: { departmentId: 'dep-it', categoryId: 'cat-it-email' },
    });

    expect([moved.statusCode, assigned.statusCode, routed.statusCode]).toEqual([200, 200, 200]);
    expect(caseTable.rows.find((row) => row.id === 'case-fin')).toMatchObject({
      status: 'IN_PROGRESS',
      departmentId: 'dep-it',
    });
  });

  it('replies and notes on a case in any department', async () => {
    seedBothQueues();
    const app = await managerApp();

    const reply = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/messages',
      payload: { message: 'Payroll are looking at this now.' },
    });
    const note = await app.inject({
      method: 'POST',
      url: '/cases/queue/case-fin/messages',
      payload: { message: 'Third one about the same run.', internal: true },
    });

    expect(reply.statusCode).toBe(201);
    expect(note.statusCode).toBe(201);
    expect(messageTable.rows.map((row) => row.isInternal)).toEqual([false, true]);
  });
});

describe('the trail every desk action leaves', () => {
  /**
   * Audit is not decoration here. A case is a record of something somebody
   * asked for and of what was done about it, and "who closed this and when" is
   * the question asked months later - so every act that changes the case is
   * pinned to an entry, by action name, actor and entity.
   */
  const entries = () =>
    db.auditLog.create.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );

  beforeEach(() => {
    caseTable.rows.push(caseRow({ id: 'case-it' }));
  });

  it('records a status change, with what it moved from and to', async () => {
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/status',
      payload: { status: 'RESOLVED', note: 'Replaced the battery.' },
    });

    expect(entries()[0]).toMatchObject({
      action: 'case.status.change',
      entityType: 'Case',
      entityId: 'case-it',
      actorId: IT_AGENT.userId,
      companyId: COMPANY,
      before: expect.objectContaining({ status: 'OPEN' }),
      after: expect.objectContaining({ status: 'RESOLVED' }),
    });
    // The note's TEXT is not in the trail - it lives on the case, where the
    // people entitled to read it already are.
    expect(JSON.stringify(entries()[0])).not.toContain('Replaced the battery');
  });

  it('records an assignment and an unassignment', async () => {
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: FIN_AGENT.userId },
    });
    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/assign',
      payload: { assignedUserId: null },
    });

    expect(entries().map((entry) => entry.action)).toEqual(['case.assign', 'case.assign']);
    expect(entries()[1]).toMatchObject({
      before: { assignedUserId: FIN_AGENT.userId },
      after: { assignedUserId: null },
    });
  });

  it('records a priority change and a re-route', async () => {
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/priority',
      payload: { priority: 'URGENT' },
    });
    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/route',
      payload: { departmentId: 'dep-fin', categoryId: 'cat-fin-salary' },
    });

    expect(entries().map((entry) => entry.action)).toEqual([
      'case.priority.change',
      'case.route',
    ]);
    expect(entries()[0]).toMatchObject({ before: { priority: 'NORMAL' }, after: { priority: 'URGENT' } });
  });

  it('tells a reply and a note apart in the trail', async () => {
    const app = await appAs();

    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Fixed - try it now.' },
    });
    await app.inject({
      method: 'POST',
      url: '/cases/queue/case-it/messages',
      payload: { message: 'Second failure this month.', internal: true },
    });

    expect(entries().map((entry) => entry.action)).toEqual(['case.respond', 'case.note']);
    expect(JSON.stringify(entries())).not.toContain('Second failure this month');
  });
});

describe('paging the queue', () => {
  it('asks the database for one page rather than sending everything', async () => {
    for (let index = 0; index < 25; index += 1) {
      caseTable.rows.push(caseRow({ id: `case-${index}`, subject: `Case ${index}` }));
    }
    const app = await appAs();

    const first = await app.inject({ method: 'GET', url: '/cases/queue?limit=10' });
    const third = await app.inject({ method: 'GET', url: '/cases/queue?limit=10&page=3' });

    const firstBody = first.json<{ data: unknown[]; meta: Record<string, number> }>();
    const thirdBody = third.json<{ data: unknown[]; meta: Record<string, number> }>();

    expect(firstBody.data).toHaveLength(10);
    expect(firstBody.meta).toMatchObject({ page: 1, limit: 10, total: 25, totalPages: 3 });
    expect(thirdBody.data).toHaveLength(5);
    // The page is the DATABASE's page: skip and take reached Prisma.
    expect(db.case.findMany.mock.calls[1]?.[0]).toMatchObject({ skip: 20, take: 10 });
  });
});
