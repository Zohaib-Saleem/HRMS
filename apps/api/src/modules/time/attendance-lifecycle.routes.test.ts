import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Attendance stops when the employment does.
 *
 * The bug: Team Attendance for 15 September 2026 showed Hira Javed (employee
 * 1001) as ABSENT. She was terminated on the 10th. She appeared in the table,
 * she raised the Absent count on the dashboard, and clicking that count opened
 * a list with her in it - five days after she had stopped being an employee.
 *
 * Nothing was wrong with her record. `/attendance/team` asked the database for
 * "employees in scope", handed every one of them to the deriver, and the
 * deriver classified every calendar day it was given: a working day with no
 * punch is an absence. Neither half had been told when the employment ended.
 *
 * These tests drive the real routes against a mocked database, and the mock
 * evaluates the lifecycle clause the route sends rather than ignoring it - so
 * the `total` under the table is asserted against the same filtered population
 * the rows come from, which is the other half of the fix.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn(), findFirst: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { attendanceRoutes } = await import('./attendance.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const dayOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** The day the bug was reported for. A Tuesday, and five days after she left. */
const AFTER_EXIT = '2026-09-15';
/** A Monday she worked, one day before her last. */
const BEFORE_EXIT = '2026-09-09';
/** Her last working day. */
const EXIT_DAY = '2026-09-10';
/** The day after it. */
const DAY_AFTER_EXIT = '2026-09-11';

const VIEWER: Permission[] = [PERMISSIONS.ATTENDANCE_READ];

// --------------------------------------------------------------- the roster

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  employeeNumber: string;
  locationId: string | null;
  department: { name: string } | null;
  team: { id: string; name: string } | null;
  status: string;
  hireDate: Date | null;
  terminationDate: Date | null;
  resignationDate: Date | null;
}

const person = (over: Partial<Person> & Pick<Person, 'id' | 'firstName' | 'employeeNumber'>): Person => ({
  lastName: 'Example',
  displayName: null,
  locationId: null,
  department: { name: 'Engineering' },
  team: { id: 'team-1', name: 'Platform' },
  status: 'ACTIVE',
  hireDate: dayOf('2024-01-01'),
  terminationDate: null,
  resignationDate: null,
  ...over,
});

/** The record from the report: terminated with a last working day of the 10th. */
const HIRA = person({
  id: 'emp-hira',
  firstName: 'Hira',
  lastName: 'Javed',
  employeeNumber: '1001',
  status: 'TERMINATED',
  hireDate: dayOf('2023-04-03'),
  terminationDate: dayOf('2026-09-10'),
});

/** Serving out her notice, last day at the end of the month. Still at work. */
const NOTICE = person({
  id: 'emp-notice',
  firstName: 'Bilal',
  employeeNumber: '1002',
  status: 'RESIGNED',
  resignationDate: dayOf('2026-09-01'),
  terminationDate: dayOf('2026-09-30'),
});

/** Resigned and gone in August. */
const RESIGNED = person({
  id: 'emp-resigned',
  firstName: 'Ayesha',
  employeeNumber: '1003',
  status: 'RESIGNED',
  resignationDate: dayOf('2026-08-01'),
  terminationDate: dayOf('2026-08-31'),
});

/** Ordinary employees, present every working day. */
const STAYERS = Array.from({ length: 5 }, (_, i) =>
  person({
    id: `emp-${i}`,
    firstName: `Person${String(i).padStart(2, '0')}`,
    employeeNumber: `E-${String(i).padStart(3, '0')}`,
  }),
);

const ROSTER: Person[] = [...STAYERS, HIRA, NOTICE, RESIGNED];

/** Sorted the way the route orders its pages, so slicing here means the same. */
const ordered = (people: Person[]) =>
  [...people].sort((a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));

// -------------------------------------------------------- attendance records

const punch = (dayKey: string, time: string) => new Date(`${dayKey}T${time}:00.000Z`);

/**
 * A full day's attendance for one person on one day.
 *
 * Hira has real, stored attendance for the first ten days of September. It must
 * survive this fix untouched: the point is that she stops being SCORED after
 * the 10th, not that the ten days she worked are hidden or deleted.
 */
const presentOn = (p: Person, dayKey: string) => ({
  id: `rec-${p.id}-${dayKey}`,
  employeeId: p.id,
  date: punch(dayKey, '00:00'),
  status: 'PRESENT' as const,
  checkInAt: punch(dayKey, '04:00'),
  checkOutAt: punch(dayKey, '13:00'),
  workedMinutes: 540,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  irregular: false,
  mode: 'OFFICE' as const,
  shiftId: null,
  shift: null,
  notes: null,
  source: 'DEVICE' as const,
});

/** Working days of September up to and including the 10th. */
const HIRA_WORKED = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];

const RECORDS = [
  ...HIRA_WORKED.map((d) => presentOn(HIRA, d)),
  // Everybody else turns up on the two days under test, so any ABSENT in the
  // results can only have come from somebody who was not employed.
  ...[...STAYERS, NOTICE].flatMap((p) =>
    [BEFORE_EXIT, EXIT_DAY, DAY_AFTER_EXIT, '2026-09-14', AFTER_EXIT].map((d) => presentOn(p, d)),
  ),
];

// --------------------------------------------------- a database that filters

/**
 * Just enough of a query engine to honour the lifecycle clause.
 *
 * Understands the operators `attendancePopulationWhere` actually emits and
 * ignores every other key - `companyId`, the scope fragment, the team and
 * department filters - because those are not what is under test. Without this,
 * the mock would return the whole roster whatever the route asked for, and the
 * `total` assertions below would prove nothing.
 */
const LIFECYCLE_KEYS = new Set(['status', 'hireDate', 'terminationDate', 'resignationDate']);

function matches(p: Person, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, value]) => {
    if (key === 'AND') return (value as Array<Record<string, unknown>>).every((c) => matches(p, c));
    if (key === 'OR') return (value as Array<Record<string, unknown>>).some((c) => matches(p, c));
    if (key === 'id') return typeof value === 'string' ? p.id === value : true;
    if (!LIFECYCLE_KEYS.has(key)) return true;

    const actual = p[key as keyof Person] as Date | string | null;
    if (value === null) return actual === null;

    const op = value as { lte?: Date; gte?: Date; notIn?: string[] };
    if (op.notIn) return !op.notIn.includes(actual as string);
    if (op.lte) return actual !== null && (actual as Date).getTime() <= op.lte.getTime();
    if (op.gte) return actual !== null && (actual as Date).getTime() >= op.gte.getTime();
    return actual === value;
  });
}

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
  db.attendanceRecord.groupBy.mockResolvedValue([]);

  db.employee.count.mockImplementation(
    async (args: { where: Record<string, unknown> }) =>
      ROSTER.filter((p) => matches(p, args.where)).length,
  );

  db.employee.findMany.mockImplementation(
    async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
      const eligible = ordered(ROSTER.filter((p) => matches(p, args.where)));
      const skip = args.skip ?? 0;
      const take = args.take ?? eligible.length;
      return eligible.slice(skip, skip + take);
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

interface TeamBody {
  data: Array<{
    employeeId: string;
    employeeName: string;
    days: Array<{ date: string; status: string }>;
    totals: { absent: number; present: number };
  }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
  totals: { absent: number; present: number };
}

async function team(query: Record<string, string | number>): Promise<TeamBody> {
  app = await appAs(VIEWER);
  const search = new URLSearchParams(
    Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
  ).toString();
  const response = await app.inject({ method: 'GET', url: `/attendance/team?${search}` });
  expect(response.statusCode).toBe(200);
  return response.json() as TeamBody;
}

const idsIn = (body: TeamBody) => body.data.map((r) => r.employeeId);

// -------------------------------------------------------------------- tests

describe('Team Attendance for 2026-09-15', () => {
  it('does not list Hira Javed, who was terminated on the 10th', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 50 });

    expect(idsIn(body)).not.toContain(HIRA.id);
    expect(body.data.map((r) => r.employeeName)).not.toContain('Hira Javed');
  });

  it('does not count her as absent', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 50 });

    // Everyone still employed on the 15th turned up, so the only absence the
    // old behaviour could produce was hers.
    expect(body.totals.absent).toBe(0);
  });

  it('still lists the people who were employed on it', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 50 });

    for (const p of [...STAYERS, NOTICE]) expect(idsIn(body)).toContain(p.id);
    // ...and not the person who resigned in August either.
    expect(idsIn(body)).not.toContain(RESIGNED.id);
  });
});

describe('Team Attendance for 2026-09-09', () => {
  it('lists Hira, because her termination date is the 10th', async () => {
    const body = await team({ from: BEFORE_EXIT, to: BEFORE_EXIT, page: 1, limit: 50 });

    expect(idsIn(body)).toContain(HIRA.id);
    const row = body.data.find((r) => r.employeeId === HIRA.id)!;
    expect(row.days.map((d) => d.date)).toEqual([BEFORE_EXIT]);
    expect(row.days[0]!.status).toBe('PRESENT');
  });
});

describe('the boundary, one day at a time', () => {
  const cases: Array<[string, boolean]> = [
    [BEFORE_EXIT, true],
    [EXIT_DAY, true],
    [DAY_AFTER_EXIT, false],
    [AFTER_EXIT, false],
  ];

  for (const [date, expected] of cases) {
    it(`${expected ? 'includes' : 'excludes'} her on ${date}`, async () => {
      const body = await team({ from: date, to: date, page: 1, limit: 50 });
      expect(idsIn(body).includes(HIRA.id)).toBe(expected);
    });
  }
});

describe('historical attendance is untouched', () => {
  it('shows every day Hira actually worked when the range is 1-10 September', async () => {
    const body = await team({ from: '2026-09-01', to: EXIT_DAY, page: 1, limit: 50 });

    const row = body.data.find((r) => r.employeeId === HIRA.id);
    expect(row, 'Hira must still have a row for a range she worked').toBeDefined();
    // Eight working days plus the weekend of the 5th and 6th.
    expect(row!.days.map((d) => d.date)).toEqual([
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
      '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
    ]);
    expect(row!.totals.present).toBe(HIRA_WORKED.length);
    expect(row!.totals.absent).toBe(0);
  });

  it('keeps her worked days and drops only the ones after she left, across the whole month', async () => {
    const body = await team({ from: '2026-09-01', to: '2026-09-30', page: 1, limit: 50 });

    const row = body.data.find((r) => r.employeeId === HIRA.id)!;
    const dates = row.days.map((d) => d.date);

    expect(dates[0]).toBe('2026-09-01');
    expect(dates.at(-1)).toBe(EXIT_DAY);
    expect(dates).not.toContain(DAY_AFTER_EXIT);
    expect(dates).not.toContain(AFTER_EXIT);
    expect(row.totals.present).toBe(HIRA_WORKED.length);
    // The regression: nineteen days of September used to score as absences.
    expect(row.totals.absent).toBe(0);
  });

  it('does not hide, alter or delete the stored records themselves', async () => {
    await team({ from: '2026-09-01', to: '2026-09-30', page: 1, limit: 50 });

    // The deriver still reads the whole range for her; it simply declines to
    // classify the days she was not employed for. Nothing writes.
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
    expect(db.attendanceRecord.findMany).toHaveBeenCalled();
  });
});

describe('a notice period is still attendance', () => {
  it('keeps someone working out their notice in the population', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 50 });

    // RESIGNED, so a filter on "status is ACTIVE" would have dropped him.
    const row = body.data.find((r) => r.employeeId === NOTICE.id);
    expect(row, 'a leaver serving notice is at work and must be scored').toBeDefined();
    expect(row!.days[0]!.status).toBe('PRESENT');
  });

  it('drops him the day after his last working day', async () => {
    const body = await team({ from: '2026-10-01', to: '2026-10-01', page: 1, limit: 50 });
    expect(idsIn(body)).not.toContain(NOTICE.id);
  });
});

describe('the dashboard drill-down', () => {
  /**
   * Clicking "Absent" on the dashboard opens `/attendance/team` filtered to
   * that status for the same day. It must open the same people the tile
   * counted, and neither may include somebody who had already left.
   */
  it('returns nobody for Absent on a day everybody employed turned up', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 20, status: 'ABSENT' });

    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(idsIn(body)).not.toContain(HIRA.id);
  });

  it('counts the same population in the team summary the tile is built from', async () => {
    app = await appAs(VIEWER);
    const response = await app.inject({
      method: 'GET',
      url: `/attendance/team-summary?from=${AFTER_EXIT}&to=${AFTER_EXIT}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ employees: number; absent: number; present: number }>;
    };

    const employees = body.data.reduce((n, r) => n + r.employees, 0);
    expect(employees).toBe(STAYERS.length + 1); // the stayers plus the leaver on notice
    expect(body.data.reduce((n, r) => n + r.absent, 0)).toBe(0);
  });
});

describe('pagination describes the filtered population', () => {
  it('reports a total that counts only people employed in the range', async () => {
    const body = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 50 });

    // Eight on the roster, two of them gone by the 15th.
    expect(body.meta.total).toBe(ROSTER.length - 2);
    expect(body.data).toHaveLength(ROSTER.length - 2);
  });

  it('asks the database for the same population twice, so count and rows agree', async () => {
    await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 2 });

    const countWhere = db.employee.count.mock.calls[0]![0].where;
    const rowsWhere = db.employee.findMany.mock.calls[0]![0].where;
    expect(countWhere).toEqual(rowsWhere);
  });

  it('pages through the filtered set without a short page or a blank one', async () => {
    const first = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 1, limit: 4 });
    const second = await team({ from: AFTER_EXIT, to: AFTER_EXIT, page: 2, limit: 4 });

    expect(first.data).toHaveLength(4);
    expect(second.data).toHaveLength(2);
    expect(first.meta.total).toBe(6);
    expect(second.meta.total).toBe(6);

    const seen = new Set([...idsIn(first), ...idsIn(second)]);
    expect(seen.size).toBe(6);
    expect(seen.has(HIRA.id)).toBe(false);
  });
});
