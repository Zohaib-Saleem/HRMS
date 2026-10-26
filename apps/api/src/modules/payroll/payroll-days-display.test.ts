import { describe, expect, it } from 'vitest';
import { payrollCalendarDays, payrollUnpaidBreakdown } from '@hrms/shared';
import { calculate, type DayFact, type EffectiveConfig } from './calculation.js';

/**
 * What the review sheet says about days, against what the calculation priced.
 *
 * Two reported problems, both display rather than arithmetic:
 *
 *  - "Working days 22" on a 30-day month. 22 was the scheduled working days,
 *    labelled as if it were the month. The calendar figure is derived from the
 *    same tally (scheduled + holidays + weekends), so it has to read 30.
 *  - "3 unpaid days" beside a deduction priced on 3.5. The sheet showed
 *    full-day absences; the deduction also charges a half day attended. The
 *    breakdown has to name the half day and add up to the deduction.
 *
 * The company under test mirrors production: calendar-day basis, absence and
 * unpaid leave deducted, Saturday and Sunday off.
 */

const CONFIG: EffectiveConfig = {
  basis: 'CALENDAR_DAYS',
  fixedBasisDays: 30,
  standardHoursPerDay: 8,
  overtimeMode: 'NONE',
  overtimeMultiplier: 1,
  overtimeFixedRate: 0,
  requireApprovedOvertime: false,
  overtimeCapMinutes: null,
  deductUnpaidAbsence: true,
  deductUnpaidLeave: true,
  lateDeductionMode: 'NONE',
  lateDeductionRate: 0,
  lateGraceMinutes: 0,
  earlyLeaveDeductionMode: 'NONE',
  earlyLeaveDeductionRate: 0,
  earlyLeaveGraceMinutes: 0,
  hourlyRateOverride: null,
  roundingDecimals: 0,
  overtimeWeekendMultiplier: null,
  overtimeHolidayMultiplier: null,
  fallbackScheduledMinutes: 480,
  prorationMethod: 'CALENDAR_DAYS',
  shortHoursDeductionMode: 'NONE',
  shortHoursDeductionRate: 0,
  shortHoursGraceMinutes: 0,
};

function fact(date: string, status: string, over: Partial<DayFact> = {}): DayFact {
  return {
    date,
    status,
    leaveIsPaid: null,
    leaveIsDeductible: null,
    leaveDayPart: null,
    workedMinutes: status === 'PRESENT' ? 480 : status === 'HALF_DAY' ? 240 : null,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    overtimeApproved: false,
    scheduledMinutes: 480,
    hasShift: true,
    hasRecord: status !== 'ABSENT',
    ...over,
  };
}

/** Every day of a month, weekends by the given weekday set, all present. */
function month(year: number, monthIndex: number, weekend: readonly number[] = [0, 6]): DayFact[] {
  const out: DayFact[] = [];
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= last; d += 1) {
    const date = new Date(Date.UTC(year, monthIndex, d));
    const key = date.toISOString().slice(0, 10);
    out.push(fact(key, weekend.includes(date.getUTCDay()) ? 'WEEKEND' : 'PRESENT'));
  }
  return out;
}

function run(days: DayFact[], salary = 67000) {
  const result = calculate({
    segments: [{ salaryType: 'MONTHLY', amount: salary, currency: 'PKR', days }],
    config: CONFIG,
    components: [],
    adjustments: [],
    periodDays: days.length,
  });
  const line = {
    salaryType: 'MONTHLY' as const,
    salaryAmount: salary,
    basisDays: result.basisDays,
    scheduledDays: result.tally.scheduledDays,
    holidayDays: result.tally.holidayDays,
    weekendDays: result.tally.weekendDays,
    payableDays: result.payableDays,
    unpaidDays: result.unpaidDays,
    absentDays: result.tally.absentDays,
    halfDays: result.tally.halfDays,
    deductions: result.deductions,
  };
  return { result, line, breakdown: payrollUnpaidBreakdown(line) };
}

describe('calendar days on the review sheet', () => {
  it.each([
    ['February 2026 (28 days)', 2026, 1, 28, 20],
    ['February 2028 (29 days)', 2028, 1, 29, 21],
    ['September 2026 (30 days)', 2026, 8, 30, 22],
    ['October 2026 (31 days)', 2026, 9, 31, 22],
  ])('%s reads its calendar length, not its working days', (_l, year, m, calendar, scheduled) => {
    const { result, breakdown } = run(month(year, m));
    expect(breakdown.calendarDays).toBe(calendar);
    expect(breakdown.scheduledDays).toBe(scheduled);
    // The calendar basis divides by the calendar, so the daily rate the sheet
    // shows is salary / calendar days - unchanged by this fix.
    expect(result.basisDays).toBe(calendar);
    expect(breakdown.paidDays).toBe(scheduled);
    expect(breakdown.unpaidDays).toBe(0);
  });

  it('a six-day week still reads the calendar, with fewer weekends', () => {
    const { breakdown } = run(month(2026, 8, [0]));
    expect(breakdown.calendarDays).toBe(30);
    expect(breakdown.scheduledDays).toBe(26);
  });

  it('holidays come out of scheduled days but stay in the calendar', () => {
    const days = month(2026, 8).map((d) =>
      d.date === '2026-09-14' ? fact(d.date, 'HOLIDAY') : d,
    );
    const { breakdown } = run(days);
    expect(breakdown.calendarDays).toBe(30);
    expect(breakdown.scheduledDays).toBe(21);
  });

  it('reads the same off stored line figures', () => {
    expect(payrollCalendarDays({ scheduledDays: 22, holidayDays: 0, weekendDays: 8 })).toBe(30);
  });
});

describe('unpaid days reconcile with the deduction', () => {
  /** Three absences and one half day: the shape of the reported 3 vs 3.5. */
  function threeAndAHalf(): DayFact[] {
    const absent = new Set(['2026-09-01', '2026-09-02', '2026-09-03']);
    return month(2026, 8).map((d) => {
      if (absent.has(d.date)) return fact(d.date, 'ABSENT');
      if (d.date === '2026-09-04') return fact(d.date, 'HALF_DAY');
      return d;
    });
  }

  it('names the half day as the source of the extra 0.5', () => {
    const { result, breakdown } = run(threeAndAHalf());
    expect(result.tally.absentDays).toBe(3);
    expect(result.tally.halfDays).toBe(1);
    expect(result.unpaidDays).toBe(3.5);

    expect(breakdown.fullDayAbsences).toBe(3);
    expect(breakdown.halfDayUnpaid).toBe(0.5);
    expect(breakdown.chargedDays).toBe(3.5);
    expect(breakdown.unpaidDays).toBe(3.5);
    expect(breakdown.reconciles).toBe(true);
  });

  it('prices the deduction on the configured basis, not a fixed 30 or the working days', () => {
    const { result, breakdown } = run(threeAndAHalf());
    // 67,000 / 30 calendar days = 2,233.33; x 3.5 = 7,816.67, rounded to 0 dp.
    expect(breakdown.dailyRate).toBe(2233.33);
    expect(breakdown.deductionAmount).toBe(7817);
    expect(result.deductions.find((d) => d.code === 'ABSENCE')).toMatchObject({ units: 3.5, amount: 7817 });
    // Paid + unpaid = scheduled: the sheet's four day columns add up.
    expect(breakdown.paidDays + breakdown.unpaidDays).toBe(breakdown.scheduledDays);
  });

  it('a 31-day month divides by 31', () => {
    const days = month(2026, 9).map((d) =>
      d.date === '2026-10-05' ? fact(d.date, 'ABSENT') : d,
    );
    const { breakdown } = run(days, 62000);
    expect(breakdown.dailyRate).toBe(2000);
    expect(breakdown.deductionAmount).toBe(2000);
  });

  it('separates leave without pay from absence, and a half-day LWP charges half', () => {
    const days = month(2026, 8).map((d) => {
      if (d.date === '2026-09-01') return fact(d.date, 'ON_LEAVE', { leaveIsPaid: false, leaveDayPart: 'FULL_DAY' });
      if (d.date === '2026-09-02') return fact(d.date, 'ON_LEAVE', { leaveIsPaid: false, leaveDayPart: 'FIRST_HALF' });
      if (d.date === '2026-09-03') return fact(d.date, 'ABSENT');
      return d;
    });
    const { result, breakdown } = run(days);
    expect(breakdown.unpaidLeaveDays).toBe(1.5);
    expect(breakdown.fullDayAbsences).toBe(1);
    expect(breakdown.chargedDays).toBe(2.5);
    expect(result.unpaidDays).toBe(2.5);
    expect(breakdown.reconciles).toBe(true);
    // An LWP day is ON_LEAVE, never also ABSENT: no double deduction.
    expect(result.tally.absentDays).toBe(1);
  });

  it('charges nothing for absence when the company does not deduct it, and still reconciles', () => {
    const result = calculate({
      segments: [{ salaryType: 'MONTHLY', amount: 67000, currency: 'PKR', days: threeAndAHalf() }],
      config: { ...CONFIG, deductUnpaidAbsence: false },
      components: [],
      adjustments: [],
      periodDays: 30,
    });
    const breakdown = payrollUnpaidBreakdown({
      salaryType: 'MONTHLY',
      salaryAmount: 67000,
      basisDays: result.basisDays,
      scheduledDays: result.tally.scheduledDays,
      holidayDays: result.tally.holidayDays,
      weekendDays: result.tally.weekendDays,
      payableDays: result.payableDays,
      unpaidDays: result.unpaidDays,
      absentDays: result.tally.absentDays,
      halfDays: result.tally.halfDays,
      deductions: result.deductions,
    });
    expect(breakdown.chargedDays).toBe(0);
    expect(breakdown.fullDayAbsences).toBe(0);
    expect(breakdown.reconciles).toBe(true);
  });

  it('flags a line whose stored unpaid days disagree with its deduction lines', () => {
    const { line } = run(threeAndAHalf());
    const tampered = payrollUnpaidBreakdown({ ...line, unpaidDays: 3 });
    expect(tampered.reconciles).toBe(false);
  });
});
