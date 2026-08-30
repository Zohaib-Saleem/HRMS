/**
 * The payroll calculation, as pure functions.
 *
 * Nothing here touches the database, the clock or the request. Given the same
 * facts it returns the same money, every time - which is what makes a run
 * reproducible and a disagreement about a payslip settleable by argument
 * rather than by re-running it and hoping.
 *
 * It also means the interesting decisions can be tested directly, without
 * standing up a company, an employee and three months of attendance to find out
 * what happens when someone is late twice.
 *
 * What this file deliberately does NOT do: decide whether a day was worked.
 * Every `DayFact` below comes from the existing attendance engine. Payroll
 * reads days; it never reads punches, and it never re-scores a day.
 */

import type { PayrollBasis, PayrollOvertimeMode, PayrollTimeDeductionMode } from '@prisma/client';

/** One day of the pay period, as the attendance engine reported it. */
export interface DayFact {
  date: string;
  /** PRESENT | HALF_DAY | ABSENT | ON_LEAVE | WEEKEND | HOLIDAY */
  status: string;
  /** Null when the day is not leave. Not `false` - the difference matters. */
  leaveIsPaid: boolean | null;
  /** FULL_DAY | FIRST_HALF | SECOND_HALF, or null when the day is not leave. */
  leaveDayPart: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  /** True when an approved timesheet covers this date. */
  overtimeApproved: boolean;
  /** Minutes the employee was rostered for, from the shift in force. */
  scheduledMinutes: number;
  /** False when no shift assignment covers the day. */
  hasShift: boolean;
  /**
   * Whether an attendance record exists for the day.
   *
   * False means the status was inferred - which for a working day means ABSENT.
   * That is the attendance engine's answer and payroll takes it, but a whole
   * period of inferred absence is worth telling somebody about rather than
   * quietly deducting a month's pay.
   */
  hasRecord: boolean;
}

/** Company settings merged with the employee's overrides. */
export interface EffectiveConfig {
  basis: PayrollBasis;
  fixedBasisDays: number;
  standardHoursPerDay: number;

  overtimeMode: PayrollOvertimeMode;
  overtimeMultiplier: number;
  overtimeFixedRate: number;
  requireApprovedOvertime: boolean;

  deductUnpaidAbsence: boolean;
  deductUnpaidLeave: boolean;

  lateDeductionMode: PayrollTimeDeductionMode;
  lateDeductionRate: number;
  lateGraceMinutes: number;

  earlyLeaveDeductionMode: PayrollTimeDeductionMode;
  earlyLeaveDeductionRate: number;
  earlyLeaveGraceMinutes: number;

  hourlyRateOverride: number | null;
  roundingDecimals: number;
}

/** A salary in force over part of the period. */
export interface SalarySegment {
  salaryType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  amount: number;
  currency: string;
  /** Days of the period this salary covered, inclusive. */
  days: DayFact[];
}

export interface ComponentInput {
  componentId: string | null;
  code: string | null;
  label: string;
  kind: 'EARNING' | 'DEDUCTION';
  calc: 'FIXED' | 'PERCENT_OF_BASIC' | 'PERCENT_OF_GROSS';
  value: number;
  isTaxable: boolean;
}

export interface AdjustmentInput {
  id: string;
  kind: 'EARNING' | 'DEDUCTION';
  label: string;
  amount: number;
}

export interface AttendanceTally {
  scheduledDays: number;
  scheduledMinutes: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  holidayDays: number;
  weekendDays: number;
  workedMinutes: number;
  lateOccurrences: number;
  lateMinutes: number;
  earlyLeaveOccurrences: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  /** Days with a check-in but no check-out: worked time is unknown. */
  incompleteDays: number;
  /** Working days with no shift assignment behind them. */
  daysWithoutShift: number;
  /** Working days with no attendance record at all behind them. */
  daysWithoutRecord: number;
}

export interface MoneyLine {
  componentId: string | null;
  code: string | null;
  label: string;
  kind: string;
  calc: 'FIXED' | 'PERCENT_OF_BASIC' | 'PERCENT_OF_GROSS';
  rate: number | null;
  units: number | null;
  amount: number;
  isTaxable: boolean;
}

export interface CalculationResult {
  tally: AttendanceTally;
  basisDays: number;
  dailyRate: number;
  hourlyRate: number;
  payableDays: number;
  unpaidDays: number;
  basicAmount: number;
  overtimeAmount: number;
  earnings: MoneyLine[];
  deductions: MoneyLine[];
  earningsTotal: number;
  deductionsTotal: number;
  adjustmentTotal: number;
  grossAmount: number;
  netAmount: number;
}

/**
 * Rounds to a fixed number of decimals, half away from zero.
 *
 * The `toFixed` step is not decoration. `2.675 * 100` is `267.49999999999997`
 * in binary floating point, and `Math.round` would take it down to 2.67 - a
 * cent that goes missing from somebody's pay every time the fraction lands
 * badly. Normalising the scaled value first puts it back.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  const scaled = Number((value * factor).toFixed(6));
  return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / factor;
}

/** How much of a day a leave record consumes. */
function leaveWeight(dayPart: string | null): number {
  return dayPart === 'FIRST_HALF' || dayPart === 'SECOND_HALF' ? 0.5 : 1;
}

/**
 * Counts the period.
 *
 * Weekends and holidays are not scheduled days: nobody was expected, so nobody
 * is short. Everything else in the period is a day someone was rostered for,
 * and the rest of the calculation is about what happened to it.
 */
export function tallyDays(days: readonly DayFact[], config: EffectiveConfig): AttendanceTally {
  const tally: AttendanceTally = {
    scheduledDays: 0,
    scheduledMinutes: 0,
    presentDays: 0,
    halfDays: 0,
    absentDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    holidayDays: 0,
    weekendDays: 0,
    workedMinutes: 0,
    lateOccurrences: 0,
    lateMinutes: 0,
    earlyLeaveOccurrences: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    approvedOvertimeMinutes: 0,
    incompleteDays: 0,
    daysWithoutShift: 0,
    daysWithoutRecord: 0,
  };

  for (const day of days) {
    if (day.status === 'WEEKEND') {
      tally.weekendDays += 1;
      continue;
    }
    if (day.status === 'HOLIDAY') {
      tally.holidayDays += 1;
      continue;
    }

    tally.scheduledDays += 1;
    tally.scheduledMinutes += day.scheduledMinutes;
    if (!day.hasShift) tally.daysWithoutShift += 1;
    if (!day.hasRecord) tally.daysWithoutRecord += 1;

    switch (day.status) {
      case 'PRESENT':
        tally.presentDays += 1;
        break;
      case 'HALF_DAY':
        tally.halfDays += 1;
        tally.presentDays += 0.5;
        break;
      case 'ON_LEAVE': {
        const weight = leaveWeight(day.leaveDayPart);
        // A leave type with no paid flag is treated as unpaid rather than
        // guessed at: paying for leave nobody configured as paid is the more
        // expensive mistake, and it shows up as an exception either way.
        if (day.leaveIsPaid === true) tally.paidLeaveDays += weight;
        else tally.unpaidLeaveDays += weight;
        // A half day of leave leaves half a day that was worked or was not;
        // whichever it was, the attendance record for the day carries it.
        if (weight < 1) tally.presentDays += 1 - weight;
        break;
      }
      default:
        tally.absentDays += 1;
        break;
    }

    tally.workedMinutes += day.workedMinutes ?? 0;

    const late = Math.max(0, (day.lateMinutes ?? 0) - config.lateGraceMinutes);
    if (late > 0) {
      tally.lateOccurrences += 1;
      tally.lateMinutes += late;
    }

    const early = Math.max(0, (day.earlyLeaveMinutes ?? 0) - config.earlyLeaveGraceMinutes);
    if (early > 0) {
      tally.earlyLeaveOccurrences += 1;
      tally.earlyLeaveMinutes += early;
    }

    const overtime = day.overtimeMinutes ?? 0;
    tally.overtimeMinutes += overtime;
    if (day.overtimeApproved) tally.approvedOvertimeMinutes += overtime;

    if (day.workedMinutes === null && day.status === 'PRESENT') tally.incompleteDays += 1;
  }

  return tally;
}

/**
 * What a monthly salary is divided by to reach a daily rate.
 *
 * The single most consequential number in the whole calculation, and the reason
 * this is configuration rather than a constant: a company paying by calendar
 * days and one paying by a fixed thirty produce different figures from the same
 * salary and the same attendance, and both are right for their own contracts.
 */
export function resolveBasisDays(
  config: EffectiveConfig,
  periodDays: number,
  scheduledDays: number,
): number {
  switch (config.basis) {
    case 'CALENDAR_DAYS':
      return periodDays;
    case 'WORKING_DAYS':
      return scheduledDays;
    default:
      return config.fixedBasisDays;
  }
}

/**
 * The whole calculation for one employee for one period.
 *
 * The order matters and is deliberate: basic first, because percentage
 * components are read against it; then overtime; then components; then the
 * deductions that price time already accounted for; then adjustments last,
 * because a correction should be able to answer for everything above it.
 */
export function calculate(input: {
  segments: readonly SalarySegment[];
  config: EffectiveConfig;
  components: readonly ComponentInput[];
  adjustments: readonly AdjustmentInput[];
  /** Calendar days in the period, before any employment clamp. */
  periodDays: number;
}): CalculationResult {
  const { segments, config, components, adjustments, periodDays } = input;
  const decimals = config.roundingDecimals;
  const round = (value: number) => roundTo(value, decimals);

  const allDays = segments.flatMap((s) => s.days);
  const tally = tallyDays(allDays, config);

  const salaryType = segments[0]?.salaryType ?? 'MONTHLY';
  const basisDays = Math.max(
    0,
    resolveBasisDays(config, periodDays, tally.scheduledDays),
  );

  // The rate a day of absence is priced at. Derived from the last salary in
  // force, which is the one a reviewer will have in mind; per-segment rates are
  // used below where a segment actually differs.
  const latest = segments[segments.length - 1];
  const latestAmount = latest?.amount ?? 0;

  const dailyRateFor = (amount: number): number => {
    if (salaryType === 'DAILY') return amount;
    if (salaryType === 'HOURLY') return amount * config.standardHoursPerDay;
    return basisDays > 0 ? amount / basisDays : 0;
  };

  const dailyRate = dailyRateFor(latestAmount);

  const hourlyRate =
    config.hourlyRateOverride ??
    (salaryType === 'HOURLY'
      ? latestAmount
      : config.standardHoursPerDay > 0
        ? dailyRate / config.standardHoursPerDay
        : 0);

  // --- what is and is not paid for -------------------------------------------
  // A half day worked is half a day not worked; whether that costs anything is
  // the same question as whether an absence does, so it follows the same flag.
  const unpaidAbsenceDays = config.deductUnpaidAbsence
    ? tally.absentDays + tally.halfDays * 0.5
    : 0;
  const unpaidLeaveCharged = config.deductUnpaidLeave ? tally.unpaidLeaveDays : 0;
  const unpaidDays = unpaidAbsenceDays + unpaidLeaveCharged;
  const payableDays = Math.max(0, tally.scheduledDays - unpaidDays);

  // --- basic ------------------------------------------------------------------
  let basicAmount = 0;

  if (salaryType === 'MONTHLY') {
    // Prorated by how much of the period each salary covered, so a raise on the
    // 16th pays half at each rate and a full period at one rate pays exactly
    // the salary - no basis arithmetic involved, because dividing and
    // re-multiplying by 30 would introduce an error the contract never had.
    for (const segment of segments) {
      const share = periodDays > 0 ? segment.days.length / periodDays : 0;
      basicAmount += segment.amount * share;
    }
  } else if (salaryType === 'DAILY') {
    // Paid for days actually worked, so an absence is simply not paid. Charging
    // an absence deduction on top would take the same day twice.
    for (const segment of segments) {
      const segmentTally = tallyDays(segment.days, config);
      const paid = segmentTally.presentDays + segmentTally.paidLeaveDays;
      basicAmount += segment.amount * paid;
    }
  } else {
    for (const segment of segments) {
      const segmentTally = tallyDays(segment.days, config);
      // Paid leave is paid at the hours the employee was rostered for; there
      // are no worked minutes to read on a day nobody worked.
      const paidLeaveMinutes =
        segmentTally.scheduledDays > 0
          ? (segmentTally.scheduledMinutes / segmentTally.scheduledDays) *
            segmentTally.paidLeaveDays
          : 0;
      basicAmount += segment.amount * ((segmentTally.workedMinutes + paidLeaveMinutes) / 60);
    }
  }

  basicAmount = round(basicAmount);

  // --- overtime ---------------------------------------------------------------
  const overtimeMinutes = config.requireApprovedOvertime
    ? tally.approvedOvertimeMinutes
    : tally.overtimeMinutes;
  const overtimeHours = overtimeMinutes / 60;

  let overtimeAmount = 0;
  if (config.overtimeMode === 'MULTIPLIER') {
    overtimeAmount = hourlyRate * config.overtimeMultiplier * overtimeHours;
  } else if (config.overtimeMode === 'FIXED_RATE') {
    overtimeAmount = config.overtimeFixedRate * overtimeHours;
  }
  overtimeAmount = round(overtimeAmount);

  // --- earnings ---------------------------------------------------------------
  const earnings: MoneyLine[] = [
    {
      componentId: null,
      code: 'BASIC',
      label: salaryType === 'MONTHLY' ? 'Basic salary' : 'Earned pay',
      kind: 'BASIC',
      calc: 'FIXED',
      rate: null,
      units: salaryType === 'HOURLY' ? round(tally.workedMinutes / 60) : payableDays,
      amount: basicAmount,
      isTaxable: true,
    },
  ];

  if (overtimeAmount !== 0 || overtimeMinutes > 0) {
    earnings.push({
      componentId: null,
      code: 'OVERTIME',
      label: 'Overtime',
      kind: 'OVERTIME',
      calc: 'FIXED',
      rate:
        config.overtimeMode === 'FIXED_RATE'
          ? config.overtimeFixedRate
          : round(hourlyRate * config.overtimeMultiplier),
      units: roundTo(overtimeHours, 2),
      amount: overtimeAmount,
      isTaxable: true,
    });
  }

  const earningComponents = components.filter((c) => c.kind === 'EARNING');
  const deductionComponents = components.filter((c) => c.kind === 'DEDUCTION');

  // Percent-of-basic and fixed first: they contribute to the figure that
  // percent-of-gross is then read against. Without a fixed order, two
  // percentage components could each be computed on a total that included the
  // other, and the result would depend on iteration order.
  for (const component of earningComponents) {
    if (component.calc === 'PERCENT_OF_GROSS') continue;
    const amount =
      component.calc === 'PERCENT_OF_BASIC'
        ? round((basicAmount * component.value) / 100)
        : round(component.value);
    earnings.push({
      componentId: component.componentId,
      code: component.code,
      label: component.label,
      kind: 'COMPONENT',
      calc: component.calc,
      rate: component.calc === 'FIXED' ? null : component.value,
      units: null,
      amount,
      isTaxable: component.isTaxable,
    });
  }

  const grossBeforePercent = earnings.reduce((sum, line) => sum + line.amount, 0);

  for (const component of earningComponents) {
    if (component.calc !== 'PERCENT_OF_GROSS') continue;
    earnings.push({
      componentId: component.componentId,
      code: component.code,
      label: component.label,
      kind: 'COMPONENT',
      calc: component.calc,
      rate: component.value,
      units: null,
      amount: round((grossBeforePercent * component.value) / 100),
      isTaxable: component.isTaxable,
    });
  }

  // --- deductions -------------------------------------------------------------
  const deductions: MoneyLine[] = [];

  // Only monthly pay carries an absence deduction. Daily and hourly staff were
  // never credited for the day in the first place, so deducting for it would be
  // charging them twice for one absence.
  if (salaryType === 'MONTHLY') {
    if (unpaidAbsenceDays > 0) {
      deductions.push({
        componentId: null,
        code: 'ABSENCE',
        label: 'Unpaid absence',
        kind: 'ABSENCE',
        calc: 'FIXED',
        rate: round(dailyRate),
        units: roundTo(unpaidAbsenceDays, 2),
        amount: round(dailyRate * unpaidAbsenceDays),
        isTaxable: false,
      });
    }
    if (unpaidLeaveCharged > 0) {
      deductions.push({
        componentId: null,
        code: 'UNPAID_LEAVE',
        label: 'Unpaid leave',
        kind: 'UNPAID_LEAVE',
        calc: 'FIXED',
        rate: round(dailyRate),
        units: roundTo(unpaidLeaveCharged, 2),
        amount: round(dailyRate * unpaidLeaveCharged),
        isTaxable: false,
      });
    }
  }

  if (config.lateDeductionMode !== 'NONE' && tally.lateOccurrences > 0) {
    const units =
      config.lateDeductionMode === 'PER_MINUTE' ? tally.lateMinutes : tally.lateOccurrences;
    deductions.push({
      componentId: null,
      code: 'LATE',
      label: 'Late arrival',
      kind: 'LATE',
      calc: 'FIXED',
      rate: config.lateDeductionRate,
      units,
      amount: round(config.lateDeductionRate * units),
      isTaxable: false,
    });
  }

  if (config.earlyLeaveDeductionMode !== 'NONE' && tally.earlyLeaveOccurrences > 0) {
    const units =
      config.earlyLeaveDeductionMode === 'PER_MINUTE'
        ? tally.earlyLeaveMinutes
        : tally.earlyLeaveOccurrences;
    deductions.push({
      componentId: null,
      code: 'EARLY_LEAVE',
      label: 'Early leaving',
      kind: 'EARLY_LEAVE',
      calc: 'FIXED',
      rate: config.earlyLeaveDeductionRate,
      units,
      amount: round(config.earlyLeaveDeductionRate * units),
      isTaxable: false,
    });
  }

  const grossForDeductions = earnings.reduce((sum, line) => sum + line.amount, 0);

  for (const component of deductionComponents) {
    const amount =
      component.calc === 'PERCENT_OF_BASIC'
        ? round((basicAmount * component.value) / 100)
        : component.calc === 'PERCENT_OF_GROSS'
          ? round((grossForDeductions * component.value) / 100)
          : round(component.value);
    deductions.push({
      componentId: component.componentId,
      code: component.code,
      label: component.label,
      kind: 'COMPONENT',
      calc: component.calc,
      rate: component.calc === 'FIXED' ? null : component.value,
      units: null,
      amount,
      isTaxable: false,
    });
  }

  // --- adjustments ------------------------------------------------------------
  let adjustmentTotal = 0;
  for (const adjustment of adjustments) {
    const amount = round(adjustment.amount);
    if (adjustment.kind === 'EARNING') {
      adjustmentTotal += amount;
      earnings.push({
        componentId: null,
        code: 'ADJUSTMENT',
        label: adjustment.label,
        kind: 'ADJUSTMENT',
        calc: 'FIXED',
        rate: null,
        units: null,
        amount,
        isTaxable: true,
      });
    } else {
      adjustmentTotal -= amount;
      deductions.push({
        componentId: null,
        code: 'ADJUSTMENT',
        label: adjustment.label,
        kind: 'ADJUSTMENT',
        calc: 'FIXED',
        rate: null,
        units: null,
        amount,
        isTaxable: false,
      });
    }
  }

  const earningsTotal = round(earnings.reduce((sum, line) => sum + line.amount, 0));
  const deductionsTotal = round(deductions.reduce((sum, line) => sum + line.amount, 0));

  return {
    tally,
    basisDays,
    dailyRate: round(dailyRate),
    hourlyRate: round(hourlyRate),
    payableDays: roundTo(payableDays, 2),
    unpaidDays: roundTo(unpaidDays, 2),
    basicAmount,
    overtimeAmount,
    earnings,
    deductions,
    earningsTotal,
    deductionsTotal,
    adjustmentTotal: round(adjustmentTotal),
    grossAmount: earningsTotal,
    netAmount: round(earningsTotal - deductionsTotal),
  };
}
