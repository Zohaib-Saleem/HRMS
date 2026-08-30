import type {
  Employee,
  PayrollExceptionCode,
  PayrollExceptionSeverity,
  PayrollProfile,
  PayrollSettings,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { deriveRangeForEmployees } from '../time/attendance.service.js';
import {
  calculate,
  type AdjustmentInput,
  type ComponentInput,
  type DayFact,
  type EffectiveConfig,
  type SalarySegment,
} from './calculation.js';

/**
 * Running payroll.
 *
 * The architecture this file sits at the end of:
 *
 *   device punches -> attendance engine -> attendance records
 *                  -> timesheets / overtime approval
 *                  -> PAYROLL
 *
 * Everything to the left of payroll already exists and is not touched here.
 * `gatherFacts` calls `deriveRangeForEmployees` - the same function the
 * attendance screens use - so a figure on a payslip can always be traced back
 * to a day an administrator can open and look at. There is one attendance
 * engine, and payroll is a consumer of it.
 *
 * The other half of this file is the run lifecycle, and the rule that governs
 * it: a FINALIZED run never changes. Every number the calculation used is
 * copied onto the line, so a later raise, attendance correction or policy edit
 * has nothing to reach back into.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fallback when an employee has no shift assignment and no company default. */
const ASSUMED_SHIFT_MINUTES = 480;

/** A calculation that started this long ago is treated as dead, not running. */
const CALCULATION_STALE_MS = 10 * 60 * 1000;

const dateKey = (d: Date): string => d.toISOString().slice(0, 10);

const toNumber = (value: Prisma.Decimal | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/** Every calendar day in an inclusive range, as YYYY-MM-DD. */
export function daysInRange(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    days.push(dateKey(new Date(t)));
  }
  return days;
}

// ---------------------------------------------------------------- configuration

/**
 * The company's payroll settings, created with defaults on first use.
 *
 * Created rather than required so that adding payroll to an existing company is
 * not a configuration exercise before it is anything else. The defaults
 * reproduce the most common arrangement - a fixed thirty-day month, time and a
 * half for approved overtime, absence deducted - and every one of them can be
 * changed.
 */
export async function resolveSettings(companyId: string): Promise<PayrollSettings> {
  const existing = await prisma.payrollSettings.findUnique({ where: { companyId } });
  if (existing) return existing;

  return prisma.payrollSettings.create({ data: { companyId } });
}

/**
 * Company settings with the employee's overrides applied.
 *
 * Null on the profile means "inherit", which is why a company that changes its
 * mind changes one row rather than every employee.
 */
export function effectiveConfig(
  settings: PayrollSettings,
  profile: PayrollProfile | null,
): EffectiveConfig {
  return {
    basis: profile?.basis ?? settings.basis,
    fixedBasisDays: profile?.fixedBasisDays ?? settings.fixedBasisDays,
    standardHoursPerDay: toNumber(profile?.standardHoursPerDay ?? settings.standardHoursPerDay),

    overtimeMode: profile?.overtimeMode ?? settings.overtimeMode,
    overtimeMultiplier: toNumber(profile?.overtimeMultiplier ?? settings.overtimeMultiplier),
    overtimeFixedRate: toNumber(profile?.overtimeFixedRate ?? settings.overtimeFixedRate),
    requireApprovedOvertime: settings.requireApprovedOvertime,

    deductUnpaidAbsence: profile?.deductUnpaidAbsence ?? settings.deductUnpaidAbsence,
    deductUnpaidLeave: profile?.deductUnpaidLeave ?? settings.deductUnpaidLeave,

    lateDeductionMode: settings.lateDeductionMode,
    lateDeductionRate: toNumber(settings.lateDeductionRate),
    lateGraceMinutes: settings.lateGraceMinutes,

    earlyLeaveDeductionMode: settings.earlyLeaveDeductionMode,
    earlyLeaveDeductionRate: toNumber(settings.earlyLeaveDeductionRate),
    earlyLeaveGraceMinutes: settings.earlyLeaveGraceMinutes,

    hourlyRateOverride:
      profile?.hourlyRateOverride === null || profile?.hourlyRateOverride === undefined
        ? null
        : toNumber(profile.hourlyRateOverride),
    roundingDecimals: settings.roundingDecimals,
  };
}

// -------------------------------------------------------------------- salaries

export interface SalaryRow {
  id: string;
  salaryType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  amount: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Whether two salary records claim the same day.
 *
 * An overlap is not a rounding problem, it is two contradictory answers to
 * "what is this person paid". The calculation refuses to guess which one wins.
 */
export function overlappingSalaries(rows: readonly SalaryRow[]): Array<[string, string]> {
  const clashes: Array<[string, string]> = [];
  const sorted = [...rows].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (!a || !b) continue;
      const aEnd = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
      if (b.effectiveFrom.getTime() <= aEnd) clashes.push([a.id, b.id]);
    }
  }
  return clashes;
}

/**
 * The salary in force on a given day.
 *
 * Latest start that has begun and has not ended. This is what makes a raise in
 * July pay July at the new figure and leave June alone.
 */
export function salaryOn(rows: readonly SalaryRow[], day: string): SalaryRow | null {
  let best: SalaryRow | null = null;
  for (const row of rows) {
    if (dateKey(row.effectiveFrom) > day) continue;
    if (row.effectiveTo && dateKey(row.effectiveTo) < day) continue;
    if (!best || dateKey(row.effectiveFrom) > dateKey(best.effectiveFrom)) best = row;
  }
  return best;
}

/**
 * Splits the period into stretches covered by one salary each.
 *
 * A period with no salary change comes back as a single segment, which is the
 * ordinary case; a raise mid-period produces two, and the calculation prorates
 * across them.
 */
export function segmentBySalary(
  days: readonly DayFact[],
  rows: readonly SalaryRow[],
): { segments: SalarySegment[]; uncovered: string[] } {
  const segments: SalarySegment[] = [];
  const uncovered: string[] = [];
  let current: { row: SalaryRow; segment: SalarySegment } | null = null;

  for (const day of days) {
    const row = salaryOn(rows, day.date);
    if (!row) {
      uncovered.push(day.date);
      continue;
    }
    if (!current || current.row.id !== row.id) {
      const segment: SalarySegment = {
        salaryType: row.salaryType,
        amount: row.amount,
        currency: row.currency,
        days: [],
      };
      segments.push(segment);
      current = { row, segment };
    }
    current.segment.days.push(day);
  }

  return { segments, uncovered };
}

// ----------------------------------------------------------------------- facts

interface EmployeeFacts {
  employeeId: string;
  days: DayFact[];
}

/**
 * The period as the attendance engine sees it, per employee.
 *
 * Three things are layered onto each derived day and nothing else:
 *   - the rostered length of the shift in force, for scheduled hours;
 *   - whether an approved timesheet covers the date, for overtime;
 *   - nothing about what a day is worth, which is the calculation's business.
 *
 * The days come back keyed by the company's own calendar, because that is what
 * the attendance engine already produced. A punch at 02:00 Karachi time was
 * assigned to its local day when it was imported; payroll inherits that and
 * does not repeat the decision.
 */
export async function gatherFacts(input: {
  companyId: string;
  employees: ReadonlyArray<{ id: string; locationId: string | null }>;
  from: Date;
  to: Date;
}): Promise<Map<string, EmployeeFacts>> {
  const { companyId, employees, from, to } = input;
  const employeeIds = employees.map((e) => e.id);

  const [derived, timesheets, assignments] = await Promise.all([
    deriveRangeForEmployees(companyId, employees, from, to),
    // Only APPROVED timesheets. A submitted-but-undecided one is not approval,
    // and treating it as such would pay for hours nobody agreed to.
    prisma.timesheet.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        periodStart: { lte: to },
        periodEnd: { gte: from },
      },
      select: { employeeId: true, periodStart: true, periodEnd: true },
    }),
    prisma.employeeShiftAssignment.findMany({
      where: {
        employeeId: { in: employeeIds },
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      include: { shift: { select: { startTime: true, endTime: true, breakMinutes: true } } },
      orderBy: { effectiveFrom: 'desc' },
    }),
  ]);

  const sheetsByEmployee = new Map<string, typeof timesheets>();
  for (const sheet of timesheets) {
    const list = sheetsByEmployee.get(sheet.employeeId);
    if (list) list.push(sheet);
    else sheetsByEmployee.set(sheet.employeeId, [sheet]);
  }

  const assignmentsByEmployee = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const list = assignmentsByEmployee.get(assignment.employeeId);
    if (list) list.push(assignment);
    else assignmentsByEmployee.set(assignment.employeeId, [assignment]);
  }

  const result = new Map<string, EmployeeFacts>();

  for (const employee of employees) {
    const derivedDays = derived.get(employee.id) ?? [];
    const sheets = sheetsByEmployee.get(employee.id) ?? [];
    const shifts = assignmentsByEmployee.get(employee.id) ?? [];

    const days: DayFact[] = derivedDays.map((day) => {
      const assignment = shifts.find(
        (a) =>
          dateKey(a.effectiveFrom) <= day.date &&
          (a.effectiveTo === null || dateKey(a.effectiveTo) >= day.date),
      );

      const scheduledMinutes = assignment
        ? shiftLengthMinutes(
            assignment.shift.startTime,
            assignment.shift.endTime,
            assignment.shift.breakMinutes,
          )
        : ASSUMED_SHIFT_MINUTES;

      const overtimeApproved = sheets.some(
        (s) => dateKey(s.periodStart) <= day.date && dateKey(s.periodEnd) >= day.date,
      );

      return {
        date: day.date,
        status: day.status,
        leaveIsPaid: day.leaveIsPaid,
        leaveDayPart: day.leaveDayPart,
        workedMinutes: day.workedMinutes,
        lateMinutes: day.lateMinutes,
        earlyLeaveMinutes: day.earlyLeaveMinutes,
        overtimeMinutes: day.overtimeMinutes,
        overtimeApproved,
        scheduledMinutes,
        hasShift: assignment !== undefined,
        hasRecord: day.hasRecord,
      };
    });

    result.set(employee.id, { employeeId: employee.id, days });
  }

  return result;
}

/**
 * How long a shift is, in minutes, net of its break.
 *
 * Wraps past midnight when the end time is at or before the start, which is how
 * an overnight shift is expressed: 22:00 to 06:00 is eight hours, not minus
 * sixteen. The attendance engine already pairs the punches for such a shift;
 * this only needs the rostered length.
 */
export function shiftLengthMinutes(
  startTime: string,
  endTime: string,
  breakMinutes: number,
): number {
  const parse = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  };

  const start = parse(startTime);
  const end = parse(endTime);
  if (start === null || end === null) return ASSUMED_SHIFT_MINUTES;

  const span = end > start ? end - start : 24 * 60 - start + end;
  return Math.max(0, span - Math.max(0, breakMinutes));
}

// ------------------------------------------------------------------ exceptions

interface PendingException {
  code: PayrollExceptionCode;
  severity: PayrollExceptionSeverity;
  message: string;
  employeeId: string | null;
  detail?: Prisma.InputJsonValue;
}

/** Fields without which a payslip cannot honestly be produced. */
function incompleteEmployeeFields(employee: Employee): string[] {
  const missing: string[] = [];
  if (!employee.employeeNumber?.trim()) missing.push('employee number');
  if (!employee.hireDate) missing.push('hire date');
  return missing;
}

// --------------------------------------------------------------- calculation

export interface CalculateOutcome {
  runId: string;
  employees: number;
  lines: number;
  exceptions: number;
  blocking: number;
  grossTotal: number;
  netTotal: number;
}

/**
 * Calculates every line of a run.
 *
 * Refuses to run against anything past REVIEW: an approved run is a decision
 * somebody made, and a finalized one is a fact. Recalculating either would make
 * the approval meaningless.
 */
export async function calculateRun(input: {
  runId: string;
  companyId: string;
  actorId: string | null;
}): Promise<CalculateOutcome> {
  const { runId, companyId, actorId } = input;

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId },
    include: { period: true },
  });
  if (!run) throw new NotFoundError('Payroll run');

  if (run.status === 'FINALIZED') {
    throw new ConflictError(
      'This run is finalized and cannot be recalculated. Corrections have to be made with a payroll adjustment.',
    );
  }
  if (run.status === 'CANCELLED') {
    throw new ConflictError('This run was cancelled. Create a new run instead.');
  }
  if (run.status === 'APPROVED') {
    throw new ConflictError(
      'This run is approved. Send it back to review before recalculating it.',
    );
  }
  if (
    run.status === 'CALCULATING' &&
    run.calculationStartedAt !== null &&
    Date.now() - run.calculationStartedAt.getTime() < CALCULATION_STALE_MS
  ) {
    throw new ConflictError('This run is already being calculated.');
  }

  const claimed = await prisma.payrollRun.updateMany({
    where: { id: runId, status: { in: ['DRAFT', 'REVIEW', 'CALCULATING'] } },
    data: { status: 'CALCULATING', calculationStartedAt: new Date() },
  });
  if (claimed.count === 0) throw new ConflictError('This run is already being calculated.');

  try {
    const outcome = await runCalculation({ run, companyId, actorId });
    return outcome;
  } catch (error) {
    // A failed calculation must not leave the run wedged in CALCULATING, or the
    // only way out would be a database edit.
    await prisma.payrollRun.update({
      where: { id: runId },
      data: { status: 'DRAFT', calculationStartedAt: null },
    });
    throw error;
  }
}

async function runCalculation(input: {
  run: { id: string; periodId: string; period: { startDate: Date; endDate: Date } };
  companyId: string;
  actorId: string | null;
}): Promise<CalculateOutcome> {
  const { run, companyId, actorId } = input;
  const from = run.period.startDate;
  const to = run.period.endDate;

  const [settings, company] = await Promise.all([
    resolveSettings(companyId),
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { currency: true, timezone: true },
    }),
  ]);

  // Everyone employed for any part of the period, including people who left
  // during it - a final salary is still owed.
  const employees = await prisma.employee.findMany({
    where: {
      companyId,
      OR: [{ terminationDate: null }, { terminationDate: { gte: from } }],
      AND: [{ OR: [{ hireDate: null }, { hireDate: { lte: to } }] }],
    },
    orderBy: [{ employeeNumber: 'asc' }],
  });

  const employeeIds = employees.map((e) => e.id);

  const [profiles, salaries, componentLinks, adjustments, facts] = await Promise.all([
    prisma.payrollProfile.findMany({ where: { employeeId: { in: employeeIds } } }),
    prisma.employeeSalary.findMany({
      where: { employeeId: { in: employeeIds } },
      orderBy: { effectiveFrom: 'asc' },
    }),
    prisma.employeeSalaryComponent.findMany({
      where: {
        employeeId: { in: employeeIds },
        isActive: true,
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      include: { component: true },
    }),
    prisma.payrollAdjustment.findMany({
      // Unclaimed, or already claimed by this very run. Without the second
      // case, recalculating would release the adjustment and then fail to see
      // it, and a correction would silently vanish from the run that was
      // meant to carry it.
      where: {
        companyId,
        employeeId: { in: employeeIds },
        appliedAt: null,
        OR: [{ appliedRunId: null }, { appliedRunId: run.id }],
      },
    }),
    gatherFacts({
      companyId,
      employees: employees.map((e) => ({ id: e.id, locationId: e.locationId })),
      from,
      to,
    }),
  ]);

  const profileByEmployee = new Map(profiles.map((p) => [p.employeeId, p]));
  const salariesByEmployee = new Map<string, SalaryRow[]>();
  for (const row of salaries) {
    const mapped: SalaryRow = {
      id: row.id,
      salaryType: row.salaryType,
      amount: toNumber(row.amount),
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
    const list = salariesByEmployee.get(row.employeeId);
    if (list) list.push(mapped);
    else salariesByEmployee.set(row.employeeId, [mapped]);
  }

  const componentsByEmployee = new Map<string, ComponentInput[]>();
  for (const link of componentLinks) {
    if (!link.component.isActive) continue;
    const input: ComponentInput = {
      componentId: link.componentId,
      code: link.component.code,
      label: link.component.name,
      kind: link.component.kind,
      calc: link.component.calc,
      value: toNumber(link.value),
      isTaxable: link.component.isTaxable,
    };
    const list = componentsByEmployee.get(link.employeeId);
    if (list) list.push(input);
    else componentsByEmployee.set(link.employeeId, [input]);
  }

  const adjustmentsByEmployee = new Map<string, AdjustmentInput[]>();
  for (const row of adjustments) {
    const input: AdjustmentInput = {
      id: row.id,
      kind: row.kind,
      label: row.label,
      amount: toNumber(row.amount),
    };
    const list = adjustmentsByEmployee.get(row.employeeId);
    if (list) list.push(input);
    else adjustmentsByEmployee.set(row.employeeId, [input]);
  }

  const periodDays = daysInRange(from, to).length;
  const pending: PendingException[] = [];
  const lineData: Array<{ employeeId: string; data: Prisma.PayrollLineUncheckedCreateInput }> = [];
  const earningsByEmployee = new Map<string, ReturnType<typeof calculate>['earnings']>();
  const deductionsByEmployee = new Map<string, ReturnType<typeof calculate>['deductions']>();
  const appliedAdjustmentIds: string[] = [];

  for (const employee of employees) {
    const profile = profileByEmployee.get(employee.id) ?? null;

    if (profile && !profile.isActive) continue;

    if (!profile) {
      pending.push({
        code: 'MISSING_PROFILE',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} has no payroll profile; company defaults were used.`,
        employeeId: employee.id,
      });
    }

    const missingFields = incompleteEmployeeFields(employee);
    if (missingFields.length > 0) {
      pending.push({
        code: 'INCOMPLETE_EMPLOYEE',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} is missing ${missingFields.join(' and ')}.`,
        employeeId: employee.id,
        detail: { missing: missingFields },
      });
    }

    const salaryRows = salariesByEmployee.get(employee.id) ?? [];
    if (salaryRows.length === 0) {
      pending.push({
        code: 'MISSING_SALARY',
        severity: 'BLOCKING',
        message: `${employee.firstName} ${employee.lastName} has no salary on record, so nothing can be calculated for them.`,
        employeeId: employee.id,
      });
      continue;
    }

    const clashes = overlappingSalaries(salaryRows);
    if (clashes.length > 0) {
      pending.push({
        code: 'OVERLAPPING_SALARY',
        severity: 'BLOCKING',
        message: `${employee.firstName} ${employee.lastName} has salary records that cover the same dates.`,
        employeeId: employee.id,
        detail: { pairs: clashes },
      });
      continue;
    }

    const config = effectiveConfig(settings, profile);
    const allDays = facts.get(employee.id)?.days ?? [];

    // Days outside employment are not this period's business: someone who
    // joined on the 15th is not absent for the first fortnight.
    const employedDays = allDays.filter((day) => {
      if (employee.hireDate && day.date < dateKey(employee.hireDate)) return false;
      if (employee.terminationDate && day.date > dateKey(employee.terminationDate)) return false;
      return true;
    });

    const { segments, uncovered } = segmentBySalary(employedDays, salaryRows);
    if (uncovered.length > 0) {
      pending.push({
        code: 'MISSING_SALARY',
        severity: 'BLOCKING',
        message: `${employee.firstName} ${employee.lastName} has ${uncovered.length} day(s) in this period with no salary in force.`,
        employeeId: employee.id,
        detail: { firstUncovered: uncovered[0], days: uncovered.length },
      });
      continue;
    }
    if (segments.length === 0) continue;

    // Monthly, daily and hourly pay are read in different units, and the
    // calculation applies one reading to the whole period. A period that
    // changes from one to another has no single right answer, so it is
    // refused rather than silently scored as whichever came first.
    const salaryTypes = new Set(segments.map((s) => s.salaryType));
    if (salaryTypes.size > 1) {
      pending.push({
        code: 'OVERLAPPING_SALARY',
        severity: 'BLOCKING',
        message: `${employee.firstName} ${employee.lastName} changes salary type mid-period (${[...salaryTypes].join(' then ')}). Close the period at the change and run each part separately.`,
        employeeId: employee.id,
        detail: { types: [...salaryTypes] },
      });
      continue;
    }

    const employeeAdjustments = adjustmentsByEmployee.get(employee.id) ?? [];
    const result = calculate({
      segments,
      config,
      components: componentsByEmployee.get(employee.id) ?? [],
      adjustments: employeeAdjustments,
      periodDays: employedDays.length > 0 ? employedDays.length : periodDays,
    });

    for (const adjustment of employeeAdjustments) appliedAdjustmentIds.push(adjustment.id);

    // --- exceptions the figures themselves reveal ----------------------------
    if (result.tally.daysWithoutShift > 0) {
      pending.push({
        code: 'MISSING_SHIFT',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} has ${result.tally.daysWithoutShift} working day(s) with no shift assigned; ${ASSUMED_SHIFT_MINUTES / 60} hours was assumed.`,
        employeeId: employee.id,
      });
    }

    // Every working day inferred rather than recorded. A new joiner is already
    // handled by the employment clamp, so this is a person the terminals never
    // saw - which is a data problem, not a month of absence to price.
    if (
      result.tally.scheduledDays > 0 &&
      result.tally.daysWithoutRecord === result.tally.scheduledDays
    ) {
      pending.push({
        code: 'INVALID_ATTENDANCE',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} has no attendance at all for this period, so every working day was scored as an absence. Check the attendance before paying this.`,
        employeeId: employee.id,
        detail: { scheduledDays: result.tally.scheduledDays },
      });
    }

    if (result.tally.incompleteDays > 0) {
      pending.push({
        code: 'INVALID_ATTENDANCE',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} has ${result.tally.incompleteDays} day(s) checked in but never out.`,
        employeeId: employee.id,
      });
    }

    const unapproved = result.tally.overtimeMinutes - result.tally.approvedOvertimeMinutes;
    if (config.requireApprovedOvertime && unapproved > 0) {
      pending.push({
        code: 'UNAPPROVED_OVERTIME',
        severity: 'WARNING',
        message: `${employee.firstName} ${employee.lastName} has ${(unapproved / 60).toFixed(2)} hour(s) of overtime with no approved timesheet; it was not paid.`,
        employeeId: employee.id,
        detail: { unapprovedMinutes: unapproved },
      });
    }

    if (result.netAmount <= 0) {
      pending.push({
        code: 'NON_POSITIVE_NET',
        severity: 'BLOCKING',
        message: `${employee.firstName} ${employee.lastName} nets ${result.netAmount}, which needs a human decision before it is paid.`,
        employeeId: employee.id,
        detail: { net: result.netAmount },
      });
    }

    const latestSegment = segments[segments.length - 1];
    lineData.push({
      employeeId: employee.id,
      data: {
        companyId,
        runId: run.id,
        employeeId: employee.id,
        salaryType: latestSegment?.salaryType ?? 'MONTHLY',
        salaryAmount: latestSegment?.amount ?? 0,
        currency: latestSegment?.currency ?? company.currency,
        basis: config.basis,
        basisDays: result.basisDays,
        dailyRate: result.dailyRate,
        hourlyRate: result.hourlyRate,
        salarySegments: segments.length,

        scheduledDays: result.tally.scheduledDays,
        scheduledMinutes: result.tally.scheduledMinutes,
        presentDays: result.tally.presentDays,
        halfDays: result.tally.halfDays,
        absentDays: result.tally.absentDays,
        paidLeaveDays: result.tally.paidLeaveDays,
        unpaidLeaveDays: result.tally.unpaidLeaveDays,
        holidayDays: result.tally.holidayDays,
        weekendDays: result.tally.weekendDays,
        payableDays: result.payableDays,
        unpaidDays: result.unpaidDays,
        workedMinutes: result.tally.workedMinutes,
        lateOccurrences: result.tally.lateOccurrences,
        lateMinutes: result.tally.lateMinutes,
        earlyLeaveOccurrences: result.tally.earlyLeaveOccurrences,
        earlyLeaveMinutes: result.tally.earlyLeaveMinutes,
        overtimeMinutes: result.tally.overtimeMinutes,
        approvedOvertimeMinutes: result.tally.approvedOvertimeMinutes,

        basicAmount: result.basicAmount,
        earningsTotal: result.earningsTotal,
        overtimeAmount: result.overtimeAmount,
        deductionsTotal: result.deductionsTotal,
        adjustmentTotal: result.adjustmentTotal,
        grossAmount: result.grossAmount,
        netAmount: result.netAmount,
      },
    });

    earningsByEmployee.set(employee.id, result.earnings);
    deductionsByEmployee.set(employee.id, result.deductions);
  }

  const blocking = pending.filter((e) => e.severity === 'BLOCKING').length;
  const grossTotal = lineData.reduce((sum, l) => sum + Number(l.data.grossAmount), 0);
  const deductionTotal = lineData.reduce((sum, l) => sum + Number(l.data.deductionsTotal), 0);
  const netTotal = lineData.reduce((sum, l) => sum + Number(l.data.netAmount), 0);

  // One transaction: a run is either wholly recalculated or left as it was.
  // Half a payroll is worse than none, because it looks finished.
  await prisma.$transaction(async (tx) => {
    await tx.payrollException.deleteMany({ where: { runId: run.id } });
    await tx.payrollLine.deleteMany({ where: { runId: run.id } });

    // Release anything a previous calculation of this run had claimed, then
    // claim what this one used. Without the release, recalculating would strand
    // an adjustment that no longer applies; without the claim, an adjustment
    // would be picked up again by every future run.
    await tx.payrollAdjustment.updateMany({
      where: { appliedRunId: run.id, appliedAt: null },
      data: { appliedRunId: null },
    });
    if (appliedAdjustmentIds.length > 0) {
      await tx.payrollAdjustment.updateMany({
        where: { id: { in: appliedAdjustmentIds }, appliedAt: null },
        data: { appliedRunId: run.id },
      });
    }

    for (const line of lineData) {
      const created = await tx.payrollLine.create({ data: line.data });
      const earnings = earningsByEmployee.get(line.employeeId) ?? [];
      const deductions = deductionsByEmployee.get(line.employeeId) ?? [];

      if (earnings.length > 0) {
        await tx.payrollEarning.createMany({
          data: earnings.map((e) => ({
            lineId: created.id,
            componentId: e.componentId,
            code: e.code,
            label: e.label,
            kind: e.kind,
            calc: e.calc,
            rate: e.rate,
            amount: e.amount,
            isTaxable: e.isTaxable,
          })),
        });
      }

      if (deductions.length > 0) {
        await tx.payrollDeduction.createMany({
          data: deductions.map((d) => ({
            lineId: created.id,
            componentId: d.componentId,
            code: d.code,
            label: d.label,
            kind: d.kind,
            calc: d.calc,
            rate: d.rate,
            units: d.units,
            amount: d.amount,
          })),
        });
      }
    }

    if (pending.length > 0) {
      // Exceptions are attached to the run and the employee, not the line: the
      // blocking ones are precisely the cases where no line exists.
      await tx.payrollException.createMany({
        data: pending.map((e) => ({
          companyId,
          runId: run.id,
          employeeId: e.employeeId,
          code: e.code,
          severity: e.severity,
          message: e.message,
          detail: e.detail,
        })),
      });
    }

    await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: 'REVIEW',
        calculationStartedAt: null,
        calculatedAt: new Date(),
        calculatedBy: actorId,
        currency: company.currency,
        employeeCount: lineData.length,
        grossTotal,
        deductionTotal,
        netTotal,
        exceptionCount: pending.length,
        blockingCount: blocking,
      },
    });
  });

  logger.info(
    {
      event: 'PAYROLL_CALCULATED',
      runId: run.id,
      lines: lineData.length,
      exceptions: pending.length,
      blocking,
    },
    'payroll run calculated',
  );

  return {
    runId: run.id,
    employees: employees.length,
    lines: lineData.length,
    exceptions: pending.length,
    blocking,
    grossTotal,
    netTotal,
  };
}

// ------------------------------------------------------------------ lifecycle

/** Which status may follow which. The only definition of the workflow. */
const TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['CALCULATING', 'CANCELLED'],
  CALCULATING: ['REVIEW', 'DRAFT'],
  REVIEW: ['CALCULATING', 'APPROVED', 'CANCELLED'],
  APPROVED: ['REVIEW', 'FINALIZED', 'CANCELLED'],
  // Terminal. A finalized run is a fact, and a cancelled one is a decision;
  // neither is a state anything moves out of.
  FINALIZED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: string, to: string): void {
  if (canTransition(from, to)) return;
  if (from === 'FINALIZED') {
    throw new ConflictError(
      'This run is finalized. Corrections have to be made with a payroll adjustment.',
    );
  }
  if (from === 'CANCELLED') throw new ConflictError('This run was cancelled.');
  throw new ConflictError(`A run in ${from} cannot move to ${to}.`);
}

/**
 * Finalizes a run.
 *
 * The point of no return, and the only place that enforces it: a run carrying a
 * blocking exception cannot get through, because the whole purpose of detecting
 * one is that somebody looks at it before the money moves.
 */
export async function finalizeRun(input: {
  runId: string;
  companyId: string;
  actorId: string | null;
}): Promise<{ payslips: number }> {
  const { runId, companyId, actorId } = input;

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId },
    include: { lines: { select: { id: true, employeeId: true } } },
  });
  if (!run) throw new NotFoundError('Payroll run');

  assertTransition(run.status, 'FINALIZED');

  if (run.blockingCount > 0) {
    throw new ValidationError({
      run: [
        `This run has ${run.blockingCount} blocking exception(s). Resolve them and recalculate before finalizing.`,
      ],
    });
  }
  if (run.lines.length === 0) {
    throw new ValidationError({ run: ['This run has no lines to finalize.'] });
  }

  const settings = await resolveSettings(companyId);
  const finalizedAt = new Date();

  const payslips = await prisma.$transaction(async (tx) => {
    // Numbered inside the transaction so two finalizations cannot mint the same
    // number, and sequentially so a gap means something was deleted.
    const existing = await tx.payslip.count({ where: { companyId } });
    let next = existing + 1;

    for (const line of run.lines) {
      await tx.payslip.create({
        data: {
          companyId,
          lineId: line.id,
          employeeId: line.employeeId,
          number: `${settings.payslipPrefix}${String(next).padStart(6, '0')}`,
          issuedAt: finalizedAt,
        },
      });
      next += 1;
    }

    await tx.payrollAdjustment.updateMany({
      where: { appliedRunId: runId, appliedAt: null },
      data: { appliedAt: finalizedAt },
    });

    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: 'FINALIZED', finalizedAt, finalizedBy: actorId },
    });

    await tx.payrollPeriod.update({
      where: { id: run.periodId },
      data: { status: 'CLOSED' },
    });

    return run.lines.length;
  });

  logger.info({ event: 'PAYROLL_FINALIZED', runId, payslips }, 'payroll run finalized');
  return { payslips };
}
