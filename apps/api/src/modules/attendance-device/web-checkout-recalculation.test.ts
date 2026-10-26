import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A web check-out, and the terminal upload that comes after it.
 *
 * Before: the upload rewrote the whole day from its punches. A day whose only
 * punch was the morning arrival came back with no check-out at all - the
 * evening's web check-out wiped, the day reopened. Now the day has exactly one
 * check-out: the terminal's when its punches carry one, the web's when they do
 * not. Raw punches are only read, never changed.
 */

const db = vi.hoisted(() => ({
  attendanceRawPunch: { findMany: vi.fn(), updateMany: vi.fn() },
  attendanceRecord: { findUnique: vi.fn(), upsert: vi.fn() },
}));
vi.mock('../../core/db.js', () => ({ prisma: db }));

const POLICY = vi.hoisted(() => ({
  timeZone: 'Asia/Karachi',
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
  checkOutLocationEnforced: false,
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
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  overnightCheckOutWindowMinutes: 1080,
  overnightCheckOutCutoff: '06:00',
}));

vi.mock('../time/attendance-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../time/attendance-policy.js')>()),
  resolvePolicyFor: vi.fn(async () => POLICY),
}));
vi.mock('../time/attendance.service.js', () => ({ shiftOnDate: vi.fn(async () => null) }));
vi.mock('../leave/leave-reconciliation.service.js', () => ({ reconcileAfterAttendanceWrite: vi.fn() }));

const { recalculateFromPunches, settleCheckOut } = await import('./attendance-import.service.js');

/** Karachi is UTC+5: 09:02 local is 04:02Z. */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 21, h! - 5, m!));
};
const punch = (hhmm: string, punchState = 'IN') => ({ id: `p-${hhmm}`, punchedAt: at(hhmm), punchState });

const written = () =>
  (db.attendanceRecord.upsert.mock.calls.at(-1)![0] as { update: { checkInAt: Date; checkOutAt: Date | null; checkOutSource: string | null } }).update;

beforeEach(() => {
  vi.clearAllMocks();
  db.attendanceRawPunch.updateMany.mockResolvedValue({ count: 0 });
  db.attendanceRecord.upsert.mockResolvedValue({});
});

const recalc = () =>
  recalculateFromPunches({ companyId: 'c1', employeeId: 'e1', dayKey: '2026-10-21', pairing: 'DEVICE_STATE' });

describe('a terminal upload after a web check-out', () => {
  it('keeps the web check-out when the terminal only saw the arrival', async () => {
    db.attendanceRawPunch.findMany.mockResolvedValue([punch('09:02', 'IN')]);
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: 'r1', source: 'DEVICE', checkOutAt: at('18:10'), checkOutSource: 'SELF',
    });

    await recalc();

    expect(written()).toMatchObject({ checkInAt: at('09:02'), checkOutAt: at('18:10'), checkOutSource: 'SELF' });
  });

  it('takes the terminal check-out when it has one, so the day never has two', async () => {
    db.attendanceRawPunch.findMany.mockResolvedValue([punch('09:02', 'IN'), punch('18:20', 'OUT')]);
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: 'r1', source: 'DEVICE', checkOutAt: at('18:10'), checkOutSource: 'SELF',
    });

    await recalc();

    expect(written()).toMatchObject({ checkOutAt: at('18:20'), checkOutSource: 'DEVICE' });
    expect(db.attendanceRecord.upsert).toHaveBeenCalledTimes(1);
  });

  it('changes nothing for a day nobody closed on the web', async () => {
    db.attendanceRawPunch.findMany.mockResolvedValue([punch('09:02', 'IN')]);
    db.attendanceRecord.findUnique.mockResolvedValue({ id: 'r1', source: 'DEVICE', checkOutAt: null, checkOutSource: null });

    await recalc();

    expect(written()).toMatchObject({ checkOutAt: null, checkOutSource: null });
  });

  it('never touches an administrator-corrected day, web check-out or not', async () => {
    db.attendanceRawPunch.findMany.mockResolvedValue([punch('09:02', 'IN')]);
    db.attendanceRecord.findUnique.mockResolvedValue({ id: 'r1', source: 'ADMIN', checkOutAt: at('18:10'), checkOutSource: 'SELF' });

    const result = await recalc();

    expect(result.skipped).toBe('MANUAL_RECORD');
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });
});

describe('settleCheckOut', () => {
  it('ignores a web check-out that is not after the arrival', () => {
    expect(
      settleCheckOut({ device: null, checkInAt: at('09:00'), existing: { checkOutAt: at('08:00'), checkOutSource: 'SELF' } }),
    ).toEqual({ checkOutAt: null, checkOutSource: null });
  });

  it('does not keep a check-out an earlier upload wrote', () => {
    expect(
      settleCheckOut({ device: null, checkInAt: at('09:00'), existing: { checkOutAt: at('18:00'), checkOutSource: 'DEVICE' } }),
    ).toEqual({ checkOutAt: null, checkOutSource: null });
  });
});
