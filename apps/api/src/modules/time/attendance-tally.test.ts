import { describe, expect, it } from 'vitest';
import { countInto, emptyCount } from './attendance-reports.service.js';
import { emptyMonthlyTotals, tallyDerived, type DerivedDay } from './attendance.service.js';

/**
 * One tally, and everybody reads it.
 *
 * `/attendance/summary`, the correction centre's `/attendance/monthly` and the
 * Employee 360 header all turn the same derived days into the same headline
 * numbers, because they all call `tallyDerived`. Before this they did not:
 * the summary endpoint and the correction centre each kept their own adder,
 * which is how one screen came to show a figure the next screen disagreed with.
 *
 * So the assertions here are mostly equalities BETWEEN consumers - the tally
 * against the report bucket - rather than against numbers typed into this file.
 * Two consumers agreeing is evidence a reader will not be told two different
 * things; a constant only proves the test and the code were written together.
 *
 * Nothing below sets a threshold, a grace period or an overtime rule. Every day
 * arrives already scored, which is the point: the tally counts what the policy
 * decided and decides nothing itself.
 */

/** A derived day with everything the tally reads and nothing it does not. */
function derived(over: Partial<DerivedDay> & Pick<DerivedDay, 'status'>): DerivedDay {
  return {
    date: '2026-09-08',
    flags: [],
    checkInAt: null,
    checkOutAt: null,
    workedMinutes: null,
    expectedMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    overtimeMinutes: null,
    irregular: false,
    integrity: 'NONE',
    mode: null,
    shiftId: null,
    shiftName: null,
    notes: null,
    leaveTypeName: null,
    leaveIsPaid: null,
    leaveIsDeductible: null,
    leaveDayPart: null,
    holidayName: null,
    source: null,
    recordId: null,
    hasRecord: false,
    ...over,
  };
}

/**
 * A month with one of everything, and no two figures the same.
 *
 * Deliberately distinctive minute counts: a tally that added the wrong column
 * or dropped one would land on a number no other column could explain.
 */
const MONTH: DerivedDay[] = [
  derived({
    status: 'PRESENT',
    flags: ['LATE'],
    workedMinutes: 505,
    expectedMinutes: 480,
    lateMinutes: 25,
    hasRecord: true,
  }),
  derived({
    status: 'PRESENT',
    flags: ['OVERTIME', 'EARLY_LEAVE'],
    workedMinutes: 610,
    expectedMinutes: 480,
    earlyLeaveMinutes: 15,
    overtimeMinutes: 130,
    hasRecord: true,
  }),
  derived({
    status: 'HALF_DAY',
    flags: ['MISSING_PUNCH'],
    workedMinutes: 245,
    expectedMinutes: 480,
    hasRecord: true,
  }),
  derived({ status: 'ABSENT', expectedMinutes: 480 }),
  derived({ status: 'ON_LEAVE', expectedMinutes: 480, leaveIsPaid: true }),
  derived({ status: 'WEEKEND' }),
  derived({ status: 'HOLIDAY' }),
  derived({ status: 'OFF_DAY' }),
  derived({ status: 'UPCOMING' }),
  derived({ status: 'PRESENT', flags: ['IRREGULAR', 'MANUAL'], irregular: true, hasRecord: true }),
];

describe('tallyDerived', () => {
  it('counts each status into its own bucket and never into absence', () => {
    const totals = tallyDerived(MONTH);

    expect(totals.present).toBe(3);
    expect(totals.halfDay).toBe(1);
    expect(totals.absent).toBe(1);
    expect(totals.onLeave).toBe(1);
    expect(totals.weekend).toBe(1);
    expect(totals.holiday).toBe(1);
    expect(totals.offDay).toBe(1);
    // A working day that has not arrived is its own count, never an absence.
    expect(totals.upcoming).toBe(1);
  });

  it('sums the minutes the engine put on each day, including the rostered ones', () => {
    const totals = tallyDerived(MONTH);
    const sum = (pick: (d: DerivedDay) => number | null) =>
      MONTH.reduce((total, day) => total + (pick(day) ?? 0), 0);

    expect(totals.workedMinutes).toBe(sum((d) => d.workedMinutes));
    // "Normal working hours" on the profile. Added here rather than in any
    // screen, so worked and normal are always two figures from one pass.
    expect(totals.expectedMinutes).toBe(sum((d) => d.expectedMinutes));
    expect(totals.lateMinutes).toBe(sum((d) => d.lateMinutes));
    expect(totals.earlyLeaveMinutes).toBe(sum((d) => d.earlyLeaveMinutes));
    expect(totals.overtimeMinutes).toBe(sum((d) => d.overtimeMinutes));
  });

  it('counts flags as occurrences, separately from the statuses they sit on', () => {
    const totals = tallyDerived(MONTH);

    // A late day is a PRESENT day that was late. It is counted in both.
    expect(totals.late).toBe(1);
    expect(totals.earlyLeave).toBe(1);
    expect(totals.overtime).toBe(1);
    expect(totals.missingPunch).toBe(1);
    expect(totals.irregular).toBe(1);
    expect(totals.manual).toBe(1);
    expect(totals.present).toBe(3);
  });

  it('scores attendance only against days that were actually scored', () => {
    const totals = tallyDerived(MONTH);

    // present 3 + half 0.5, over the four countable statuses (3+1+1+1 = 6).
    expect(totals.attendancePercentage).toBe(58.3);
  });

  it('leaves the percentage null when nothing was scored, rather than zero', () => {
    const totals = tallyDerived([derived({ status: 'WEEKEND' }), derived({ status: 'UPCOMING' })]);

    // "No data" and "nobody came" must not collapse into the same answer.
    expect(totals.attendancePercentage).toBeNull();
  });

  it('agrees with the report bucket on every figure they both count', () => {
    const totals = tallyDerived(MONTH);
    const bucket = emptyCount();
    for (const day of MONTH) countInto(bucket, day);

    // The exports and the screens are two consumers of one derivation. Where
    // they name the same quantity they must not be able to disagree about it.
    expect(totals.present + totals.halfDay * 0.5).toBe(bucket.presentDays);
    expect(totals.halfDay).toBe(bucket.halfDays);
    expect(totals.absent).toBe(bucket.absentDays);
    expect(totals.onLeave).toBe(bucket.leaveDays);
    expect(totals.workedMinutes).toBe(bucket.workedMinutes);
    expect(totals.expectedMinutes).toBe(bucket.expectedMinutes);
    expect(totals.lateMinutes).toBe(bucket.lateMinutes);
    expect(totals.earlyLeaveMinutes).toBe(bucket.earlyLeaveMinutes);
    expect(totals.overtimeMinutes).toBe(bucket.overtimeMinutes);
    expect(totals.late).toBe(bucket.lateCount);
    expect(totals.earlyLeave).toBe(bucket.earlyLeaveCount);
    expect(totals.missingPunch).toBe(bucket.missingPunchDays);
    expect(totals.irregular).toBe(bucket.irregularDays);
    expect(totals.manual).toBe(bucket.manualDays);
  });

  it('starts from zero on every counted field', () => {
    const empty = emptyMonthlyTotals();

    expect(tallyDerived([])).toEqual(empty);
    for (const [key, value] of Object.entries(empty)) {
      if (key === 'attendancePercentage') expect(value).toBeNull();
      else expect(value).toBe(0);
    }
  });
});
