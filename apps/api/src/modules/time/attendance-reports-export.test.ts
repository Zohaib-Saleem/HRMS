import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The status filter on the report export.
 *
 * The chart's Export button hands the report endpoint whatever the reader had
 * on screen, status filter included. If the export ignored that filter it would
 * quietly hand back a different population from the one that was being looked
 * at - which is the kind of discrepancy somebody only finds after sending the
 * file to a payroll clerk.
 *
 * These drive the real endpoint. The filter is asserted on the rows that come
 * out, not on the query that goes in.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceReportRoutes } = await import('./attendance-reports.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const VIEWER: Permission[] = [PERMISSIONS.ATTENDANCE_READ];

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

/** Two stored days in the first week of September 2026: one worked, one short. */
const RECORDS = [
  {
    id: 'rec-1',
    employeeId: 'emp-1',
    date: new Date('2026-09-01T00:00:00.000Z'),
    status: 'PRESENT',
    checkInAt: new Date('2026-09-01T04:00:00.000Z'),
    checkOutAt: new Date('2026-09-01T13:00:00.000Z'),
    workedMinutes: 540,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    irregular: false,
    mode: 'ONSITE',
    shiftId: null,
    notes: null,
    source: 'DEVICE',
    shift: null,
  },
  {
    id: 'rec-2',
    employeeId: 'emp-1',
    date: new Date('2026-09-02T00:00:00.000Z'),
    status: 'ABSENT',
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    irregular: false,
    mode: null,
    shiftId: null,
    notes: null,
    source: 'SYSTEM',
    shift: null,
  },
];

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
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
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(attendanceReportRoutes, { prefix: '/attendance/reports' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue({ id: 'emp-1', departmentId: 'dep-1' });
  db.employee.findUnique.mockResolvedValue({ departmentId: 'dep-1', teamId: null });
  db.employee.findMany.mockResolvedValue([
    {
      id: 'emp-1',
      firstName: 'Ayesha',
      lastName: 'Khan',
      displayName: null,
      employeeNumber: 'E-001',
      locationId: null,
      department: { id: 'dep-1', name: 'Engineering' },
      team: { id: 'team-1', name: 'Platform' },
      designation: { name: 'Engineer' },
    },
  ]);
  db.company.findUniqueOrThrow.mockResolvedValue(COMPANY);
  db.attendanceRecord.findMany.mockResolvedValue(RECORDS);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
});

afterEach(async () => {
  await app?.close();
  app = null;
});

const daily = async (qs: string) => {
  app = await appAs(VIEWER);
  const response = await app.inject({
    method: 'GET',
    url: `/attendance/reports/daily?from=2026-09-01&to=2026-09-05${qs}`,
  });
  return response.json().data as { rows: Array<Record<string, unknown>> };
};

describe('report export status filter', () => {
  it('returns every derived day when no status is asked for', async () => {
    const report = await daily('');

    // Five calendar days, including the ones with no stored record.
    expect(report.rows).toHaveLength(5);
  });

  it('leaves existing reports untouched, which is why the filter is optional', async () => {
    const report = await daily('');
    const statuses = report.rows.map((r) => r.status);

    expect(statuses).toContain('PRESENT');
    expect(statuses).toContain('ABSENT');
  });

  it('narrows to absences when asked', async () => {
    const report = await daily('&status=ABSENT');

    // Three: the stored absence on the 2nd, plus the 3rd and 4th - working
    // days already past with no record, which the deriver scores as absence.
    // A derived absence is as real as a stored one and belongs in the export.
    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((r) => r.date)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    expect(report.rows.every((r) => r.status === 'ABSENT')).toBe(true);
  });

  it('narrows to a derived status that is never stored, such as the weekend', async () => {
    // 2026-09-05 is a Saturday and has no record; only the deriver knows it is
    // a weekend, which is precisely why the filter reads derived statuses.
    const report = await daily('&status=WEEKEND');

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.date).toBe('2026-09-05');
  });

  it('answers with no rows rather than an error when nothing matches', async () => {
    const report = await daily('&status=ON_LEAVE');

    expect(report.rows).toEqual([]);
  });

  it('rejects a status that is not a status', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: '/attendance/reports/daily?month=2026-09&status=LATE',
    });

    expect(response.statusCode).toBe(422);
  });

  it('carries the filter through to the CSV, so the file matches the screen', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: '/attendance/reports/daily/export?from=2026-09-01&to=2026-09-05&status=ABSENT',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const lines = response.body.trim().split('\r\n');
    // Header, the three absences, and the totals line.
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('ABSENT');
    expect(response.body).not.toContain('PRESENT');
  });
});
