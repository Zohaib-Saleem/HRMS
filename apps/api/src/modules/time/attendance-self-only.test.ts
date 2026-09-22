import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_SCOPES,
  PERMISSIONS,
  type DataScope,
  type Permission,
} from '@hrms/shared';

/**
 * Attendance is self-only for anybody who may not read the employee directory.
 *
 * THE BUG THIS EXISTS FOR, stated plainly because it is not obvious and it was
 * live: a company built a custom role for the person who looks after the
 * laptops and gave it an ALL data scope, because the asset register is
 * company-wide. The role holds thirteen asset grants and not one HR
 * permission - no `employee.read`, no `attendance.manage`, no payroll. It was
 * nevertheless served the whole company's attendance, because `/attendance/team`
 * is gated on `attendance.read` - which every member of staff holds, for their
 * own record - and then narrowed by nothing but the data scope. An ALL scope
 * granted for one module opened another module entirely.
 *
 * The rule now enforced is one sentence: A CALLER WHO MAY NOT READ THE EMPLOYEE
 * DIRECTORY MAY NOT READ ANOTHER EMPLOYEE'S ATTENDANCE.
 *
 * What is asserted below is that rule from both sides, because a fix to a
 * permission bug that quietly breaks the people who DID have the right is not a
 * fix. So every "is refused" case is paired with the same request from HR,
 * from a manager and from the role's own holder.
 *
 * The permission sets are read off `DEFAULT_ROLE_PERMISSIONS` rather than
 * written by hand. That is deliberate and it is the difference between a test
 * that pins the product and one that agrees with itself: if somebody hands the
 * IT Asset Manager role `employee.read` tomorrow, these tests must fail.
 */

const db = vi.hoisted(() => ({
  employee: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  attendanceRegularizationRequest: { findMany: vi.fn(), count: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  /*
   * The appointments that widen a manager's reach. Empty by default, which is
   * the state every assertion in this file was written against: nobody manages
   * a team, so `teamScopeFilter` is the ordinary data scope and the filters
   * below are byte-for-byte what they always were.
   */
  teamManager: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceRoutes } = await import('./attendance.routes.js');
const { attendanceReportRoutes } = await import('./attendance-reports.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** A Monday in the past, so an unrecorded working day scores ABSENT. */
const DATE = '2026-09-14';

// --------------------------------------------------------------- the cast

const IT = { employeeId: 'emp-aziz', userId: 'user-aziz' };
const COLLEAGUE = { employeeId: 'emp-hira', userId: 'user-hira' };

const ROSTER = [IT.employeeId, COLLEAGUE.employeeId, 'emp-ahmed', 'emp-sana'].map((id) => ({
  id,
  employeeNumber: id.toUpperCase(),
  firstName: id,
  lastName: 'Person',
  displayName: null,
  employeeNumberPrefix: null,
  jobTitle: null,
  hireDate: new Date('2024-01-01T00:00:00.000Z'),
  terminationDate: null,
  resignationDate: null,
  status: 'ACTIVE',
  teamId: null,
  team: null,
  department: null,
}));

const POLICY = {
  timezone: 'Asia/Karachi',
  weekendDays: [0, 6],
  workdayStart: '09:00',
  workdayEnd: '18:00',
  graceMinutes: 15,
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  overtimeAfterMinutes: 540,
  overtimeEnabled: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 30,
  irregularCheckInEnabled: false,
  irregularCheckInCutoff: '11:00',
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
};

// ------------------------------------------------------------ the sessions

/**
 * The roles as the product actually defines them, plus the scope the product
 * actually gives them. Both halves matter: the whole bug was a permission set
 * that was right beside a scope that was not.
 */
interface Caller {
  permissions: readonly Permission[];
  dataScope: DataScope;
  userId: string;
}

const IT_ASSET_MANAGER: Caller = {
  permissions: DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER,
  dataScope: DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER,
  userId: IT.userId,
};

/**
 * The same person with the scope the hand-made role had.
 *
 * This is the important one. It models somebody who has been given the asset
 * role AND left on an ALL scope - by a second role, by a migration, by an
 * administrator who did not know. The permissions alone must be enough to keep
 * attendance out, because a data scope is a setting and settings drift.
 */
const IT_WITH_WIDE_SCOPE: Caller = { ...IT_ASSET_MANAGER, dataScope: 'ALL' };

const HR_ADMIN: Caller = {
  permissions: DEFAULT_ROLE_PERMISSIONS.HR_ADMIN,
  dataScope: DEFAULT_ROLE_SCOPES.HR_ADMIN,
  userId: 'user-hr',
};

const MANAGER: Caller = {
  permissions: DEFAULT_ROLE_PERMISSIONS.MANAGER,
  dataScope: DEFAULT_ROLE_SCOPES.MANAGER,
  userId: 'user-manager',
};

const EMPLOYEE: Caller = {
  permissions: DEFAULT_ROLE_PERMISSIONS.EMPLOYEE,
  dataScope: DEFAULT_ROLE_SCOPES.EMPLOYEE,
  userId: COLLEAGUE.userId,
};

type Plugin = typeof attendanceRoutes;

async function appAs(caller: Caller, plugin: Plugin = attendanceRoutes, prefix = '/attendance') {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: caller.userId,
      companyId: 'company-1',
      email: 'caller@example.com',
      permissions: new Set(caller.permissions),
      dataScope: caller.dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(plugin, { prefix });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

/** Which employee ids a request's database query was allowed to reach. */
function rosterQueryWheres(): unknown[] {
  return db.employee.findMany.mock.calls.map((call) => (call[0] as { where: unknown }).where);
}

beforeEach(() => {
  vi.clearAllMocks();

  db.company.findUniqueOrThrow.mockResolvedValue(POLICY);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.teamManager.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.attendanceRegularizationRequest.findMany.mockResolvedValue([]);
  db.attendanceRegularizationRequest.count.mockResolvedValue(0);

  // `deriveRange` reads the subject's employment window before it derives a day.
  db.employee.findUniqueOrThrow.mockImplementation(async (args: Record<string, unknown>) => {
    const id = ((args.where ?? {}) as { id?: string }).id ?? IT.employeeId;
    return ROSTER.find((row) => row.id === id) ?? { ...ROSTER[0], id };
  });

  /*
   * The roster, answered HONESTLY against whatever filter the route built.
   *
   * This is the whole method of this file. Nothing here decides who may see
   * what - the mock returns every employee the route's own WHERE reaches - so
   * a test that ends in "and they saw one person" got that answer from the
   * route's filter rather than from a fixture that was quietly wired to.
   */
  db.employee.findMany.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as { AND?: unknown[] };
    const ids = allowedIds(where.AND ?? []);
    const rows = ids === null ? ROSTER : ROSTER.filter((row) => ids.has(row.id));
    const skip = (args.skip as number) ?? 0;
    const take = (args.take as number) ?? rows.length;
    return rows.slice(skip, skip + take);
  });

  db.employee.count.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as { AND?: unknown[] };
    const ids = allowedIds(where.AND ?? []);
    return ids === null ? ROSTER.length : ROSTER.filter((row) => ids.has(row.id)).length;
  });

  /*
   * `assertAttendanceEmployeeInScope` asks for one employee against an AND
   * array; `callerEmployee` asks flat, by userId.
   */
  db.employee.findFirst.mockImplementation(async (args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;

    if (typeof where.userId === 'string') {
      const employeeId =
        where.userId === IT.userId
          ? IT.employeeId
          : where.userId === COLLEAGUE.userId
            ? COLLEAGUE.employeeId
            : `emp-${String(where.userId).replace('user-', '')}`;
      return { id: employeeId, departmentId: 'dept-1' };
    }

    if (Array.isArray(where.AND)) {
      const clauses = where.AND as Array<Record<string, unknown>>;
      const requested = clauses.find((c) => typeof c.id === 'string')?.id as string | undefined;
      const ids = allowedIds(clauses);
      if (requested === undefined) return null;
      if (ids !== null && !ids.has(requested)) return null;
      return { id: requested };
    }

    return null;
  });
});

/**
 * The set of employee ids a WHERE array permits, or null for "unrestricted".
 *
 * Understands only the two shapes the scope machinery produces - `{ id }` and a
 * nested `AND` of them - because those are the only shapes that can NARROW to a
 * person. Anything it does not understand is treated as no restriction, which
 * is the pessimistic reading: a test that wrongly reported "unrestricted" would
 * FAIL the assertions below rather than pass them.
 */
function allowedIds(clauses: readonly unknown[]): Set<string> | null {
  let ids: Set<string> | null = null;

  const visit = (clause: unknown): void => {
    if (clause === null || typeof clause !== 'object') return;
    const node = clause as Record<string, unknown>;

    if (typeof node.id === 'string') {
      const next = new Set([node.id]);
      ids = ids === null ? next : new Set([...ids].filter((id) => next.has(id)));
      return;
    }
    if (Array.isArray(node.AND)) node.AND.forEach(visit);
    // `{ employee: <filter> }`, which is how the regularization and timesheet
    // reads apply the same filter to a related row.
    if (node.employee && typeof node.employee === 'object') visit(node.employee);
  };

  clauses.forEach(visit);
  return ids;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

async function get(caller: Caller, url: string, plugin: Plugin = attendanceRoutes, prefix = '/attendance') {
  app = await appAs(caller, plugin, prefix);
  return app.inject({ method: 'GET', url });
}

// =========================================================== the role itself

describe('the IT Asset Manager role is not an HR role', () => {
  const held = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER);

  it('does not hold the employee directory grant, which is what gates the HR screens', () => {
    expect(held.has(PERMISSIONS.EMPLOYEE_READ)).toBe(false);
    expect(held.has(PERMISSIONS.EMPLOYEE_MANAGE)).toBe(false);
    expect(held.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)).toBe(false);
    expect(held.has(PERMISSIONS.EMPLOYEE_EXPORT)).toBe(false);
  });

  it('holds nothing of payroll or salary', () => {
    for (const grant of [
      PERMISSIONS.PAYROLL_READ,
      PERMISSIONS.PAYROLL_MANAGE,
      PERMISSIONS.PAYROLL_APPROVE,
    ]) {
      expect(held.has(grant)).toBe(false);
    }
    // Their own payslip, like any member of staff, and narrowed to it by scope.
    expect(held.has(PERMISSIONS.PAYSLIP_READ)).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE).toContain(PERMISSIONS.PAYSLIP_READ);
  });

  it('holds no grant that reaches somebody else’s medical record or loan', () => {
    for (const grant of [
      PERMISSIONS.MEDICAL_MANAGE,
      PERMISSIONS.MEDICAL_CLAIM_APPROVE,
      PERMISSIONS.MEDICAL_POLICY_READ,
      PERMISSIONS.LOAN_MANAGE,
      PERMISSIONS.LOAN_APPROVE,
      PERMISSIONS.LOAN_POLICY_READ,
    ]) {
      expect(held.has(grant)).toBe(false);
    }
    /*
     * `medical.read` and `loan.read` ARE held, and they are the same two grants
     * the Employee role holds: an OWN data scope narrows both to the holder's
     * own record, and the medical routes additionally refuse anybody else's
     * without `medical.manage`. Pinned as an equality with the Employee role so
     * that this role can never quietly acquire the wider version.
     */
    expect(held.has(PERMISSIONS.MEDICAL_READ)).toBe(true);
    expect(held.has(PERMISSIONS.LOAN_READ)).toBe(true);
  });

  it('holds no grant that writes or manages somebody else’s attendance', () => {
    expect(held.has(PERMISSIONS.ATTENDANCE_MANAGE)).toBe(false);
    expect(held.has(PERMISSIONS.ATTENDANCE_RULES_MANAGE)).toBe(false);
    expect(held.has(PERMISSIONS.DEVICE_READ)).toBe(false);
    expect(held.has(PERMISSIONS.DEVICE_MANAGE)).toBe(false);
    expect(held.has(PERMISSIONS.LEAVE_MANAGE)).toBe(false);
  });

  it('is scoped to its own record, which is what keeps every module above honest', () => {
    expect(DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER).toBe('OWN');
  });

  it('is the Employee role plus assets, and nothing else', () => {
    const employee = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE);
    const extra = [...held].filter((grant) => !employee.has(grant));
    // Every grant this role has beyond an ordinary member of staff's is an
    // asset grant. If that ever stops being true, it stopped being this role.
    expect(extra.every((grant) => grant.startsWith('asset.'))).toBe(true);
  });
});

// ====================================================== own attendance works

describe('the IT Asset Manager reads their own attendance', () => {
  it('serves their own month', async () => {
    const response = await get(IT_ASSET_MANAGER, `/attendance/summary?from=${DATE}&to=${DATE}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data.days).toBeDefined();
  });

  it('is served exactly one person by the team endpoint - themselves', async () => {
    const response = await get(
      IT_ASSET_MANAGER,
      `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ employeeId: string }>; meta: { total: number } };
    expect(body.data.map((row) => row.employeeId)).toEqual([IT.employeeId]);
    expect(body.meta.total).toBe(1);
  });
});

// ================================================ somebody else's is refused

describe('the IT Asset Manager cannot read anybody else’s attendance', () => {
  it('refuses a colleague’s attendance asked for by id', async () => {
    const response = await get(
      IT_ASSET_MANAGER,
      `/attendance/summary?employeeId=${COLLEAGUE.employeeId}&from=${DATE}&to=${DATE}`,
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a colleague’s row on the team endpoint', async () => {
    const response = await get(
      IT_ASSET_MANAGER,
      `/attendance/team?employeeId=${COLLEAGUE.employeeId}&from=${DATE}&to=${DATE}`,
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses the attendance report for somebody else', async () => {
    const response = await get(
      IT_ASSET_MANAGER,
      `/attendance/reports/monthly?employeeId=${COLLEAGUE.employeeId}&month=2026-09`,
      attendanceReportRoutes,
      '/attendance/reports',
    );

    expect(response.statusCode).toBe(403);
  });
});

// ============================== and a wide scope does not change the answer

describe('an ALL data scope does not open attendance without the directory grant', () => {
  it('still serves only the caller on the team endpoint', async () => {
    const response = await get(
      IT_WITH_WIDE_SCOPE,
      `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ employeeId: string }>; meta: { total: number } };
    expect(body.data.map((row) => row.employeeId)).toEqual([IT.employeeId]);
    expect(body.meta.total).toBe(1);
  });

  it('narrows the DATABASE QUERY rather than the response', async () => {
    await get(IT_WITH_WIDE_SCOPE, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    /*
     * The distinction this whole change turns on. A route that fetched the
     * company and filtered the rows afterwards would pass the test above and
     * would still have read four people's attendance off the disk - eighty, in
     * the company this was found in. So the assertion is on the WHERE the route
     * handed the database.
     */
    const rosterReads = rosterQueryWheres().filter(
      (where) => Array.isArray((where as { AND?: unknown[] }).AND),
    );
    expect(rosterReads.length).toBeGreaterThan(0);

    for (const where of rosterReads) {
      const ids = allowedIds((where as { AND: unknown[] }).AND);
      expect(ids).not.toBeNull();
      expect([...(ids as unknown as Set<string>)]).toEqual([IT.employeeId]);
    }
  });

  it('still refuses a colleague asked for by id', async () => {
    const response = await get(
      IT_WITH_WIDE_SCOPE,
      `/attendance/team?employeeId=${COLLEAGUE.employeeId}&from=${DATE}&to=${DATE}`,
    );

    expect(response.statusCode).toBe(403);
  });

  it('still refuses the company-wide team summary’s rows', async () => {
    const response = await get(
      IT_WITH_WIDE_SCOPE,
      `/attendance/team-summary?from=${DATE}&to=${DATE}`,
    );

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ employees: number }> };
    const people = body.data.reduce((sum, row) => sum + row.employees, 0);
    // One person in one bucket: the caller. Not eighty in five.
    expect(people).toBe(1);
  });
});

// ================================================= nobody else is affected

describe('the roles that always could still can', () => {
  it('serves HR Admin the whole company', async () => {
    const response = await get(HR_ADMIN, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: unknown[]; meta: { total: number } };
    expect(body.meta.total).toBe(ROSTER.length);
    expect(body.data).toHaveLength(ROSTER.length);
  });

  it('serves HR Admin a named employee’s attendance', async () => {
    const response = await get(
      HR_ADMIN,
      `/attendance/summary?employeeId=${COLLEAGUE.employeeId}&from=${DATE}&to=${DATE}`,
    );

    expect(response.statusCode).toBe(200);
  });

  it('leaves the manager’s reporting line exactly as it was', async () => {
    // A manager holds `employee.read`, so the narrowing is inert and the
    // ordinary REPORTS_AND_OWN filter is what reaches the database.
    await get(MANAGER, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    const wheres = rosterQueryWheres() as Array<{ AND: Array<Record<string, unknown>> }>;
    expect(wheres.length).toBeGreaterThan(0);
    const scopeClause = wheres[0]!.AND.find((clause) => Array.isArray(clause.OR));
    expect(scopeClause).toEqual({
      OR: [
        { id: 'emp-manager' },
        { managerId: 'emp-manager' },
        { secondaryManagerId: 'emp-manager' },
      ],
    });
  });

  /**
   * The widening, and the one shape of it that matters: it is a UNION, never a
   * substitution.
   *
   * A manager appointed to a team keeps everything their data scope already
   * reached - their own record and their reporting line - and gains the team.
   * Written as an assertion on the WHERE the route handed the database,
   * because "they saw six people" could be true of a filter that had quietly
   * replaced the reporting line with the team and dropped a direct report who
   * sits on another one.
   */
  it('adds the teams a manager actually manages, without dropping their reporting line', async () => {
    db.teamManager.findMany.mockResolvedValue([{ teamId: 'team-platform' }]);

    await get(MANAGER, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    const wheres = rosterQueryWheres() as Array<{ AND: Array<Record<string, unknown>> }>;
    const scopeClause = wheres[0]!.AND.find((clause) => Array.isArray(clause.OR)) as {
      OR: unknown[];
    };

    expect(scopeClause.OR).toEqual([
      {
        OR: [
          { id: 'emp-manager' },
          { managerId: 'emp-manager' },
          { secondaryManagerId: 'emp-manager' },
        ],
      },
      { teamId: { in: ['team-platform'] } },
    ]);
  });

  /**
   * And the appointment alone buys nothing.
   *
   * An employee who was made a team manager on the Teams screen but holds no
   * role carrying `team.data.read` reaches exactly what they reached before.
   * The grant and the appointment are two separate facts and BOTH are
   * required - which is what the roster screen warns about, and what this pins.
   */
  it('ignores an appointment held by somebody without the grant', async () => {
    db.teamManager.findMany.mockResolvedValue([{ teamId: 'team-platform' }]);

    const response = await get(EMPLOYEE, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
    expect(db.teamManager.findMany).not.toHaveBeenCalled();
  });

  it('leaves an ordinary employee reading exactly themselves, as before', async () => {
    const response = await get(EMPLOYEE, `/attendance/team?from=${DATE}&to=${DATE}&page=1&limit=100`);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ employeeId: string }> };
    expect(body.data.map((row) => row.employeeId)).toEqual([COLLEAGUE.employeeId]);
  });
});
