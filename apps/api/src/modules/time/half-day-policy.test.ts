import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clockBoundary } from '../../core/zoned-time.js';

/**
 * The half-day verdict follows the saved attendance settings - both when a day
 * is scored and, just as importantly, when it is read back.
 *
 * The bug this file exists to keep out: the deriver recomputed every FIGURE of
 * a stored day under the policy in force (hours, lateness, overtime) and then
 * read the STATUS off the row, as the import had written it under whatever the
 * thresholds were that night. Raising the half-day threshold in Settings moved
 * every number on the screen except the one the setting is named after.
 *
 * The thresholds below are the ones this deployment has saved - read from the
 * company row, not chosen for the test - and a second policy differs only in
 * the half-day threshold, to prove the verdict moves with the setting and
 * without a code change. No number here is a rule of the engine.
 */

const ZONE = 'Asia/Karachi';
const DAY = '2026-09-08';

/** The settings as saved in production on 2026-09-24. */
const CONFIGURED = {
  timezone: ZONE,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  graceMinutes: 15,
  halfDayMinutes: 240,
  fullDayMinutes: 540,
  earlyLeaveGraceMinutes: 15,
  overtimeEnabled: false,
  overtimeAfterMinutes: 600,
  overtimeDailyCapMinutes: 240,
  locationRestrictionEnabled: false,
  defaultGeofenceRadiusM: 200,
  ipRestrictionEnabled: false,
  allowedCheckInCidrs: [],
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  overtimeFromShiftEnd: false,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: 0,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '09:15',
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 15,
  defaultBreakMinutes: 0,
  lateThresholdMinutes: 0,
  earlyLeaveThresholdMinutes: 0,
  weekendWorkRule: 'IGNORE',
  holidayWorkRule: 'IGNORE',
  duplicatePunchWindowSeconds: 30,
  maxPlausibleSpanMinutes: 0,
  allowImplausibleSpans: false,
  overnightCheckOutWindowMinutes: 0,
  overnightCheckOutCutoff: '06:00',
};

/** The same company after Super Admin raises the half-day threshold. */
const RAISED = { ...CONFIGURED, halfDayMinutes: 300 };

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

const { computeAttendance, resolveAttendancePolicy } = await import('./attendance-policy.js');
const { deriveRangeForEmployees } = await import('./attendance.service.js');

const at = (hhmm: string, day = DAY): Date => {
  const instant = clockBoundary(day, hhmm, ZONE);
  if (!instant) throw new Error(`bad time ${hhmm}`);
  return instant;
};

const EMPLOYEE = {
  id: 'emp-1',
  locationId: null,
  status: 'ACTIVE',
  hireDate: new Date('2024-01-01T00:00:00.000Z'),
  terminationDate: null,
  resignationDate: null,
  excludedFromAttendance: false,
};

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A stored day, exactly as the import wrote it - status included. */
function stored(over: {
  date?: string;
  inAt: string | null;
  outAt: string | null;
  status: string;
  source?: string;
}) {
  const date = over.date ?? DAY;
  return {
    id: `rec-${date}`,
    employeeId: EMPLOYEE.id,
    date: day(date),
    checkInAt: over.inAt ? at(over.inAt, date) : null,
    checkOutAt: over.outAt ? at(over.outAt, date) : null,
    status: over.status,
    source: over.source ?? 'DEVICE',
    shiftId: null,
    shift: null,
    workedMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    irregular: false,
    mode: null,
    notes: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findUniqueOrThrow.mockResolvedValue(CONFIGURED);
  db.employee.findMany.mockResolvedValue([{ id: EMPLOYEE.id, departmentId: null, teamId: null }]);
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findMany.mockResolvedValue([]);
  db.leaveRequest.findMany.mockResolvedValue([]);
  db.holiday.findMany.mockResolvedValue([]);
  db.attendanceRecord.findMany.mockResolvedValue([]);
});

async function derived(from = DAY, to = DAY) {
  const byEmployee = await deriveRangeForEmployees('company-1', [EMPLOYEE], day(from), day(to));
  return byEmployee.get(EMPLOYEE.id) ?? [];
}

const score = (policy: typeof CONFIGURED, inAt: string | null, outAt: string | null) =>
  computeAttendance({
    day: DAY,
    checkInAt: inAt ? at(inAt) : null,
    checkOutAt: outAt ? at(outAt) : null,
    shift: null,
    policy: { ...policy, timeZone: ZONE } as never,
  });

describe('the engine scores a day on the configured thresholds', () => {
  it('1. at or above the configured full-day threshold is a full day', () => {
    // The whole 09:00-18:00 window is 540 minutes, which is the saved
    // fullDayMinutes with no tolerance.
    expect(score(CONFIGURED, '09:00', '18:00').status).toBe('PRESENT');
    expect(score(CONFIGURED, '09:00', '19:30').status).toBe('PRESENT');
  });

  it('2. below full day but at or above the configured half-day threshold is a half day', () => {
    // 09:00-13:00 covers 240 scheduled minutes: exactly the saved halfDayMinutes.
    expect(score(CONFIGURED, '09:00', '13:00').status).toBe('HALF_DAY');
    expect(score(CONFIGURED, '09:00', '17:59').status).toBe('HALF_DAY');
  });

  it('3. below the configured half-day threshold is what the policy says: absent', () => {
    expect(score(CONFIGURED, '09:00', '12:59').status).toBe('ABSENT');
  });

  it('4. changing the half-day setting changes the verdict, with no code change', () => {
    // 09:00-13:30 covers 270 minutes: a half day at 240, an absence at 300.
    expect(score(CONFIGURED, '09:00', '13:30').status).toBe('HALF_DAY');
    expect(score(RAISED, '09:00', '13:30').status).toBe('ABSENT');
    // And the day that clears the new threshold still earns its half day.
    expect(score(RAISED, '09:00', '14:00').status).toBe('HALF_DAY');
  });

  it('7. a missing check-out keeps following the configured missing-punch rule', () => {
    expect(score(CONFIGURED, '09:00', null).status).toBe('PRESENT');
    expect(score({ ...CONFIGURED, missingCheckOutStatus: 'ABSENT' }, '09:00', null).status).toBe(
      'ABSENT',
    );
    expect(score({ ...CONFIGURED, missingCheckInStatus: 'ABSENT' }, null, '18:00').status).toBe(
      'ABSENT',
    );
  });

  it('never lets the half-day threshold be read from anywhere but the policy', () => {
    // A company that retires half days by setting the threshold to the full
    // day gets exactly that: nothing in between.
    const noHalfDays = { ...CONFIGURED, halfDayMinutes: 540 };
    expect(score(noHalfDays, '09:00', '17:00').status).toBe('ABSENT');
    expect(score(noHalfDays, '09:00', '18:00').status).toBe('PRESENT');
  });
});

describe('the deriver reads the verdict from the active policy, not from the stored row', () => {
  it('reports a stored PRESENT as a half day when the punches fall short of the saved threshold', async () => {
    // Imported on a night when 480 minutes was a full day; the company has
    // since said 540. Same punches, and the screens now say what the setting
    // says.
    db.attendanceRecord.findMany.mockResolvedValue([
      stored({ inAt: '09:00', outAt: '17:30', status: 'PRESENT' }),
    ]);
    const [today] = await derived();
    expect(today?.status).toBe('HALF_DAY');
  });

  it('8. re-derives the same record under a changed policy and follows the new value', async () => {
    // 09:00-13:30 is 270 minutes on the roster.
    const record = stored({ inAt: '09:00', outAt: '13:30', status: 'HALF_DAY' });
    db.attendanceRecord.findMany.mockResolvedValue([record]);

    const [before] = await derived();
    expect(before?.status).toBe('HALF_DAY');

    // Super Admin raises the half-day threshold to 300. Nothing else changes:
    // not the row, not the punches, not the code.
    db.company.findUniqueOrThrow.mockResolvedValue(RAISED);
    const [after] = await derived();
    expect(after?.status).toBe('ABSENT');
    expect(after?.checkInAt).toBe(before?.checkInAt);
    expect(after?.checkOutAt).toBe(before?.checkOutAt);
    expect(after?.recordId).toBe(record.id);
  });

  it('keeps the status an administrator set, whatever the thresholds say', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      stored({ inAt: '09:00', outAt: '12:00', status: 'PRESENT', source: 'ADMIN' }),
    ]);
    const [today] = await derived();
    expect(today?.status).toBe('PRESENT');
    expect(today?.flags).toContain('MANUAL');
  });

  it('5. approved leave still follows the leave rules, whatever was punched', async () => {
    db.leaveRequest.findMany.mockResolvedValue([
      {
        employeeId: EMPLOYEE.id,
        startDate: day(DAY),
        endDate: day(DAY),
        dayPart: 'FULL_DAY',
        leaveType: { name: 'Annual', isPaid: true, isDeductible: false },
      },
    ]);
    db.attendanceRecord.findMany.mockResolvedValue([
      stored({ inAt: '09:00', outAt: '13:00', status: 'HALF_DAY' }),
    ]);
    const [today] = await derived();
    expect(today?.status).toBe('ON_LEAVE');
    expect(today?.leaveTypeName).toBe('Annual');
  });

  it('6. a holiday or a weekend never becomes a half day', async () => {
    // 2026-09-12 is a Saturday under the configured weekend; the 8th is a
    // Tuesday that we declare a holiday. Both carry a short stored day.
    db.holiday.findMany.mockResolvedValue([{ date: day(DAY), name: 'Founders Day', locationId: null }]);
    db.attendanceRecord.findMany.mockResolvedValue([
      stored({ inAt: '09:00', outAt: '13:00', status: 'HALF_DAY' }),
      stored({ date: '2026-09-12', inAt: '09:00', outAt: '13:00', status: 'HALF_DAY' }),
    ]);
    const days = await derived('2026-09-08', '2026-09-12');
    const byDate = new Map(days.map((d) => [d.date, d.status]));
    expect(byDate.get('2026-09-08')).toBe('HOLIDAY');
    expect(byDate.get('2026-09-12')).toBe('WEEKEND');
    expect([...byDate.values()]).not.toContain('HALF_DAY');
  });

  it('7. a stored day with no check-out follows the configured missing-punch rule', async () => {
    db.attendanceRecord.findMany.mockResolvedValue([
      stored({ inAt: '09:00', outAt: null, status: 'PRESENT' }),
    ]);
    expect((await derived())[0]?.status).toBe('PRESENT');

    db.company.findUniqueOrThrow.mockResolvedValue({ ...CONFIGURED, missingCheckOutStatus: 'ABSENT' });
    expect((await derived())[0]?.status).toBe('ABSENT');
  });

  it('reads the policy fresh on every derivation, so a saved setting applies at once', async () => {
    await derived();
    await derived();
    // Two derivations, two reads of the company row: nothing is cached across
    // requests, which is what lets a settings change apply to the next screen.
    expect(db.company.findUniqueOrThrow.mock.calls.length).toBeGreaterThanOrEqual(2);
    const policy = await resolveAttendancePolicy('company-1');
    expect(policy.halfDayMinutes).toBe(CONFIGURED.halfDayMinutes);
  });
});

/**
 * "30 minutes early is a half day" - where that came from, and where it goes.
 *
 * There is no early-departure rule in the engine that makes a half day. A day
 * is scored on how much of the shift it covered against the saved full-day
 * threshold, less the saved full-day tolerance. With 540 and 0 - the values
 * saved since 12 Sep 2026 - ANY early departure past the grace falls short of
 * a full day, 17:59 as much as 17:30. The Settings preview's "Early departure"
 * example happens to use 17:30, which is why it read as a 30-minute rule.
 *
 * The lever is the existing Full-day tolerance setting, and its value is the
 * company's to choose. These cases pin that the engine follows whatever is
 * saved - at the current value and at the two values discussed - and that
 * lateness, overtime, early arrival and missing punches do not move with it.
 */
describe('early departure follows the saved full-day tolerance, not a fixed rule', () => {
  const withTolerance = (minutes: number) => ({
    ...CONFIGURED,
    fullDayToleranceMinutes: minutes,
    overtimeEnabled: true,
    overtimeFromShiftEnd: true,
    overtimeAfterMinutes: 540,
  });

  it('09:00 -> 18:00 is a full day at any tolerance', () => {
    for (const t of [0, 30, 60]) expect(score(withTolerance(t), '09:00', '18:00').status).toBe('PRESENT');
  });

  it('at the saved tolerance of 0, a minute short is as short as thirty: no 30-minute rule exists', () => {
    expect(score(withTolerance(0), '09:00', '17:59').status).toBe('HALF_DAY');
    expect(score(withTolerance(0), '09:00', '17:30').status).toBe('HALF_DAY');
  });

  it('09:00 -> 17:30 is NOT a half day once the tolerance covers it, and the early departure is still recorded', () => {
    const day = score(withTolerance(30), '09:00', '17:30');
    expect(day.status).toBe('PRESENT');
    expect(day.earlyLeaveMinutes).toBe(30);
    expect(score(withTolerance(60), '09:00', '17:30').status).toBe('PRESENT');
  });

  it('09:00 -> 17:00 follows the saved tolerance, whatever it is', () => {
    expect(score(withTolerance(0), '09:00', '17:00').status).toBe('HALF_DAY');
    expect(score(withTolerance(30), '09:00', '17:00').status).toBe('HALF_DAY');
    expect(score(withTolerance(60), '09:00', '17:00').status).toBe('PRESENT');
    expect(score(withTolerance(60), '09:00', '16:59').status).toBe('HALF_DAY');
  });

  it('09:00 -> 18:30 keeps the configured overtime, whatever the tolerance', () => {
    for (const t of [0, 30, 60]) {
      const day = score(withTolerance(t), '09:00', '18:30');
      expect(day.status).toBe('PRESENT');
      expect(day.overtimeMinutes).toBe(30);
    }
  });

  it('lateness, early arrival and a missing check-out do not move with the tolerance', () => {
    for (const t of [0, 30, 60]) {
      const p = withTolerance(t);
      expect(score(p, '09:14', '18:00').lateMinutes).toBe(score(withTolerance(0), '09:14', '18:00').lateMinutes);
      const early = score(p, '08:43', '18:00');
      expect(early.status).toBe('PRESENT');
      expect(early.overtimeMinutes).toBe(0);
      expect(score(p, '09:00', null).status).toBe('PRESENT');
      // Past the irregular cutoff the day is scored on elapsed time, untouched
      // by a tolerance meant for the shift.
      expect(score(p, '14:00', '18:00').irregular).toBe(true);
      expect(score(p, '14:00', '18:00').status).toBe('HALF_DAY');
    }
  });

  it('never stretches far enough to swallow the half-day threshold', () => {
    // A tolerance of 600 would put "full day" below zero; it stops at the
    // saved half-day minimum, so half days are never silently retired.
    expect(score(withTolerance(600), '09:00', '12:59').status).toBe('ABSENT');
    expect(score(withTolerance(600), '09:00', '13:00').status).toBe('PRESENT');
  });
});

