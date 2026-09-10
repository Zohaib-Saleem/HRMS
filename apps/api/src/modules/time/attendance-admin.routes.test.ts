import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who may correct attendance, and who may only look at it.
 *
 * The correction centre hides the buttons a user cannot use, which is a
 * courtesy and not a control. These tests drive the endpoints the way anyone
 * with a session cookie and a terminal would, and assert two separate gates:
 *
 *   - the permission: reading attendance is not permission to change it;
 *   - the scope: a manager's reach ends at their own reports, and a guessed
 *     employee id does not widen it.
 *
 * Both matter. A system with the right permissions and no scope would let a
 * team lead correct the whole company's month.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  attendanceAdjustment: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  attendanceDeviceUserMapping: { findMany: vi.fn() },
  attendanceRawPunch: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  shift: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceAdminRoutes } = await import('./attendance-admin.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** Super Admin and HR Admin both hold read and manage. */
const HR_ADMIN: Permission[] = [PERMISSIONS.ATTENDANCE_READ, PERMISSIONS.ATTENDANCE_MANAGE];
/** A viewer: may see attendance, may not change it. */
const VIEWER: Permission[] = [PERMISSIONS.ATTENDANCE_READ];
/** No attendance permission at all. */
const OUTSIDER: Permission[] = [PERMISSIONS.EMPLOYEE_READ];

const CORRECTION = {
  employeeId: 'emp-1',
  date: '2026-06-10',
  status: 'PRESENT',
  workedMinutes: 480,
  reason: 'Terminal was offline; times confirmed with the manager.',
};

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS' = 'ALL',
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-1',
      companyId: 'company-1',
      email: 'caller@example.com',
      permissions: new Set(permissions),
      dataScope,
      mustChangePassword: false,
    };
  });
  await app.register(attendanceAdminRoutes, { prefix: '/attendance' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({
    id: 'emp-1',
    departmentId: 'dep-1',
    firstName: 'Ayesha',
    lastName: 'Khan',
    displayName: null,
    employeeNumber: 'E-001',
  });
  db.employee.findUnique.mockResolvedValue({ departmentId: null, teamId: null });
  db.employee.findMany.mockResolvedValue([]);
  db.employee.count.mockResolvedValue(0);
  db.company.findUniqueOrThrow.mockResolvedValue({
    timezone: 'Asia/Karachi',
    weekendDays: ['SATURDAY', 'SUNDAY'],
    graceMinutes: 10,
    halfDayMinutes: 240,
    fullDayMinutes: 480,
    earlyLeaveGraceMinutes: 10,
    overtimeEnabled: true,
    overtimeAfterMinutes: 480,
    overtimeDailyCapMinutes: 240,
    locationRestrictionEnabled: false,
    defaultGeofenceRadiusM: 200,
    ipRestrictionEnabled: false,
    allowedCheckInCidrs: [],
    defaultShiftStart: '09:00',
    defaultShiftEnd: '18:00',
    overtimeFromShiftEnd: true,
    overtimeCountsEarlyArrival: false,
    overtimeReducedByLateArrival: false,
    lateTrackingEnabled: true,
    earlyDepartureTrackingEnabled: true,
    fullDayToleranceMinutes: 30,
    irregularCheckInEnabled: true,
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
  });
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.attendanceRecord.findUnique.mockResolvedValue(null);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.attendanceRecord.upsert.mockResolvedValue({ id: 'rec-1' });
  db.attendanceAdjustment.create.mockResolvedValue({ id: 'adj-1' });
  db.attendanceAdjustment.findMany.mockResolvedValue([]);
  db.attendanceAdjustment.count.mockResolvedValue(0);
  db.attendanceDeviceUserMapping.findMany.mockResolvedValue([]);
  db.attendanceRawPunch.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

afterEach(async () => {
  await app?.close();
  app = null;
});

const post = async (
  permissions: Permission[],
  body: Record<string, unknown> = CORRECTION,
) => {
  app = await appAs(permissions);
  return app.inject({ method: 'POST', url: '/attendance/corrections', payload: body });
};

describe('correcting attendance', () => {
  it('lets HR Admin correct a day', async () => {
    const response = await post(HR_ADMIN);
    expect(response.statusCode).toBe(201);
    expect(db.attendanceRecord.upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses somebody who may only read attendance', async () => {
    const response = await post(VIEWER);
    expect(response.statusCode).toBe(403);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });

  it('refuses somebody with no attendance permission at all', async () => {
    const response = await post(OUTSIDER);
    expect(response.statusCode).toBe(403);
  });

  it('refuses before validating, so a bad payload cannot reveal the schema', async () => {
    const response = await post(VIEWER, { nonsense: true });
    expect(response.statusCode).toBe(403);
  });

  it('demands a reason', async () => {
    const response = await post(HR_ADMIN, { ...CORRECTION, reason: '' });
    expect(response.statusCode).toBe(422);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });

  it('writes an audit entry with the old and the new value', async () => {
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: 'rec-1',
      status: 'ABSENT',
      checkInAt: null,
      checkOutAt: null,
      workedMinutes: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
      overtimeMinutes: null,
      shiftId: null,
      notes: null,
      irregular: false,
    });

    await post(HR_ADMIN);

    const entry = db.auditLog.create.mock.calls[0]![0]!.data as {
      action: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      summary: string;
    };
    expect(entry.action).toBe('attendance.correct');
    expect(entry.before.status).toBe('ABSENT');
    expect(entry.after.status).toBe('PRESENT');
    expect(entry.summary).toMatch(/terminal was offline/i);
  });

  it('writes no audit entry when the request was refused', async () => {
    await post(VIEWER);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('data scope', () => {
  it('refuses a correction for somebody outside the caller`s scope', async () => {
    // The caller's own employee row is emp-1; the target is emp-9, and OWN
    // scope resolves to "only myself". The lookup that enforces this finds
    // nothing, so the request is refused rather than silently narrowed.
    db.employee.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      JSON.stringify(where).includes('emp-9')
        ? null
        : { id: 'emp-1', departmentId: 'dep-1', firstName: 'A', lastName: 'K', displayName: null, employeeNumber: 'E-001' },
    );

    app = await appAs(HR_ADMIN, 'OWN');
    const response = await app.inject({
      method: 'POST',
      url: '/attendance/corrections',
      payload: { ...CORRECTION, employeeId: 'emp-9' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });

  it('returns nothing at all to a caller whose scope resolves to nobody', async () => {
    // No employee row behind the login, and a scope narrower than ALL: the
    // filter is null, which callers must read as "no rows", never "no filter".
    db.employee.findFirst.mockResolvedValue(null);

    app = await appAs(VIEWER, 'REPORTS');
    const response = await app.inject({ method: 'GET', url: '/attendance/monthly' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(db.employee.findMany).not.toHaveBeenCalled();
  });
});

describe('the correction centre search', () => {
  it('refuses a caller with no attendance permission', async () => {
    app = await appAs(OUTSIDER);
    const response = await app.inject({ method: 'GET', url: '/attendance/monthly' });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a range longer than a screen should ask for', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: '/attendance/monthly?from=2026-01-01&to=2026-12-31',
    });
    expect(response.statusCode).toBe(422);
  });

  it('returns nothing for a PunchCode nobody is mapped to, without scanning employees', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: '/attendance/monthly?month=2026-06&punchCode=999',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(db.employee.findMany).not.toHaveBeenCalled();
  });

  it('narrows to the employees a PunchCode has ever been mapped to', async () => {
    db.attendanceDeviceUserMapping.findMany.mockResolvedValue([
      { employeeId: 'emp-1' },
      { employeeId: 'emp-2' },
      { employeeId: 'emp-1' },
    ]);

    app = await appAs(VIEWER);
    await app.inject({ method: 'GET', url: '/attendance/monthly?month=2026-06&punchCode=42' });

    const where = db.employee.findMany.mock.calls[0]![0]!.where as {
      AND: Array<Record<string, unknown>>;
    };
    // Both employees, deduplicated: the question is usually asked precisely
    // because the answer changed at some point.
    expect(JSON.stringify(where.AND)).toContain('emp-2');
  });
});

describe('the adjustment ledger', () => {
  it('is readable with attendance.read', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({ method: 'GET', url: '/attendance/adjustments' });
    expect(response.statusCode).toBe(200);
  });

  it('is not writable through any route on this plugin', async () => {
    app = await appAs(HR_ADMIN);
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/attendance/adjustments' });
      expect(response.statusCode).toBe(404);
    }
  });
});
