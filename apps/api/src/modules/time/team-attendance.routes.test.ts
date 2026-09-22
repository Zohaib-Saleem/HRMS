import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The team attendance page, and the count under it.
 *
 * The bug these exist for: `/attendance/team` cut the page in the database and
 * then dropped the rows that did not match the status, so a request for 20
 * "absent" rows returned however many of that page's 20 employees happened to
 * be absent - eight, say - under a `meta` still describing all 80 people in
 * scope. The screen showed eight rows beneath "Showing 1 to 20 of 80", pages
 * two and beyond could be empty, and raising Rows to 50 changed the number of
 * rows fetched rather than the number displayed.
 *
 * So every assertion below is the same assertion from a different angle: the
 * rows returned and the `meta` describing them are one set.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceRoutes } = await import('./attendance.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

/** A Monday in the past, so an unrecorded working day scores ABSENT. */
const DATE = '2026-09-14';

/*
 * The caller these tests model is somebody reading OTHER PEOPLE'S attendance -
 * a manager or an HR administrator - and since `attendancePeopleFilter` landed
 * that takes `employee.read` alongside `attendance.read`. Both real roles hold
 * both grants; a caller with only `attendance.read` is now narrowed to their
 * own record however wide their data scope is, which is asserted on its own in
 * attendance-self-only.test.ts rather than here.
 */
const VIEWER: Permission[] = [PERMISSIONS.ATTENDANCE_READ, PERMISSIONS.EMPLOYEE_READ];

/** 80 people in scope, which is the denominator the footer prints. */
const TOTAL_EMPLOYEES = 80;
/** The first eight of them have no record on DATE, so they are the absentees. */
const ABSENT_COUNT = 8;
/** The next three arrived late, and the two after them stayed on. */
const LATE_COUNT = 3;
const OVERTIME_COUNT = 2;

const employee = (index: number) => ({
  id: `emp-${index}`,
  firstName: `Person${String(index).padStart(3, '0')}`,
  lastName: 'Example',
  displayName: null,
  employeeNumber: `E-${String(index).padStart(3, '0')}`,
  locationId: null,
  department: { name: 'Engineering' },
  team: { id: 'team-1', name: 'Platform' },
});

const ROSTER = Array.from({ length: TOTAL_EMPLOYEES }, (_, i) => employee(i));

/**
 * One stored day per employee, except the absentees who have none.
 *
 * Absence is the absence of a record on a working day that has already
 * happened - it is derived, never stored - which is exactly why the endpoint
 * cannot ask the database for "the absent people".
 *
 * Times are UTC and the company runs on Asia/Karachi, so the 09:00-18:00 shift
 * below is 04:00-13:00 here. The deriver recomputes minutes from the punches
 * rather than reading the stored columns back, so the fixture has to state the
 * punch it means and let lateness and overtime follow from it.
 */
const punch = (day: string, time: string) => new Date(`${day}T${time}:00.000Z`);

const RECORDS = ROSTER.slice(ABSENT_COUNT).map((e, i) => {
  const late = i < LATE_COUNT;
  const overtime = !late && i < LATE_COUNT + OVERTIME_COUNT;
  return {
    id: `rec-${e.id}`,
    employeeId: e.id,
    date: punch(DATE, '00:00'),
    status: 'PRESENT' as const,
    checkInAt: punch(DATE, late ? '04:30' : '04:00'),
    checkOutAt: punch(DATE, overtime ? '15:00' : '13:00'),
    workedMinutes: 540,
    lateMinutes: late ? 20 : 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: overtime ? 120 : 0,
    irregular: false,
    mode: 'OFFICE' as const,
    shiftId: null,
    shift: null,
    notes: null,
    source: 'DEVICE' as const,
  };
});

const POLICY = {
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
  await app.register(attendanceRoutes, { prefix: '/attendance' });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;

beforeEach(() => {
  vi.clearAllMocks();

  db.company.findUniqueOrThrow.mockResolvedValue(POLICY);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.employee.count.mockResolvedValue(TOTAL_EMPLOYEES);

  // The roster, cut the way the caller asked for it. `skip`/`take` are what the
  // unfiltered path uses; the filtered path takes the whole scope and slices it
  // itself, which is the difference these tests are about.
  db.employee.findMany.mockImplementation(
    async (args: { skip?: number; take?: number }) => {
      const skip = args.skip ?? 0;
      const take = args.take ?? ROSTER.length;
      return ROSTER.slice(skip, skip + take);
    },
  );

  db.attendanceRecord.findMany.mockImplementation(
    async (args: { where?: { employeeId?: { in?: string[] } } }) => {
      const ids = new Set(args.where?.employeeId?.in ?? []);
      return RECORDS.filter((r) => ids.has(r.employeeId));
    },
  );
});

afterEach(async () => {
  await app?.close();
  app = null;
});

async function team(query: Record<string, string | number>) {
  app = await appAs(VIEWER);
  const search = new URLSearchParams(
    Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
  ).toString();
  const response = await app.inject({ method: 'GET', url: `/attendance/team?${search}` });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    data: Array<{ employeeId: string; days: Array<{ status: string; flags: string[] }> }>;
    meta: { page: number; limit: number; total: number; totalPages: number };
  };
}

describe('an unfiltered page returns exactly the rows it promises', () => {
  it('returns 20 rows when Rows is 20', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20 });

    expect(body.data).toHaveLength(20);
    expect(body.meta).toMatchObject({ page: 1, limit: 20, total: 80, totalPages: 4 });
  });

  it('returns 50 rows when Rows is 50', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 50 });

    expect(body.data).toHaveLength(50);
    expect(body.meta.total).toBe(80);
  });

  it('returns the remainder on the last page rather than a short first one', async () => {
    const body = await team({ from: DATE, to: DATE, page: 2, limit: 50 });

    expect(body.data).toHaveLength(30);
    expect(body.data[0]?.employeeId).toBe('emp-50');
  });
});

describe('a status filter counts what it returns', () => {
  it('returns every absentee, and says there are only that many', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20, status: 'ABSENT' });

    // The regression: this used to be 8 rows under a total of 80.
    expect(body.data).toHaveLength(ABSENT_COUNT);
    expect(body.meta).toMatchObject({ total: ABSENT_COUNT, totalPages: 1 });
    expect(body.data.every((row) => row.days.every((d) => d.status === 'ABSENT'))).toBe(true);
  });

  it('fills a page of 20 when 20 people match', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20, status: 'PRESENT' });

    expect(body.data).toHaveLength(20);
    expect(body.meta.total).toBe(TOTAL_EMPLOYEES - ABSENT_COUNT);
  });

  it('fills a page of 50 when 50 people match', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 50, status: 'PRESENT' });

    expect(body.data).toHaveLength(50);
    expect(body.meta.total).toBe(TOTAL_EMPLOYEES - ABSENT_COUNT);
  });

  it('pages through the filtered set without repeating or losing anyone', async () => {
    const first = await team({ from: DATE, to: DATE, page: 1, limit: 50, status: 'PRESENT' });
    const second = await team({ from: DATE, to: DATE, page: 2, limit: 50, status: 'PRESENT' });

    expect(second.data).toHaveLength(TOTAL_EMPLOYEES - ABSENT_COUNT - 50);
    const ids = new Set([...first.data, ...second.data].map((r) => r.employeeId));
    expect(ids.size).toBe(TOTAL_EMPLOYEES - ABSENT_COUNT);
  });

  it('answers an out-of-range page with no rows rather than with somebody else', async () => {
    const body = await team({ from: DATE, to: DATE, page: 3, limit: 20, status: 'ABSENT' });

    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(ABSENT_COUNT);
  });
});

describe('late and overtime are flags, and filter like one', () => {
  it('returns only the people who arrived late', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20, flag: 'LATE' });

    expect(body.data).toHaveLength(LATE_COUNT);
    expect(body.meta.total).toBe(LATE_COUNT);
    expect(body.data.every((row) => row.days.every((d) => d.flags.includes('LATE')))).toBe(true);
  });

  it('returns only the people who worked past the end of their shift', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20, flag: 'OVERTIME' });

    expect(body.data).toHaveLength(OVERTIME_COUNT);
    expect(body.meta.total).toBe(OVERTIME_COUNT);
    expect(body.data.every((row) => row.days.every((d) => d.flags.includes('OVERTIME')))).toBe(
      true,
    );
  });

  it('returns nobody for a flag no day carries', async () => {
    const body = await team({ from: DATE, to: DATE, page: 1, limit: 20, flag: 'MISSING_PUNCH' });

    expect(body.data).toHaveLength(0);
    expect(body.meta).toMatchObject({ total: 0, totalPages: 0 });
  });
});
