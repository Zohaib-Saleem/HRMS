import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Attendance Correction Centre.
 *
 * What is asserted here is not "the numbers changed" - it is the three
 * promises the module makes and would be worthless without:
 *
 *   1. A raw punch is never written. Not the instant, not the PIN, not the
 *      direction. The prisma mock has no `update` on the punch table at all,
 *      so any attempt to write one is a hard failure rather than a silent
 *      pass.
 *   2. Exactly one employee-day is touched. Nothing else is recalculated.
 *   3. Every change lands in the adjustment ledger with its old value, its new
 *      value, a reason and an actor - and the ledger is never written to
 *      except by appending.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findUnique: vi.fn() },
  company: { findUniqueOrThrow: vi.fn() },
  attendancePolicyAssignment: { findMany: vi.fn() },
  employeeShiftAssignment: { findFirst: vi.fn() },
  shift: { findFirst: vi.fn() },
  attendanceRecord: { findUnique: vi.fn(), upsert: vi.fn() },
  attendanceAdjustment: { create: vi.fn() },
  // Deliberately read-only: `update`, `updateMany` and `delete` are absent, so
  // a correction that tried to rewrite the evidence would throw.
  attendanceRawPunch: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { applyCorrection } = await import('./attendance-corrections.service.js');

/** The company under test: 09:00-18:00, Karachi, the shipped rule defaults. */
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

/** Karachi is UTC+5, so 09:00 local is 04:00 UTC. */
const local = (day: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!, h! - 5, m!));
};

/** The field errors a ValidationError carries, which is where its text lives. */
const fieldErrors = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    throw new Error('expected the correction to be refused');
  } catch (error) {
    const details = (error as { details?: { details?: Record<string, string[]> } }).details;
    return JSON.stringify(details ?? (error as Error).message);
  }
};

const DAY = '2026-06-10';

beforeEach(() => {
  vi.clearAllMocks();

  db.employee.findFirst.mockResolvedValue({
    id: 'emp-1',
    firstName: 'Ayesha',
    lastName: 'Khan',
    displayName: null,
    employeeNumber: 'E-001',
  });
  db.employee.findUnique.mockResolvedValue({ departmentId: null, teamId: null });
  db.company.findUniqueOrThrow.mockResolvedValue({ ...COMPANY });
  db.attendancePolicyAssignment.findMany.mockResolvedValue([]);
  db.employeeShiftAssignment.findFirst.mockResolvedValue(null);
  db.attendanceRecord.findUnique.mockResolvedValue(null);
  db.attendanceRecord.upsert.mockImplementation(async ({ create, update }: never) => ({
    id: 'rec-1',
    ...((create ?? update) as Record<string, unknown>),
  }));
  db.attendanceAdjustment.create.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: 'adj-1',
    ...(data as Record<string, unknown>),
  }));
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

const correct = (over: Record<string, unknown> = {}) =>
  applyCorrection({
    companyId: 'company-1',
    actorId: 'user-1',
    correction: {
      employeeId: 'emp-1',
      date: DAY,
      reason: 'Terminal was offline; times confirmed with the manager.',
      ...over,
    } as never,
  });

describe('correcting a day', () => {
  it('re-scores the day from the corrected times under the rules in force', async () => {
    // 09:00 to 18:00 in Karachi: nine hours elapsed, on time, no early leave.
    const outcome = await correct({
      checkInAt: local(DAY, '09:00').toISOString(),
      checkOutAt: local(DAY, '18:00').toISOString(),
    });

    const written = db.attendanceRecord.upsert.mock.calls[0]![0]!.update as Record<string, unknown>;
    expect(written.status).toBe('PRESENT');
    expect(written.workedMinutes).toBe(540);
    expect(written.lateMinutes).toBe(0);
    expect(written.earlyLeaveMinutes).toBe(0);
    expect(outcome.changedFields).toContain('checkInAt');
    expect(outcome.changedFields).toContain('checkOutAt');
  });

  it('marks the record ADMIN, so tonight`s device sync cannot undo it', async () => {
    await correct({
      checkInAt: local(DAY, '09:00').toISOString(),
      checkOutAt: local(DAY, '18:00').toISOString(),
    });

    const written = db.attendanceRecord.upsert.mock.calls[0]![0]!.update as Record<string, unknown>;
    // `recalculateFromPunches` refuses to overwrite an ADMIN record. Without
    // this flag a correction would survive only until the next import.
    expect(written.source).toBe('ADMIN');
  });

  it('never reads or writes a raw punch', async () => {
    await correct({
      checkInAt: local(DAY, '09:00').toISOString(),
      checkOutAt: local(DAY, '17:00').toISOString(),
    });

    // The mock has no writer at all; this asserts the reader was not used
    // either, so a correction cannot even have looked at the evidence to
    // decide what to overwrite.
    expect(db.attendanceRawPunch.findMany).not.toHaveBeenCalled();
    expect(db.attendanceRawPunch).not.toHaveProperty('update');
    expect(db.attendanceRawPunch).not.toHaveProperty('updateMany');
    expect(db.attendanceRawPunch).not.toHaveProperty('delete');
  });

  it('touches exactly one employee-day', async () => {
    await correct({ status: 'PRESENT', workedMinutes: 480 });

    expect(db.attendanceRecord.upsert).toHaveBeenCalledTimes(1);
    const where = db.attendanceRecord.upsert.mock.calls[0]![0]!.where as {
      employeeId_date: { employeeId: string; date: Date };
    };
    expect(where.employeeId_date.employeeId).toBe('emp-1');
    expect(where.employeeId_date.date.toISOString().slice(0, 10)).toBe(DAY);
  });

  it('lets an explicit minute override beat the re-scored figure', async () => {
    // The arithmetic is right and the world is wrong: a terminal whose clock
    // drifted an hour. The override is the escape hatch, and it is recorded.
    await correct({
      checkInAt: local(DAY, '09:40').toISOString(),
      checkOutAt: local(DAY, '18:00').toISOString(),
      lateMinutes: 0,
    });

    const written = db.attendanceRecord.upsert.mock.calls[0]![0]!.update as Record<string, unknown>;
    expect(written.lateMinutes).toBe(0);
    // Worked minutes were not overridden, so they are still derived.
    expect(written.workedMinutes).toBe(500);
  });

  it('refuses a correction that changes nothing', async () => {
    db.attendanceRecord.findUnique.mockResolvedValue({
      id: 'rec-1',
      status: 'PRESENT',
      checkInAt: local(DAY, '09:00'),
      checkOutAt: local(DAY, '18:00'),
      workedMinutes: 540,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      shiftId: null,
      notes: null,
      irregular: false,
    });

    await expect(
      correct({
        checkInAt: local(DAY, '09:00').toISOString(),
        checkOutAt: local(DAY, '18:00').toISOString(),
      }),
    ).rejects.toThrow(/differs/i);

    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
    expect(db.attendanceAdjustment.create).not.toHaveBeenCalled();
  });

  it('refuses a check-out at or before the check-in', async () => {
    const errors = await fieldErrors(
      correct({
        checkInAt: local(DAY, '18:00').toISOString(),
        checkOutAt: local(DAY, '09:00').toISOString(),
      }),
    );
    expect(errors).toMatch(/after check-in/i);
  });
});

describe('the audit trail', () => {
  it('records the old value, the new value, the reason and the actor', async () => {
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

    await correct({
      checkInAt: local(DAY, '09:00').toISOString(),
      checkOutAt: local(DAY, '18:00').toISOString(),
    });

    const entry = db.attendanceAdjustment.create.mock.calls[0]![0]!.data as {
      kind: string;
      changedFields: string[];
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string;
      actorId: string;
      employeeId: string;
    };

    expect(entry.kind).toBe('CORRECTION');
    expect(entry.actorId).toBe('user-1');
    expect(entry.employeeId).toBe('emp-1');
    expect(entry.reason).toMatch(/terminal was offline/i);
    expect(entry.changedFields).toEqual(
      expect.arrayContaining(['checkInAt', 'checkOutAt', 'status', 'workedMinutes']),
    );
    expect(entry.before.status).toBe('ABSENT');
    expect(entry.after.status).toBe('PRESENT');
    expect(entry.before.checkInAt).toBeNull();
    expect(entry.after.checkInAt).toBe(local(DAY, '09:00').toISOString());
  });

  it('writes the record and the ledger entry in one transaction', async () => {
    await correct({ status: 'HALF_DAY' });

    // Either both land or neither does. A corrected day with no ledger entry
    // would be exactly the untraceable edit this module exists to prevent.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.attendanceRecord.upsert).toHaveBeenCalledTimes(1);
    expect(db.attendanceAdjustment.create).toHaveBeenCalledTimes(1);
  });

  it('never deletes from the ledger', async () => {
    await correct({ status: 'PRESENT', workedMinutes: 300 });
    expect(db.attendanceAdjustment).not.toHaveProperty('delete');
    expect(db.attendanceAdjustment).not.toHaveProperty('deleteMany');
    expect(db.attendanceAdjustment).not.toHaveProperty('update');
  });
});

describe('historical data protection', () => {
  it('scores a past day against the policy in force on that date', async () => {
    // The engine is handed the attendance date, not "now". A correction to a
    // day in March must not be regraded against a rule introduced in
    // September.
    await correct({
      checkInAt: local(DAY, '09:00').toISOString(),
      checkOutAt: local(DAY, '18:00').toISOString(),
    });

    const call = db.attendancePolicyAssignment.findMany.mock.calls[0]![0]! as {
      where: { effectiveFrom: { lte: Date } };
    };
    expect(call.where.effectiveFrom.lte.toISOString().slice(0, 10)).toBe(DAY);
  });

  it('refuses a date beyond the correction horizon', async () => {
    const errors = await fieldErrors(correct({ date: '1900-01-01', status: 'PRESENT' }));
    expect(errors).toMatch(/too far in the past/i);
    expect(db.attendanceRecord.upsert).not.toHaveBeenCalled();
  });
});
