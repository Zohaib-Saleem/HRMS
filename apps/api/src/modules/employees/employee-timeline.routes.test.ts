import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type EmployeeTimelinePage, type Permission } from '@hrms/shared';

/**
 * The employee timeline.
 *
 * The timeline reads across nine modules at once, which makes it the one
 * screen in the system where a permission mistake is cheapest to make and
 * most expensive to have: a manager who may open a profile but not payroll
 * must not be handed a salary history simply because it arrived in a different
 * envelope. So the properties pinned here are, in order of how much they
 * matter:
 *
 *   - a category the caller cannot read is ABSENT, not empty, and no query for
 *     it is issued at all;
 *   - medical follows the medical module's own rule - your own claims, or
 *     oversight - and a wide data scope does not widen it;
 *   - the audit diff is read through a whitelist, so a bank account or a
 *     national ID that changed in the same request never becomes an event;
 *   - "Changed by" is a name, never an id, and it appears only for a caller
 *     who may read the audit trail;
 *   - nothing is written. Opening a timeline issues no create, update or
 *     delete against anything.
 *
 * The figures themselves are not re-asserted: they belong to payroll, loans,
 * leave and the claims module, which have their own tests. What is asserted is
 * that this endpoint reports what those tables already hold, in order.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  auditLog: { findMany: vi.fn(), create: vi.fn() },
  employeeSalary: { findMany: vi.fn() },
  salaryRevision: { findMany: vi.fn() },
  attendanceRegularizationRequest: { findMany: vi.fn() },
  attendanceAdjustment: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  employeeLoan: { findMany: vi.fn() },
  medicalClaim: { findMany: vi.fn() },
  case: { findMany: vi.fn() },
  employeeContract: { findMany: vi.fn() },
  employeePolicyAssignment: { findMany: vi.fn() },
  department: { findMany: vi.fn() },
  team: { findMany: vi.fn() },
  designation: { findMany: vi.fn() },
  location: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { employeeRoutes } = await import('./employees.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const COMPANY = 'company-1';
const TARGET = 'emp-target';
const DAY = (value: string) => new Date(`${value}T00:00:00Z`);
const AT = (value: string) => new Date(value);

/** HR: reads people, pay, time, benefits and the trail. */
const HR: Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.PAYROLL_READ,
  PERMISSIONS.ATTENDANCE_READ,
  PERMISSIONS.LEAVE_READ,
  PERMISSIONS.LOAN_READ,
  PERMISSIONS.MEDICAL_READ,
  PERMISSIONS.MEDICAL_MANAGE,
  PERMISSIONS.CONTRACT_READ,
  PERMISSIONS.POLICY_READ,
  PERMISSIONS.AUDIT_READ,
];

/** A line manager: may open the profile and see time off. Nothing financial. */
const MANAGER: Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.ATTENDANCE_READ,
  PERMISSIONS.LEAVE_READ,
];

/** The employee record the whole suite is about. */
const EMPLOYEE = {
  id: TARGET,
  createdAt: AT('2022-06-10T09:00:00Z'),
  hireDate: DAY('2022-06-15'),
  confirmationDate: DAY('2022-12-15'),
  resignationDate: null,
  terminationDate: null,
  status: 'ACTIVE',
  employmentStatus: 'PERMANENT',
  employmentType: 'FULL_TIME',
  jobTitle: 'Game Developer',
  department: { name: 'Development' },
  designation: { name: 'Game Developer' },
  nationalIdExpiry: null,
  passportExpiry: null,
  visaExpiry: null,
};

/** The caller's own employee record, when they have one. Null by default. */
let self: { id: string } | null = null;

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS' | 'NONE' = 'ALL',
  userId = 'user-hr',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: COMPANY,
      email: 'hr@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(employeeRoutes, { prefix: '/employees' });
  await app.ready();
  return app;
}


/**
 * A faithful stand-in for `employee.findFirst`.
 *
 * Three different questions reach this one method in a single request, and a
 * mock that answers them all the same way would make the scope test pass for
 * the wrong reason:
 *
 *   - "who is the caller?" carries a `userId`, and must answer with the
 *     CALLER's record - never with the employee being looked at, or every
 *     reader would appear to be viewing their own profile;
 *   - "may this caller reach this employee?" arrives as an `AND` of the target
 *     id and the scope filter, so an id clause naming somebody else has to
 *     come back empty, exactly as the database would;
 *   - everything else is the record itself.
 */
function employeeReader(row: Record<string, unknown>) {
  return async (args: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if ('userId' in where) return self;

    if (Array.isArray(where.AND)) {
      const clauses = where.AND as Array<Record<string, unknown> | null>;
      const ids = clauses.flatMap((clause) =>
        clause && typeof clause.id === 'string' ? [clause.id] : [],
      );
      if (ids.some((id) => id !== TARGET)) return null;
    }

    return row;
  };
}

let app: FastifyInstance | null = null;

async function timeline(
  instance: FastifyInstance,
  query = '',
): Promise<EmployeeTimelinePage> {
  const response = await instance.inject({
    method: 'GET',
    url: `/employees/${TARGET}/timeline${query}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as EmployeeTimelinePage;
}

beforeEach(() => {
  vi.clearAllMocks();
  self = null;

  db.company.findUniqueOrThrow.mockResolvedValue({ currency: 'PKR', timezone: 'Asia/Karachi' });

  /*
   * One implementation for every `employee.findFirst` in the request, told
   * apart by what the caller asked for. A `userId` in the where clause is the
   * question "who am I?" - which the scope resolver, the medical gate and the
   * case gate all ask, and which must NOT answer with the employee being
   * looked at, or every caller would read their own profile.
   */
  db.employee.findFirst.mockImplementation(employeeReader(EMPLOYEE));

  db.employee.findMany.mockResolvedValue([]);
  db.auditLog.findMany.mockResolvedValue([]);
  db.employeeSalary.findMany.mockResolvedValue([]);
  db.salaryRevision.findMany.mockResolvedValue([]);
  db.attendanceRegularizationRequest.findMany.mockResolvedValue([]);
  db.attendanceAdjustment.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.employeeLoan.findMany.mockResolvedValue([]);
  db.medicalClaim.findMany.mockResolvedValue([]);
  db.case.findMany.mockResolvedValue([]);
  db.employeeContract.findMany.mockResolvedValue([]);
  db.employeePolicyAssignment.findMany.mockResolvedValue([]);
  db.department.findMany.mockResolvedValue([]);
  db.team.findMany.mockResolvedValue([]);
  db.designation.findMany.mockResolvedValue([]);
  db.location.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

// ---------------------------------------------------------------------------

describe('loading a timeline', () => {
  it('reads the joining milestone off the hire date, with no audit entry to help', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    const joined = page.data.find((event) => event.type === 'EMPLOYEE_JOINED');
    expect(joined).toBeDefined();
    expect(joined!.day).toBe('2022-06-15');
    expect(joined!.title).toBe('Joined company');
    expect(joined!.description).toBe('Development · Game Developer');
    expect(joined!.dateOnly).toBe(true);
  });

  it('records the confirmation on the day it took effect', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    const confirmed = page.data.find((event) => event.type === 'EMPLOYEE_CONFIRMED');
    expect(confirmed?.day).toBe('2022-12-15');
  });

  it('writes nothing - opening a timeline is a read', async () => {
    app = await appAs(HR);
    await timeline(app);

    expect(db.auditLog.create).not.toHaveBeenCalled();
    for (const table of Object.values(db)) {
      const entries = table as Record<string, { mock?: unknown }>;
      for (const [name, fn] of Object.entries(entries)) {
        if (/^(create|update|delete|upsert)/.test(name)) {
          expect(fn as never).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('offers no year or category chip for an employee with no readable history', async () => {
    // A profile is always worth at least a joining event, so "empty" is the
    // shape a caller sees when a FILTER matches nothing - checked below.
    app = await appAs(HR);
    const page = await timeline(app, '?year=1999');

    expect(page.data).toHaveLength(0);
    expect(page.meta.total).toBe(0);
    // The chips still describe the whole timeline, so the reader can get back.
    expect(page.meta.years).toContain(2022);
  });
});

describe('ordering', () => {
  beforeEach(() => {
    db.employeeSalary.findMany.mockResolvedValue([
      { id: 'sal-1', amount: 120000, currency: 'PKR', effectiveFrom: DAY('2024-01-01') },
      { id: 'sal-2', amount: 135000, currency: 'PKR', effectiveFrom: DAY('2025-08-01') },
    ]);
  });

  it('is newest first by default', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    const days = page.data.map((event) => event.day);
    expect([...days].sort().reverse()).toEqual(days);
  });

  it('reverses on request, and the first event is then the oldest', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?order=asc');

    const days = page.data.map((event) => event.day);
    expect([...days].sort()).toEqual(days);
    expect(page.data[0]!.type).toBe('EMPLOYEE_JOINED');
  });

  it('groups by the year it sends, so separators cannot drift from the dates', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    for (const event of page.data) {
      expect(event.year).toBe(Number(event.day.slice(0, 4)));
    }
  });
});

describe('filtering', () => {
  beforeEach(() => {
    db.employeeSalary.findMany.mockResolvedValue([
      { id: 'sal-1', amount: 120000, currency: 'PKR', effectiveFrom: DAY('2024-01-01') },
    ]);
    db.employeeLoan.findMany.mockResolvedValue([
      {
        id: 'loan-1',
        principalAmount: 100000,
        monthlyDeduction: 8334,
        currency: 'PKR',
        installmentCount: 12,
        purpose: 'School fees',
        createdAt: AT('2025-05-18T09:00:00Z'),
        requestedAt: AT('2025-05-18T09:00:00Z'),
        approvedAt: AT('2025-05-20T11:30:00Z'),
        approvedByUserId: 'user-hr',
        rejectedAt: null,
        rejectionReason: null,
        activatedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
    ]);
  });

  it('narrows to one category and leaves the chips alone', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=SALARY');

    expect(page.data.every((event) => event.category === 'SALARY')).toBe(true);
    expect(page.data).toHaveLength(1);
    // The chips describe the timeline, not the view - selecting Salary must not
    // make Salary the only category the reader can get back to.
    expect(page.meta.categories).toEqual(
      expect.arrayContaining(['EMPLOYMENT', 'SALARY', 'LOAN']),
    );
  });

  it('narrows to one year', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?year=2025');

    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((event) => event.year === 2025)).toBe(true);
    expect(page.meta.years).toEqual(expect.arrayContaining([2022, 2024, 2025]));
  });

  it('combines a category and a year', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=LOAN&year=2025');

    expect(page.data.map((event) => event.type)).toEqual(['LOAN_APPROVED', 'LOAN_APPLIED']);
  });
});

describe('pagination', () => {
  beforeEach(() => {
    // Twelve years of leave, two events apiece: a history long enough that a
    // page has to be a page.
    const rows = Array.from({ length: 60 }, (_, index) => ({
      id: `leave-${index}`,
      startDate: DAY('2024-03-01'),
      endDate: DAY('2024-03-02'),
      dayPart: 'FULL_DAY',
      totalDays: 2,
      reason: 'Family',
      status: 'APPROVED',
      createdAt: AT(`2024-03-01T${String(index % 24).padStart(2, '0')}:00:00Z`),
      decidedAt: AT(`2024-03-02T${String(index % 24).padStart(2, '0')}:00:00Z`),
      cancelledAt: null,
      leaveType: { name: 'Annual Leave' },
    }));
    db.leaveRequest.findMany.mockResolvedValue(rows);
  });

  it('returns twenty events and a cursor by default', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    expect(page.data).toHaveLength(20);
    expect(page.meta.hasMore).toBe(true);
    expect(page.meta.nextCursor).toBeTruthy();
    expect(page.meta.total).toBeGreaterThan(20);
  });

  it('walks the whole timeline without repeating or losing an event', async () => {
    app = await appAs(HR);

    const seen: string[] = [];
    let cursor: string | null = null;
    let total = 0;

    for (let guard = 0; guard < 20; guard += 1) {
      const page: EmployeeTimelinePage = await timeline(
        app,
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : '',
      );
      total = page.meta.total;
      seen.push(...page.data.map((event) => event.id));
      cursor = page.meta.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('honours the order when paging backwards through time', async () => {
    app = await appAs(HR);
    const first = await timeline(app, '?order=asc&limit=5');
    const second = await timeline(
      app,
      `?order=asc&limit=5&cursor=${encodeURIComponent(first.meta.nextCursor!)}`,
    );

    expect(first.data).toHaveLength(5);
    expect(second.data).toHaveLength(5);
    expect(second.data[0]!.occurredAt >= first.data[4]!.occurredAt).toBe(true);
    expect(new Set([...first.data, ...second.data].map((e) => e.id)).size).toBe(10);
  });

  it('ignores a cursor it did not issue rather than failing the page', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?cursor=not-a-real-cursor');

    expect(page.data).toHaveLength(20);
  });
});

describe('employee isolation', () => {
  it('scopes every module read to the one employee', async () => {
    app = await appAs(HR);
    await timeline(app);

    const scoped = [
      db.employeeSalary.findMany,
      db.salaryRevision.findMany,
      db.leaveRequest.findMany,
      db.employeeLoan.findMany,
      db.medicalClaim.findMany,
      db.employeeContract.findMany,
      db.employeePolicyAssignment.findMany,
      db.attendanceAdjustment.findMany,
      db.attendanceRegularizationRequest.findMany,
    ];

    for (const query of scoped) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ companyId: COMPANY, employeeId: TARGET }),
        }),
      );
    }

    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entityType: 'Employee', entityId: TARGET }),
      }),
    );
  });

  it('refuses an employee outside the caller’s data scope', async () => {
    // OWN scope, and the caller is somebody else: the scope filter resolves to
    // a different employee id, so the row is not found and the door is shut.
    self = { id: 'emp-someone-else' };
    app = await appAs(HR, 'OWN', 'user-employee');

    const response = await app.inject({
      method: 'GET',
      url: `/employees/${TARGET}/timeline`,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('permission enforcement', () => {
  beforeEach(() => {
    db.employeeSalary.findMany.mockResolvedValue([
      { id: 'sal-1', amount: 120000, currency: 'PKR', effectiveFrom: DAY('2024-01-01') },
    ]);
    db.employeeLoan.findMany.mockResolvedValue([
      {
        id: 'loan-1',
        principalAmount: 100000,
        monthlyDeduction: 8334,
        currency: 'PKR',
        installmentCount: 12,
        purpose: null,
        createdAt: AT('2025-05-18T09:00:00Z'),
        requestedAt: AT('2025-05-18T09:00:00Z'),
        approvedAt: null,
        approvedByUserId: null,
        rejectedAt: null,
        rejectionReason: null,
        activatedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
    ]);
    db.medicalClaim.findMany.mockResolvedValue([
      {
        id: 'claim-1',
        category: 'OPD',
        requestedAmount: 8500,
        approvedAmount: 8500,
        status: 'APPROVED',
        submittedAt: AT('2025-04-05T08:00:00Z'),
        decidedAt: AT('2025-04-08T08:00:00Z'),
        paidAt: null,
        cancelledAt: null,
        reviewedByUserId: 'user-hr',
        paidByUserId: null,
      },
    ]);
  });

  it('refuses the endpoint outright without employee.read', async () => {
    app = await appAs([PERMISSIONS.PAYROLL_READ]);

    const response = await app.inject({
      method: 'GET',
      url: `/employees/${TARGET}/timeline`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('never issues the query for a category the caller cannot read', async () => {
    app = await appAs(MANAGER);
    await timeline(app);

    expect(db.employeeSalary.findMany).not.toHaveBeenCalled();
    expect(db.salaryRevision.findMany).not.toHaveBeenCalled();
    expect(db.employeeLoan.findMany).not.toHaveBeenCalled();
    expect(db.medicalClaim.findMany).not.toHaveBeenCalled();
    expect(db.employeeContract.findMany).not.toHaveBeenCalled();
    expect(db.employeePolicyAssignment.findMany).not.toHaveBeenCalled();
    // What they DO hold is read as usual.
    expect(db.leaveRequest.findMany).toHaveBeenCalled();
    expect(db.attendanceAdjustment.findMany).toHaveBeenCalled();
  });

  it('hides salary from a manager who may open the profile but not payroll', async () => {
    app = await appAs(MANAGER);
    const page = await timeline(app);

    expect(page.data.some((event) => event.category === 'SALARY')).toBe(false);
    // Absent, not empty: no Salary chip is offered either.
    expect(page.meta.categories).not.toContain('SALARY');
  });

  it('shows salary to a caller who holds payroll.read', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=SALARY');

    expect(page.data[0]!.description).toBe('PKR 120,000');
    expect(page.meta.categories).toContain('SALARY');
  });

  it('hides loans without loan.read and shows them with it', async () => {
    app = await appAs(MANAGER);
    expect((await timeline(app)).meta.categories).not.toContain('LOAN');
    await app.close();

    app = await appAs(HR);
    const page = await timeline(app, '?category=LOAN');
    expect(page.data[0]!.description).toBe('PKR 100,000 · 12 installments');
  });

  it('keeps medical to the claimant and to callers with oversight', async () => {
    // medical.read alone, looking at somebody else: the module's own rule, and
    // a wide data scope does not widen it.
    self = { id: 'emp-someone-else' };
    app = await appAs([PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.MEDICAL_READ], 'ALL', 'user-peer');
    expect((await timeline(app)).meta.categories).not.toContain('MEDICAL');
    expect(db.medicalClaim.findMany).not.toHaveBeenCalled();
    await app.close();

    // The same grant, on their own record.
    self = { id: TARGET };
    app = await appAs([PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.MEDICAL_READ], 'ALL', 'user-self');
    const own = await timeline(app, '?category=MEDICAL');
    expect(own.data.length).toBeGreaterThan(0);
    await app.close();

    // Somebody else's record, with oversight.
    self = { id: 'emp-someone-else' };
    app = await appAs(HR);
    expect((await timeline(app, '?category=MEDICAL')).data.length).toBeGreaterThan(0);
  });

  it('carries no diagnosis, provider or claimant note into a medical event', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=MEDICAL');

    const fields = page.data.flatMap((event) => event.details.map((row) => row.label));
    expect(fields).not.toContain('Notes');
    expect(fields).not.toContain('Provider');
    // Not merely unrendered: never selected, so it never leaves the database.
    const selected = Object.keys(
      (db.medicalClaim.findMany.mock.calls[0]![0] as { select: Record<string, unknown> }).select,
    );
    expect(selected).not.toContain('notes');
    expect(selected).not.toContain('providerName');
    expect(selected).not.toContain('dependentId');
  });
});

describe('the audit trail as employment history', () => {
  const MOVE = {
    id: 'audit-1',
    action: 'employee.update',
    actorId: 'user-hr',
    createdAt: AT('2025-03-04T10:15:00Z'),
    before: { departmentId: 'dep-old', bankAccountNumber: '1111', nationalId: 'X' },
    after: { departmentId: 'dep-new', bankAccountNumber: '2222', nationalId: 'Y' },
  };

  beforeEach(() => {
    db.auditLog.findMany.mockResolvedValue([MOVE]);
    db.department.findMany.mockResolvedValue([
      { id: 'dep-old', name: 'Support' },
      { id: 'dep-new', name: 'Development' },
    ]);
    db.user.findMany.mockResolvedValue([
      {
        id: 'user-hr',
        firstName: 'Hira',
        lastName: 'Admin',
        email: 'hr@example.com',
        employee: { firstName: 'Hira', lastName: 'Admin', displayName: 'HR Admin' },
      },
    ]);
  });

  it('turns a department move into an event, with names rather than ids', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=EMPLOYMENT');

    const moved = page.data.find((event) => event.type === 'DEPARTMENT_CHANGED');
    expect(moved?.description).toBe('Support → Development');
    expect(JSON.stringify(moved)).not.toContain('dep-new');
  });

  it('reads the diff through a whitelist, so a restricted field never becomes an event', async () => {
    app = await appAs(HR);
    const page = await timeline(app);

    const serialised = JSON.stringify(page);
    expect(serialised).not.toContain('2222');
    expect(serialised).not.toContain('bankAccount');
    expect(serialised).not.toContain('nationalId');
  });

  it('names the actor for a caller who may read the trail', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=EMPLOYMENT');

    const moved = page.data.find((event) => event.type === 'DEPARTMENT_CHANGED');
    expect(moved?.actorName).toBe('HR Admin');
    expect(JSON.stringify(page)).not.toContain('user-hr');
  });

  it('shows the change but not the actor to a caller without audit.read', async () => {
    app = await appAs(MANAGER);
    const page = await timeline(app, '?category=EMPLOYMENT');

    const moved = page.data.find((event) => event.type === 'DEPARTMENT_CHANGED');
    expect(moved).toBeDefined();
    expect(moved!.actorName).toBeNull();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('a terminated employee', () => {
  beforeEach(() => {
    db.employee.findFirst.mockImplementation(
      employeeReader({ ...EMPLOYEE, status: 'TERMINATED', terminationDate: DAY('2026-09-10') }),
    );
    db.auditLog.findMany.mockResolvedValue([
      {
        id: 'audit-term',
        action: 'employee.terminate',
        actorId: 'user-hr',
        createdAt: AT('2026-09-11T06:00:00Z'),
        before: { status: 'ACTIVE', terminationDate: null },
        after: { status: 'TERMINATED', terminationDate: '2026-09-10' },
      },
    ]);
    db.user.findMany.mockResolvedValue([
      {
        id: 'user-hr',
        firstName: 'Hira',
        lastName: 'Admin',
        email: 'hr@example.com',
        employee: { firstName: 'Hira', lastName: 'Admin', displayName: 'HR Admin' },
      },
    ]);
  });

  it('dates the termination by when it took effect, and attributes it once', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=EMPLOYMENT');

    const ended = page.data.filter((event) => event.type === 'EMPLOYEE_TERMINATED');
    expect(ended).toHaveLength(1);
    // The day they left, not the morning somebody typed it in.
    expect(ended[0]!.day).toBe('2026-09-10');
    expect(ended[0]!.actorName).toBe('HR Admin');
    // And not a second time as a plain status change.
    expect(page.data.some((event) => event.type === 'EMPLOYMENT_STATUS_CHANGED')).toBe(false);
  });

  it('stops counting anniversaries at the day they left', async () => {
    app = await appAs(HR);
    const page = await timeline(app, '?category=EMPLOYMENT&limit=100');

    const years = page.data
      .filter((event) => event.type === 'WORK_ANNIVERSARY')
      .map((event) => event.year);
    expect(years).toEqual([2026, 2025, 2024, 2023]);
    expect(Math.max(...years)).toBe(2026);
  });
});

describe('a long history', () => {
  it('stays one page whatever the volume behind it', async () => {
    db.leaveRequest.findMany.mockResolvedValue(
      Array.from({ length: 400 }, (_, index) => ({
        id: `leave-${index}`,
        startDate: DAY('2024-03-01'),
        endDate: DAY('2024-03-01'),
        dayPart: 'FULL_DAY',
        totalDays: 1,
        reason: 'Family',
        status: 'PENDING',
        createdAt: AT(new Date(Date.UTC(2015, 0, 1) + index * 3_600_000).toISOString()),
        decidedAt: null,
        cancelledAt: null,
        leaveType: { name: 'Annual Leave' },
      })),
    );

    app = await appAs(HR);
    const page = await timeline(app);

    expect(page.data).toHaveLength(20);
    expect(page.meta.total).toBeGreaterThan(400);
    expect(page.meta.hasMore).toBe(true);
    // Each source is bounded, so one profile cannot become an unbounded read.
    expect(db.leaveRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });
});
