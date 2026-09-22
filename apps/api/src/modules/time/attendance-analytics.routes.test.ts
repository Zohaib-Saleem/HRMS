import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Who the attendance chart is allowed to draw.
 *
 * A chart is an aggregate, and an aggregate is exactly the shape in which data
 * leaks: "total worked hours" for a department the caller may not see is still
 * that department's data. So the endpoint is driven here the way anyone with a
 * session cookie and a terminal would drive it, and three gates are asserted
 * separately:
 *
 *   - the permission: no attendance.read, no chart;
 *   - the scope: the employee query is filtered before a single day is derived,
 *     and NONE means no rows rather than no filter;
 *   - the filters: department, team and employee narrow inside the scope and
 *     are never able to widen it.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceAnalyticsRoutes } = await import('./attendance-analytics.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/*
 * The caller these tests model is somebody reading OTHER PEOPLE'S attendance -
 * a manager or an HR administrator - and since `attendancePeopleFilter` landed
 * that takes `employee.read` alongside `attendance.read`. Both real roles hold
 * both grants; a caller with only `attendance.read` is now narrowed to their
 * own record however wide their data scope is, which is asserted on its own in
 * attendance-self-only.test.ts rather than here.
 */
const VIEWER: Permission[] = [PERMISSIONS.ATTENDANCE_READ, PERMISSIONS.EMPLOYEE_READ];
const OUTSIDER: Permission[] = [PERMISSIONS.EMPLOYEE_READ];

async function appAs(
  permissions: Permission[],
  dataScope: 'ALL' | 'OWN' | 'REPORTS' | 'DEPARTMENT' | 'NONE' = 'ALL',
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
  await app.register(attendanceAnalyticsRoutes, { prefix: '/attendance/analytics' });
  await app.ready();
  return app;
}

/** The company baseline the deriver reads. Values are the defaults, not rules. */
const COMPANY = {
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
};

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({ id: 'emp-1', departmentId: 'dep-1' });
  db.employee.findUnique.mockResolvedValue({ departmentId: 'dep-1', teamId: null });
  db.employee.findMany.mockResolvedValue([]);
  db.company.findUniqueOrThrow.mockResolvedValue(COMPANY);
  db.attendanceRecord.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

const get = async (url: string, permissions = VIEWER, scope: Parameters<typeof appAs>[1] = 'ALL') => {
  app = await appAs(permissions, scope);
  return app.inject({ method: 'GET', url });
};

/** The `where` the endpoint built for the employee query. */
const employeeWhere = () => db.employee.findMany.mock.calls[0]![0].where as { AND: unknown[] };

describe('attendance analytics endpoint', () => {
  describe('permission', () => {
    it('refuses a caller without attendance.read', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-09', OUTSIDER);

      expect(response.statusCode).toBe(403);
      expect(db.employee.findMany).not.toHaveBeenCalled();
    });

    it('allows a caller with attendance.read', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-09');

      expect(response.statusCode).toBe(200);
    });
  });

  describe('data scope', () => {
    it('derives nothing at all for a caller scoped to NONE', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-09', VIEWER, 'NONE');

      expect(response.statusCode).toBe(200);
      // No rows, rather than no filter - the mistake that would answer a
      // scope-less caller with the whole company.
      expect(db.employee.findMany).not.toHaveBeenCalled();
      expect(db.attendanceRecord.findMany).not.toHaveBeenCalled();
    });

    it('still draws the axis for a NONE caller, so the month reads as empty', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-09', VIEWER, 'NONE');
      const body = response.json().data;

      expect(body.days).toHaveLength(30);
      expect(body.summary.totalEmployees).toBe(0);
      expect(body.days.every((d: { workedMinutes: number }) => d.workedMinutes === 0)).toBe(true);
    });

    it('narrows an OWN caller to their own employee record', async () => {
      await get('/attendance/analytics/daily?month=2026-09', VIEWER, 'OWN');

      expect(employeeWhere().AND).toContainEqual({ id: 'emp-1' });
    });

    it('narrows a REPORTS caller to the people who report to them', async () => {
      await get('/attendance/analytics/daily?month=2026-09', VIEWER, 'REPORTS');

      expect(employeeWhere().AND).toContainEqual({
        OR: [{ managerId: 'emp-1' }, { secondaryManagerId: 'emp-1' }],
      });
    });

    it('gives an ALL caller an unrestricted scope clause, and nothing wider', async () => {
      await get('/attendance/analytics/daily?month=2026-09');
      const and = employeeWhere().AND;

      expect(and).toContainEqual({ companyId: 'company-1' });
      // Every query is company-scoped regardless of data scope.
      expect(JSON.stringify(and)).not.toContain('company-2');
    });
  });

  describe('filters narrow inside the scope, never outside it', () => {
    it('applies the department filter alongside the scope, not instead of it', async () => {
      await get('/attendance/analytics/daily?month=2026-09&departmentId=dep-9', VIEWER, 'OWN');
      const and = employeeWhere().AND;

      expect(and).toContainEqual({ id: 'emp-1' });
      expect(and).toContainEqual({ departmentId: 'dep-9' });
    });

    it('applies the team filter the same way', async () => {
      await get('/attendance/analytics/daily?month=2026-09&teamId=team-3', VIEWER, 'REPORTS');
      const and = employeeWhere().AND;

      expect(and).toContainEqual({ teamId: 'team-3' });
      expect(and).toContainEqual({
        OR: [{ managerId: 'emp-1' }, { secondaryManagerId: 'emp-1' }],
      });
    });

    it('refuses an employee the caller may not see, rather than charting them', async () => {
      // The scope check finds no match for the guessed id.
      db.employee.findFirst.mockImplementation(async (args: { select?: unknown }) =>
        args.select && 'id' in (args.select as Record<string, unknown>) && Object.keys(args.select as object).length === 1
          ? null
          : { id: 'emp-1', departmentId: 'dep-1' },
      );

      const response = await get(
        '/attendance/analytics/daily?month=2026-09&employeeId=someone-elses-id',
        VIEWER,
        'REPORTS',
      );

      expect(response.statusCode).toBe(403);
      expect(db.employee.findMany).not.toHaveBeenCalled();
    });

    it('excludes people who had left before the month or joined after it', async () => {
      await get('/attendance/analytics/daily?from=2026-09-01&to=2026-09-30');
      const and = JSON.stringify(employeeWhere().AND);

      expect(and).toContain('hireDate');
      expect(and).toContain('terminationDate');
    });
  });

  describe('range handling', () => {
    it('reads a month shorthand as that whole month', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-09');
      const body = response.json().data;

      expect(body.range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
      expect(body.days).toHaveLength(30);
    });

    it('handles February without inventing a 30th', async () => {
      const response = await get('/attendance/analytics/daily?month=2026-02');
      const body = response.json().data;

      expect(body.range).toEqual({ from: '2026-02-01', to: '2026-02-28' });
      expect(body.days).toHaveLength(28);
    });

    it('lets an explicit range win over the month shorthand', async () => {
      const response = await get(
        '/attendance/analytics/daily?month=2026-09&from=2026-08-01&to=2026-08-05',
      );

      expect(response.json().data.range).toEqual({ from: '2026-08-01', to: '2026-08-05' });
    });

    it('rejects a range that ends before it starts', async () => {
      const response = await get('/attendance/analytics/daily?from=2026-09-30&to=2026-09-01');

      expect(response.statusCode).toBe(422);
    });

    it('refuses a range too wide for a screen, naming the limit', async () => {
      const response = await get('/attendance/analytics/daily?from=2026-01-01&to=2026-12-31');

      expect(response.statusCode).toBe(422);
      expect(response.json().error.details.to[0]).toContain('62');
    });

    it('rejects a malformed month rather than guessing one', async () => {
      const response = await get('/attendance/analytics/daily?month=September');

      expect(response.statusCode).toBe(422);
    });
  });

  describe('efficiency', () => {
    it('reads attendance for the whole range in one query, not one per day', async () => {
      db.employee.findMany.mockResolvedValue([
        { id: 'emp-1', locationId: null },
        { id: 'emp-2', locationId: null },
      ]);

      await get('/attendance/analytics/daily?month=2026-09');

      // One findMany for 2 employees x 30 days. The chart must never fan out.
      expect(db.attendanceRecord.findMany).toHaveBeenCalledTimes(1);
      const where = db.attendanceRecord.findMany.mock.calls[0]![0].where;
      expect(where.employeeId.in).toEqual(['emp-1', 'emp-2']);
      expect(where.date.gte).toBeInstanceOf(Date);
      expect(where.date.lte).toBeInstanceOf(Date);
    });

    it('selects only the columns the deriver needs, never the whole employee row', async () => {
      await get('/attendance/analytics/daily?month=2026-09');

      // Six columns, and every one of them is read. `locationId` picks the
      // holiday calendar; the four lifecycle columns decide which days of the
      // month the person was employed for, which is the difference between a
      // leaver's last fortnight being blank and being thirty absences.
      expect(db.employee.findMany.mock.calls[0]![0].select).toEqual({
        id: true,
        locationId: true,
        status: true,
        hireDate: true,
        terminationDate: true,
        resignationDate: true,
      });
    });
  });
});
