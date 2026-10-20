import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, formatCaseNumber, type Permission } from '@hrms/shared';

/**
 * @mentions on case messages, end to end through the desk and requester routes.
 *
 * What these pin:
 *
 *   - a tag is an id the server re-read, never text: unknown, suspended or
 *     unnamed ids are refused before anything is written;
 *   - a tag never grants access: somebody who cannot open the message is
 *     refused with a sentence saying so, and still cannot open the case after;
 *     assigning the case is what lets them in;
 *   - a tag never moves the case: status, assignee and timestamps other than
 *     `lastMessageAt` are untouched, after resolution as much as before;
 *   - one CASE_MENTION notification per person per message, only after the
 *     save, never to the author, and never twice for a retried dispatch;
 *   - the dashboard feed re-checks access when it is read.
 */

const { table, matches } = await import('./case-store.test-kit.js');

const COMPANY = 'company-1';
const CASE_ID = 'case-1';
const CASE_NUMBER = formatCaseNumber(2026, 1);

const DEPARTMENTS = [
  { id: 'dep-hr', companyId: COMPANY, name: 'HR', isActive: true, headEmployeeId: null },
  { id: 'dep-fin', companyId: COMPANY, name: 'Finance', isActive: true, headEmployeeId: null },
  { id: 'dep-it', companyId: COMPANY, name: 'IT', isActive: true, headEmployeeId: null },
];
const CATEGORIES = [
  { id: 'cat-hr-medical', companyId: COMPANY, departmentId: 'dep-hr', parentCategoryId: null, name: 'Medical', description: null, sortOrder: 0, isActive: true },
  { id: 'cat-fin-claims', companyId: COMPANY, departmentId: 'dep-fin', parentCategoryId: null, name: 'Claims', description: null, sortOrder: 0, isActive: true },
];

const EMPLOYEE: Permission[] = [
  PERMISSIONS.CASE_READ_OWN,
  PERMISSIONS.CASE_CREATE,
  PERMISSIONS.CASE_REPLY_OWN,
  PERMISSIONS.CASE_REOPEN_OWN,
];
const DESK: Permission[] = [
  PERMISSIONS.CASE_READ_DEPARTMENT,
  PERMISSIONS.CASE_UPDATE,
  PERMISSIONS.CASE_RESPOND,
  PERMISSIONS.CASE_NOTE_INTERNAL,
];
const DISPATCHER: Permission[] = [...DESK, PERMISSIONS.CASE_READ_ALL, PERMISSIONS.CASE_ASSIGN];

interface Person {
  userId: string;
  employeeId: string;
  departmentId: string | null;
  name: string;
  jobTitle: string | null;
  roleName: string;
  status: 'ACTIVE' | 'SUSPENDED';
  grants: Permission[];
}

const person = (p: Omit<Person, 'status'> & { status?: Person['status'] }): Person => ({
  status: 'ACTIVE',
  ...p,
});

const ZOHAIB = person({ userId: 'u-zohaib', employeeId: 'e-zohaib', departmentId: null, name: 'Zohaib Saleem', jobTitle: 'CEO', roleName: 'Super Admin', grants: [...EMPLOYEE, ...DISPATCHER] });
const HINA = person({ userId: 'u-hina', employeeId: 'e-hina', departmentId: 'dep-hr', name: 'Hina Raza', jobTitle: 'HR Officer', roleName: 'HR Manager', grants: [...EMPLOYEE, ...DESK] });
const SAMI = person({ userId: 'u-sami', employeeId: 'e-sami', departmentId: 'dep-hr', name: 'Sami Ullah', jobTitle: 'HR Executive', roleName: 'HR Manager', grants: [...EMPLOYEE, ...DESK] });
/** Finance's own desk: cannot open an HR case until it is handed to him. */
const ASAD = person({ userId: 'u-asad', employeeId: 'e-asad', departmentId: 'dep-fin', name: 'Asad Mirza', jobTitle: 'Accountant', roleName: 'Finance', grants: [...EMPLOYEE, ...DESK] });
const AYESHA = person({ userId: 'u-ayesha', employeeId: 'e-ayesha', departmentId: 'dep-it', name: 'Ayesha Khan', jobTitle: 'Developer', roleName: 'Employee', grants: EMPLOYEE });
const GONE = person({ userId: 'u-gone', employeeId: 'e-gone', departmentId: 'dep-hr', name: 'Old Account', jobTitle: null, roleName: 'HR Manager', status: 'SUSPENDED', grants: [...EMPLOYEE, ...DESK] });

const PEOPLE = [ZOHAIB, HINA, SAMI, ASAD, AYESHA, GONE];
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
  caseMessageMention: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  notification: { create: vi.fn(), findUnique: vi.fn() },
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
const { notifyMentions } = await import('./case-mentions.service.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

async function appAs(p: Person): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: p.userId,
      companyId: COMPANY,
      email: `${p.userId}@example.com`,
      permissions: new Set(p.grants),
      dataScope: 'OWN',
      mustChangePassword: false,
    };
  });
  await app.register(caseRoutes, { prefix: '/cases' });
  await app.register(caseDeskRoutes, { prefix: '/cases' });
  await app.ready();
  return app;
}

function personRow(p: Person) {
  const [firstName, lastName] = p.name.split(' ');
  const department = DEPARTMENTS.find((d) => d.id === p.departmentId);
  return {
    id: p.userId,
    firstName,
    lastName,
    employee: {
      id: p.employeeId,
      departmentId: p.departmentId,
      jobTitle: p.jobTitle,
      department: department ? { name: department.name } : null,
      designation: null,
    },
    userRoles: [
      {
        role: {
          name: p.roleName,
          rolePermissions: p.grants.map((key) => ({ permission: { key } })),
        },
      },
    ],
  };
}

function caseRow(over: Partial<Record<string, unknown>> = {}) {
  const departmentId = (over.departmentId as string) ?? 'dep-hr';
  const categoryId = (over.categoryId as string) ?? 'cat-hr-medical';
  return {
    id: CASE_ID,
    companyId: COMPANY,
    caseNumber: CASE_NUMBER,
    requesterEmployeeId: AYESHA.employeeId,
    departmentId,
    categoryId,
    subcategoryId: null,
    subject: 'Medical reimbursement claim',
    description: 'Hospital bill from last week, receipts attached.',
    priority: 'NORMAL',
    status: 'RESOLVED',
    assignedUserId: null as string | null,
    assignedAt: null,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    updatedAt: new Date('2026-10-01T09:00:00.000Z'),
    lastMessageAt: null,
    resolvedAt: new Date('2026-10-02T09:00:00.000Z'),
    closedAt: null,
    requester: {
      id: AYESHA.employeeId,
      firstName: 'Ayesha',
      lastName: 'Khan',
      displayName: null,
      employeeNumber: '1001',
      workEmail: 'ayesha@example.com',
      userId: AYESHA.userId,
      department: { id: 'dep-it', name: 'IT' },
    },
    department: { id: departmentId, name: DEPARTMENTS.find((d) => d.id === departmentId)?.name },
    category: { id: categoryId, name: CATEGORIES.find((c) => c.id === categoryId)?.name },
    subcategory: null,
    assignedTo: null,
    _count: { messages: 0, attachments: 0 },
    ...over,
  };
}

let caseTable: ReturnType<typeof table>;
let messageTable: ReturnType<typeof table>;
let mentionTable: ReturnType<typeof table>;
let notifications: Array<Record<string, unknown>>;

const byUser = (id: string) => PEOPLE.find((p) => p.userId === id);

function sent(type?: string) {
  return notifications.filter((n) => !type || n.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  caseTable = table([caseRow()]);
  messageTable = table([]);
  mentionTable = table([]);
  notifications = [];
  const departmentTable = table(DEPARTMENTS);
  const categoryTable = table(CATEGORIES);

  db.case.findFirst.mockImplementation(caseTable.findFirst);
  db.case.findMany.mockImplementation(caseTable.findMany);
  db.case.count.mockImplementation(caseTable.count);
  db.case.update.mockImplementation(caseTable.update);
  db.case.groupBy.mockImplementation(caseTable.groupBy);

  db.caseMessage.create.mockImplementation(
    async (args: { data: Record<string, unknown> & { mentions?: { create: Array<Record<string, unknown>> } } }) => {
      const { mentions, ...data } = args.data;
      const row = await messageTable.create({ data: { id: `msg-${messageTable.rows.length + 1}`, ...data } });
      for (const m of mentions?.create ?? []) {
        mentionTable.rows.push({
          id: `men-${mentionTable.rows.length + 1}`,
          messageId: row.id,
          notifiedAt: null,
          notificationId: null,
          createdAt: new Date(),
          ...m,
        });
      }
      return row;
    },
  );
  db.caseMessage.findMany.mockImplementation(async (args: Parameters<typeof messageTable.findMany>[0]) =>
    (await messageTable.findMany(args)).map((row) => ({
      sender: null,
      attachments: [],
      ...row,
      mentions: mentionTable.rows
        .filter((m) => m.messageId === row.id)
        .map((m) => {
          const p = byUser(m.mentionedUserId as string)!;
          const [firstName, lastName] = p.name.split(' ');
          return {
            mentionedUserId: p.userId,
            mentionedUser: { firstName, lastName, employee: { id: p.employeeId } },
          };
        }),
    })),
  );
  db.caseAttachment.findMany.mockResolvedValue([]);

  db.caseMessageMention.findMany.mockImplementation(
    async (args: { where: unknown; select?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      const rows = await mentionTable.findMany({ where: args.where, orderBy: args.orderBy, take: args.take });
      if (!args.select?.case) return rows;
      return rows.map((m) => {
        const c = caseTable.rows.find((r) => r.id === m.caseId)!;
        const msg = messageTable.rows.find((r) => r.id === m.messageId)!;
        const sender = byUser(msg.senderUserId as string);
        const n = notifications.find((x) => x.id === m.notificationId);
        return {
          ...m,
          notification: n ? { readAt: n.readAt ?? null } : null,
          case: c,
          message: {
            message: msg.message,
            isInternal: msg.isInternal,
            sender: sender ? { firstName: sender.name.split(' ')[0], lastName: sender.name.split(' ')[1] } : null,
          },
        };
      });
    },
  );
  db.caseMessageMention.updateMany.mockImplementation(
    async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      mentionTable.rows.forEach((row, i) => {
        if (matches(row, args.where)) {
          mentionTable.rows[i] = { ...row, ...args.data };
          count += 1;
        }
      });
      return { count };
    },
  );
  db.caseMessageMention.update.mockImplementation(mentionTable.update);
  db.caseMessageMention.count.mockImplementation(async (args: { where: { mentionedUserId: string } }) =>
    mentionTable.rows.filter((m) => {
      const n = notifications.find((x) => x.id === m.notificationId);
      return m.mentionedUserId === args.where.mentionedUserId && n && !n.readAt;
    }).length,
  );

  db.notification.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = { id: `n-${notifications.length + 1}`, readAt: null, ...args.data };
    notifications.push(row);
    return { id: row.id };
  });
  db.auditLog.create.mockResolvedValue({ id: 'a-1' });
  db.notification.findUnique.mockResolvedValue(null);

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
  const active = PEOPLE.filter((p) => p.status === 'ACTIVE');
  const desk = active.filter((p) => p.grants.some((g) => DESK_READS.includes(g)));
  db.user.findMany.mockImplementation((args: { where: { userRoles?: unknown; id?: { in: string[] } } }) => {
    const pool = args.where.userRoles ? desk : active;
    const ids = args.where.id?.in;
    return Promise.resolve(pool.filter((p) => !ids || ids.includes(p.userId)).map(personRow));
  });
  db.user.findFirst.mockImplementation((args: { where: { id?: string; userRoles?: unknown } }) => {
    const pool = args.where.userRoles ? desk : active;
    const match = pool.find((p) => p.userId === args.where.id);
    return Promise.resolve(match ? personRow(match) : null);
  });
});

async function post(
  author: Person,
  body: { message: string; internal?: boolean; mentionUserIds?: string[] },
) {
  const app = await appAs(author);
  return app.inject({ method: 'POST', url: `/cases/queue/${CASE_ID}/messages`, payload: body });
}

function setCase(over: Record<string, unknown>) {
  caseTable.rows[0] = { ...caseTable.rows[0], ...over };
}

// -----------------------------------------------------------------------------

describe('the @ dropdown', () => {
  it('finds people by job title, department or role - and greys out who cannot open the case', async () => {
    const app = await appAs(ZOHAIB);

    const byTitle = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates?q=accountant` });
    expect(byTitle.statusCode).toBe(200);
    const [asad] = byTitle.json<{ data: Array<Record<string, unknown>> }>().data;
    expect(asad).toMatchObject({ userId: ASAD.userId, name: 'Asad Mirza', jobTitle: 'Accountant', departmentName: 'Finance', canAccess: false });
    expect(asad?.reason).toMatch(/cannot open this case.*assign the case to them or route it/i);

    const byDept = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates?q=hr` });
    const names = byDept.json<{ data: Array<{ userId: string; canAccess: boolean }> }>().data;
    expect(names.filter((c) => c.canAccess).map((c) => c.userId).sort()).toEqual([HINA.userId, SAMI.userId].sort());

    const everyone = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates` });
    const ids = everyone.json<{ data: Array<{ userId: string }> }>().data.map((c) => c.userId);
    expect(ids).not.toContain(ZOHAIB.userId); // never yourself
    expect(ids).not.toContain(GONE.userId); // never a suspended account
  });

  it('offers the requester for a reply but not for an internal note', async () => {
    const app = await appAs(HINA);
    const reply = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates?q=ayesha` });
    const note = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates?q=ayesha&internal=true` });

    expect(reply.json<{ data: Array<{ canAccess: boolean }> }>().data[0]?.canAccess).toBe(true);
    expect(note.json<{ data: Array<{ canAccess: boolean; reason: string }> }>().data[0]).toMatchObject({
      canAccess: false,
      reason: expect.stringMatching(/cannot see internal notes/),
    });
  });

  it('is closed to somebody who cannot write on the case', async () => {
    const app = await appAs(AYESHA);
    const response = await app.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}/mention-candidates` });
    expect(response.statusCode).toBe(403);
  });
});

describe('tagging somebody', () => {
  it('works after resolution, tells them once with the case and a preview, and does not touch the case', async () => {
    setCase({ assignedUserId: HINA.userId });
    const before = { ...caseTable.rows[0] };

    const response = await post(ZOHAIB, {
      message: '@Hina Raza Please process the approved reimbursement.',
      mentionUserIds: [HINA.userId],
    });
    expect(response.statusCode).toBe(201);

    // One notification, the mention - not also "a colleague added to the case you hold".
    const toHina = notifications.filter((n) => n.userId === HINA.userId);
    expect(toHina).toHaveLength(1);
    expect(toHina[0]).toMatchObject({
      type: 'CASE_MENTION',
      title: 'You were mentioned in a case',
      message: `Zohaib Saleem mentioned you in ${CASE_NUMBER} (Medical reimbursement claim): "@Hina Raza Please process the approved reimbursement."`,
      entityType: 'CaseDesk',
      entityId: CASE_ID,
    });

    // Status, assignee and settlement dates are exactly as they were.
    const after = caseTable.rows[0]!;
    expect(after.status).toBe('RESOLVED');
    expect(after.assignedUserId).toBe(HINA.userId);
    expect(after.resolvedAt).toEqual(before.resolvedAt);
    const caseWrites = db.case.update.mock.calls.map((call) => Object.keys((call[0] as { data: object }).data));
    expect(caseWrites).toEqual([['lastMessageAt']]);

    // Recorded, and linked to the notification it sent.
    expect(mentionTable.rows).toHaveLength(1);
    expect(mentionTable.rows[0]).toMatchObject({ mentionedUserId: HINA.userId, notificationId: toHina[0]!.id });
  });

  it('notifies only after the message is saved', async () => {
    db.caseMessage.create.mockRejectedValueOnce(new Error('database down'));
    const response = await post(ZOHAIB, { message: '@Hina Raza hello', mentionUserIds: [HINA.userId] });
    expect(response.statusCode).toBe(500);
    expect(sent('CASE_MENTION')).toHaveLength(0);
  });

  it('sends one notification per person, however many times they are named or listed', async () => {
    const response = await post(ZOHAIB, {
      message: '@Hina Raza and @Sami Ullah - @Hina Raza, please take the lead.',
      internal: true,
      mentionUserIds: [HINA.userId, SAMI.userId, HINA.userId],
    });
    expect(response.statusCode).toBe(201);
    expect(sent('CASE_MENTION').map((n) => n.userId).sort()).toEqual([HINA.userId, SAMI.userId].sort());
    expect(mentionTable.rows).toHaveLength(2);
  });

  it('does not notify the author for tagging themselves', async () => {
    const response = await post(ZOHAIB, {
      message: 'Note to self, @Zohaib Saleem: chase Finance.',
      internal: true,
      mentionUserIds: [ZOHAIB.userId],
    });
    expect(response.statusCode).toBe(201);
    expect(sent('CASE_MENTION')).toHaveLength(0);
    expect(mentionTable.rows).toHaveLength(0);
  });

  it('does not change the assignee or send an assignment notice', async () => {
    setCase({ assignedUserId: SAMI.userId });
    await post(ZOHAIB, { message: '@Hina Raza can you double-check this?', mentionUserIds: [HINA.userId] });

    expect(caseTable.rows[0]!.assignedUserId).toBe(SAMI.userId);
    expect(notifications.some((n) => String(n.title).includes('assigned to you'))).toBe(false);
  });

  it('keeps the closed-case rule: reopen first', async () => {
    setCase({ status: 'CLOSED', closedAt: new Date() });
    const response = await post(ZOHAIB, { message: '@Hina Raza see this', mentionUserIds: [HINA.userId] });
    expect(response.statusCode).toBe(409);
    expect(mentionTable.rows).toHaveLength(0);
    expect(sent('CASE_MENTION')).toHaveLength(0);
  });
});

describe('what cannot become a mention', () => {
  it.each([
    ['an id that is nobody', 'u-nobody'],
    ['a suspended account', GONE.userId],
  ])('refuses %s, and writes nothing', async (_label, id) => {
    const response = await post(ZOHAIB, { message: '@Old Account @Nobody here', mentionUserIds: [id] });
    expect(response.statusCode).toBe(422);
    expect(messageTable.rows).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it('refuses a tag whose name was deleted from the text', async () => {
    const response = await post(ZOHAIB, { message: 'Please process it.', mentionUserIds: [HINA.userId] });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { details: Record<string, string[]> } }>().error.details.mentionUserIds?.[0]).toMatch(/not named in the message/);
    expect(messageTable.rows).toHaveLength(0);
  });

  it('treats a hand-typed @name as text', async () => {
    const response = await post(ZOHAIB, { message: '@Hina Raza please look' });
    expect(response.statusCode).toBe(201);
    expect(mentionTable.rows).toHaveLength(0);
    expect(sent('CASE_MENTION')).toHaveLength(0);
  });

  it('ignores mention ids sent to the requester-side reply endpoint', async () => {
    const app = await appAs(AYESHA);
    const response = await app.inject({
      method: 'POST',
      url: `/cases/${CASE_ID}/messages`,
      payload: { message: '@Hina Raza thanks!', mentionUserIds: [HINA.userId] },
    });
    expect(response.statusCode).toBe(201);
    expect(mentionTable.rows).toHaveLength(0);
    expect(sent('CASE_MENTION')).toHaveLength(0);
  });
});

describe('access is never granted by a tag', () => {
  it('refuses to tag the accountant on an HR case they cannot open, and they still cannot open it', async () => {
    const response = await post(ZOHAIB, {
      message: '@Asad Mirza Please process the approved reimbursement.',
      mentionUserIds: [ASAD.userId],
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toMatch(/Asad Mirza cannot open this case/);
    expect(messageTable.rows).toHaveLength(0);
    expect(notifications).toHaveLength(0);

    const asad = await appAs(ASAD);
    expect((await asad.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}` })).statusCode).toBe(404);
  });

  it('works once the case is assigned to them through the normal workflow', async () => {
    const admin = await appAs(ZOHAIB);
    const assigned = await admin.inject({
      method: 'POST',
      url: `/cases/queue/${CASE_ID}/assign`,
      payload: { assignedUserId: ASAD.userId },
    });
    expect(assigned.statusCode).toBe(200);

    const response = await post(ZOHAIB, {
      message: '@Asad Mirza Please process the approved reimbursement.',
      mentionUserIds: [ASAD.userId],
    });
    expect(response.statusCode).toBe(201);
    expect(sent('CASE_MENTION').map((n) => n.userId)).toEqual([ASAD.userId]);

    // The notification leads to a case they can open, with the tag in the thread.
    const asad = await appAs(ASAD);
    const detail = await asad.inject({ method: 'GET', url: `/cases/queue/${CASE_ID}` });
    expect(detail.statusCode).toBe(200);
    const thread = detail.json<{ data: { messages: Array<{ message: string; mentions: Array<{ userId: string; name: string }> }> } }>().data.messages;
    expect(thread.at(-1)?.mentions).toEqual([{ userId: ASAD.userId, name: 'Asad Mirza', employeeId: ASAD.employeeId }]);
  });

  it('lets the requester be tagged in a reply, once, through their own view - not in an internal note', async () => {
    const reply = await post(HINA, {
      message: '@Ayesha Khan the reimbursement is approved.',
      mentionUserIds: [AYESHA.userId],
    });
    expect(reply.statusCode).toBe(201);
    const toAyesha = notifications.filter((n) => n.userId === AYESHA.userId);
    expect(toAyesha).toHaveLength(1);
    expect(toAyesha[0]).toMatchObject({ type: 'CASE_MENTION', entityType: 'Case' });

    const note = await post(HINA, {
      message: '@Ayesha Khan internal only',
      internal: true,
      mentionUserIds: [AYESHA.userId],
    });
    expect(note.statusCode).toBe(422);
    expect(JSON.stringify(note.json())).toMatch(/cannot see internal notes/);

    // Her own view shows the tag on the public reply and nothing internal.
    const ayesha = await appAs(AYESHA);
    const own = await ayesha.inject({ method: 'GET', url: `/cases/${CASE_ID}` });
    const thread = own.json<{ data: { messages: Array<{ internal: boolean; mentions: Array<{ userId: string }> }> } }>().data.messages;
    expect(thread).toHaveLength(1);
    expect(thread[0]?.mentions.map((m) => m.userId)).toEqual([AYESHA.userId]);
  });
});

describe('retries', () => {
  it('a second dispatch for the same message sends nothing', async () => {
    await post(ZOHAIB, { message: '@Hina Raza please check', mentionUserIds: [HINA.userId] });
    expect(sent('CASE_MENTION')).toHaveLength(1);

    const row = caseTable.rows[0] as never;
    const again = await notifyMentions({
      row,
      messageId: messageTable.rows[0]!.id as string,
      authorUserId: ZOHAIB.userId,
      message: '@Hina Raza please check',
      targets: [{ userId: HINA.userId, name: 'Hina Raza', access: 'desk' }],
    });
    expect(again).toEqual([]);
    expect(sent('CASE_MENTION')).toHaveLength(1);
  });

  it('releases a claim whose notification failed, so a retry can still deliver it', async () => {
    db.notification.create.mockRejectedValueOnce(new Error('transient'));
    await post(ZOHAIB, { message: '@Hina Raza please check', mentionUserIds: [HINA.userId] });
    expect(sent('CASE_MENTION')).toHaveLength(0);
    expect(mentionTable.rows[0]).toMatchObject({ notifiedAt: null, notificationId: null });

    const told = await notifyMentions({
      row: caseTable.rows[0] as never,
      messageId: messageTable.rows[0]!.id as string,
      authorUserId: ZOHAIB.userId,
      message: '@Hina Raza please check',
      targets: [{ userId: HINA.userId, name: 'Hina Raza', access: 'desk' }],
    });
    expect(told).toEqual([HINA.userId]);
    expect(sent('CASE_MENTION')).toHaveLength(1);
  });
});

describe('the dashboard feed', () => {
  it('lists my mentions with the case, who, a preview and unread state - and re-checks access', async () => {
    await post(ZOHAIB, { message: '@Hina Raza Please process the approved reimbursement.', mentionUserIds: [HINA.userId] });

    const hina = await appAs(HINA);
    const feed = await hina.inject({ method: 'GET', url: '/cases/mentions' });
    expect(feed.statusCode).toBe(200);
    const data = feed.json<{ data: { unread: number; items: Array<Record<string, unknown>> } }>().data;
    expect(data.unread).toBe(1);
    expect(data.items[0]).toMatchObject({
      caseId: CASE_ID,
      caseNumber: CASE_NUMBER,
      caseStatus: 'RESOLVED',
      caseSubject: 'Medical reimbursement claim',
      mentionedByName: 'Zohaib Saleem',
      preview: '@Hina Raza Please process the approved reimbursement.',
      readAt: null,
      link: `/case-queue/${CASE_ID}`,
    });

    // Somebody else's feed does not carry it.
    const sami = await appAs(SAMI);
    const theirs = await sami.inject({ method: 'GET', url: '/cases/mentions' });
    expect(theirs.json<{ data: { items: unknown[] } }>().data.items).toHaveLength(0);

    // Routed away from HR: the row stays, but says nothing about the case.
    setCase({ departmentId: 'dep-fin', categoryId: 'cat-fin-claims' });
    const later = await hina.inject({ method: 'GET', url: '/cases/mentions' });
    expect(later.json<{ data: { items: Array<Record<string, unknown>> } }>().data.items[0]).toMatchObject({
      caseNumber: CASE_NUMBER,
      caseSubject: null,
      preview: null,
      link: null,
    });
  });
});
