import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The deriver is where the employment window is actually enforced.
 *
 * `employment-window.test.ts` proves the RULE; the route tests prove the
 * SCREENS. This file covers the seam between them: `deriveRangeForEmployees`
 * is the one function every attendance figure in the product is a sum of, so
 * a day it declines to emit cannot be counted as present, absent, half day,
 * late, overtime, leave, a holiday or a weekend anywhere downstream. That is
 * the property worth pinning, because it is what makes the fix impossible to
 * apply inconsistently.
 *
 * It also pins the single deliberate exception. Payroll asks for the whole
 * period regardless of the window, and it has to keep doing so until somebody
 * decides - with payroll tests and sign-off - to change what a mid-period
 * leaver is paid. A silent flip of that default would move money.
 */

const db = vi.hoisted(() => ({
  company: { findUniqueOrThrow: vi.fn() },
  employee: { findMany: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn() },
  employeeShiftAssignment: { findMany: vi.fn() },
  leaveRequest: { findMany: vi.fn() },
  holiday: { findMany: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { deriveRangeForEmployees } = await import('./attendance.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * Every weekday is a working day and no weekend gets in the way, so an
 * excluded day is unambiguous: it is missing, not merely re-labelled.
 */
const POLICY = {
  timezone: 'Asia/Karachi',
  weekendDays: [],
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

/** Hira Javed, employee 1001, terminated on 10 September 2026. */
const HIRA = {
  id: 'emp-1001',
  locationId: null,
  status: 'TERMINATED',
  hireDate: day('2023-04-03'),
  terminationDate: day('2026-09-10'),
  resignationDate: null,
  excludedFromAttendance: false,
};

/**
 * Her real attendance, as stored. Sep 1-4 and 7-10 were worked; the fix must
 * not touch a byte of it.
 */
const WORKED = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];

const RECORDS = WORKED.map((date) => ({
  id: `rec-${date}`,
  employeeId: HIRA.id,
  date: day(date),
  checkIn: new Date(`${date}T04:00:00.000Z`),
  checkOut: new Date(`${date}T13:00:00.000Z`),
  status: 'PRESENT',
  source: 'DEVICE',
  shiftId: null,
  shift: null,
  workedMinutes: 540,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue(POLICY);
  db.employee.findMany.mockResolvedValue([{ id: HIRA.id, departmentId: null, teamId: null }]);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue(RECORDS);
});

const derive = async (from: string, to: string, options?: { restrictToEmploymentWindow: boolean }) => {
  const byEmployee = await deriveRangeForEmployees(
    'company-1',
    [HIRA],
    day(from),
    day(to),
    options,
  );
  return byEmployee.get(HIRA.id) ?? [];
};

describe('deriveRangeForEmployees stops at the employment window', () => {
  it('emits no day at all for 2026-09-15, five days after she left', async () => {
    const days = await derive('2026-09-15', '2026-09-15');
    expect(days).toEqual([]);
  });

  it('emits her last working day, because the boundary is inclusive', async () => {
    const days = await derive('2026-09-10', '2026-09-10');
    expect(days.map((d) => d.date)).toEqual(['2026-09-10']);
    expect(days[0]!.status).toBe('PRESENT');
  });

  it('stops the month dead on the 10th rather than filling it with absences', async () => {
    const days = await derive('2026-09-01', '2026-09-30');

    expect(days.map((d) => d.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
    ]);
    // The bug, stated as a number: the twenty days after the exit used to come
    // back ABSENT. Not "zero absences for her" in general - zero days at all.
    expect(days.filter((d) => d.date > '2026-09-10')).toEqual([]);
  });

  it('leaves every historical day she worked exactly as it was', async () => {
    const days = await derive('2026-09-01', '2026-09-30');
    const present = days.filter((d) => d.status === 'PRESENT').map((d) => d.date);
    expect(present).toEqual(WORKED);
  });

  it('reads the stored records without hiding or rewriting any of them', async () => {
    await derive('2026-09-01', '2026-09-30');
    // The query is unchanged: the whole range is still fetched. The window
    // decides what is SCORED, never what is stored or read.
    const where = db.attendanceRecord.findMany.mock.calls[0]![0].where;
    expect(where.date).toEqual({ gte: day('2026-09-01'), lte: day('2026-09-30') });
  });

  it('classifies nothing after the exit under any status, not just absent', async () => {
    const days = await derive('2026-09-11', '2026-09-30');
    expect(days).toEqual([]);
  });
});

describe('the payroll opt-out is explicit and still works', () => {
  /**
   * Not an endorsement of the behaviour - it is the behaviour payroll already
   * had, kept deliberately so that fixing the screens does not reprice a final
   * settlement. See the note at the call site in payroll.service.ts.
   */
  it('scores the whole period when the window is switched off', async () => {
    const days = await derive('2026-09-01', '2026-09-30', { restrictToEmploymentWindow: false });
    expect(days).toHaveLength(30);
    // Days 11-15 are exactly the ABSENCES the screens no longer show, and
    // exactly the ones payroll has always priced. That is the whole reason
    // this opt-out exists rather than being cleaned away: flipping it moves a
    // final settlement.
    const afterExit = days.filter((d) => d.date > '2026-09-10' && d.date <= '2026-09-15');
    expect(afterExit.map((d) => d.status)).toEqual(Array(5).fill('ABSENT'));
  });

  it('applies the window unless asked not to, so a forgetful caller is safe', async () => {
    const defaulted = await derive('2026-09-01', '2026-09-30');
    const explicit = await derive('2026-09-01', '2026-09-30', { restrictToEmploymentWindow: true });
    expect(defaulted.map((d) => d.date)).toEqual(explicit.map((d) => d.date));
    expect(defaulted).toHaveLength(10);
  });
});
