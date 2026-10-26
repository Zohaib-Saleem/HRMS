import type { AttendancePolicyScope, WeekDay } from '@prisma/client';
import type { AttendanceFlag } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { clockBoundary, dateColumnToDayKey, type DayKey } from '../../core/zoned-time.js';

/**
 * The company attendance policy, and the arithmetic that depends on it.
 *
 * Every threshold used when classifying a day lives on the Company row. None of
 * the numbers below appear as literals in the calculation - a company that
 * counts a full day as seven hours changes a setting, not this file.
 *
 * The functions here are pure: they take the policy and the times and return
 * the derived values. That makes the same computation reusable by check-out, by
 * the admin upsert, by an approved regularisation and by the absence job
 * without any of them drifting apart.
 */

export interface AttendancePolicy {
  /**
   * The zone the company works to. Attendance is reasoned about in local wall
   * clock time and stored in UTC; without this a "09:00" shift would mean
   * 09:00 UTC, which is only correct for a company sitting on the meridian.
   */
  timeZone: string;
  weekendDays: WeekDay[];
  graceMinutes: number;
  halfDayMinutes: number;
  fullDayMinutes: number;
  earlyLeaveGraceMinutes: number;
  overtimeEnabled: boolean;
  overtimeAfterMinutes: number;
  overtimeDailyCapMinutes: number;
  locationRestrictionEnabled: boolean;
  defaultGeofenceRadiusM: number;
  /** Web check-out must be made inside the office geofence. */
  checkOutLocationEnforced: boolean;
  ipRestrictionEnabled: boolean;
  allowedCheckInCidrs: string[];

  // --- attendance rules ---------------------------------------------------
  /** Fallback window for an employee with no shift assignment. */
  defaultShiftStart: string;
  defaultShiftEnd: string;
  overtimeFromShiftEnd: boolean;
  overtimeCountsEarlyArrival: boolean;
  overtimeReducedByLateArrival: boolean;
  lateTrackingEnabled: boolean;
  earlyDepartureTrackingEnabled: boolean;
  fullDayToleranceMinutes: number;
  irregularCheckInEnabled: boolean;
  irregularCheckInCutoff: string;
  breakIncludedInWindow: boolean;
  overtimeMinimumMinutes: number;
  overtimeRoundingMinutes: number;
  overtimeWeeklyCapMinutes: number | null;
  overtimeMonthlyCapMinutes: number | null;
  missingCheckOutStatus: MissingPunchRule;
  missingCheckInStatus: MissingPunchRule;
  irregularCheckInMode: IrregularCutoffMode;
  irregularAfterShiftStartMinutes: number;

  // --- punch integrity ----------------------------------------------------
  /** Punches closer together than this are one event seen twice. Zero: off. */
  duplicatePunchWindowSeconds: number;
  /** The longest first-to-last span still believed. Zero: no bound. */
  maxPlausibleSpanMinutes: number;
  /** Score a day past the bound anyway, restoring the old behaviour. */
  allowImplausibleSpans: boolean;
  /**
   * How long after a day's first punch a later punch can still be read as
   * that day's departure rather than the next day's arrival. Zero: off.
   */
  overnightCheckOutWindowMinutes: number;
  /** Local `HH:MM` after which a punch is an arrival however open yesterday looks. */
  overnightCheckOutCutoff: string;

  // --- attendance module (step 1) -----------------------------------------
  /** Break assumed for the default window when no shift is assigned. */
  defaultBreakMinutes: number;
  /** Recorded lateness at or above this carries the LATE flag. Zero: any. */
  lateThresholdMinutes: number;
  /** Recorded early departure at or above this carries the EARLY_LEAVE flag. */
  earlyLeaveThresholdMinutes: number;
  weekendWorkRule: NonWorkingDayWorkRule;
  holidayWorkRule: NonWorkingDayWorkRule;
}

/** How the irregular-arrival cutoff is expressed. */
export type IrregularCutoffMode = 'ABSOLUTE_TIME' | 'AFTER_SHIFT_START';

/** What time worked on a weekend or holiday is worth. */
export type NonWorkingDayWorkRule = 'AS_WORKING_DAY' | 'ALL_OVERTIME' | 'IGNORE';

/** What a day with a punch missing on one end is worth. */
export type MissingPunchRule = 'PRESENT' | 'ABSENT' | 'THRESHOLD';

/**
 * How much the day's times can be trusted.
 *
 * Reported alongside the figures rather than folded into the status, because
 * "we do not know" is a different answer from "they were absent" and payroll,
 * the screens and the reports all need to tell them apart.
 *
 *   COMPLETE   - an arrival and a departure that make sense together
 *   OPEN       - an arrival and no departure yet; the day is still running
 *   MISSING    - a punch is absent on one end and the day is over
 *   IMPLAUSIBLE- the span between the punches is longer than the company
 *                believes a day can be, so no hours are derived from it
 *   NONE       - nothing was recorded at all
 */
export type AttendanceIntegrity = 'COMPLETE' | 'OPEN' | 'MISSING' | 'IMPLAUSIBLE' | 'NONE';

/**
 * Whether a first-to-last span is long enough to disbelieve.
 *
 * The bound is configuration, never a constant: a company running twelve-hour
 * shifts and one running seven-hour shifts do not agree on what "too long"
 * means, and neither of them should have to change this code to say so.
 */
export function isImplausibleSpan(
  spanMinutes: number | null,
  policy: Pick<AttendancePolicy, 'maxPlausibleSpanMinutes' | 'allowImplausibleSpans'>,
): boolean {
  if (spanMinutes === null) return false;
  if (policy.allowImplausibleSpans) return false;
  if (policy.maxPlausibleSpanMinutes <= 0) return false;
  return spanMinutes > policy.maxPlausibleSpanMinutes;
}

const POLICY_SELECT = {
  timezone: true,
  weekendDays: true,
  graceMinutes: true,
  halfDayMinutes: true,
  fullDayMinutes: true,
  earlyLeaveGraceMinutes: true,
  overtimeEnabled: true,
  overtimeAfterMinutes: true,
  overtimeDailyCapMinutes: true,
  locationRestrictionEnabled: true,
  defaultGeofenceRadiusM: true,
  checkOutLocationEnforced: true,
  ipRestrictionEnabled: true,
  allowedCheckInCidrs: true,
  defaultShiftStart: true,
  defaultShiftEnd: true,
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: true,
  overtimeReducedByLateArrival: true,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  fullDayToleranceMinutes: true,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: true,
  breakIncludedInWindow: true,
  overtimeMinimumMinutes: true,
  overtimeRoundingMinutes: true,
  overtimeWeeklyCapMinutes: true,
  overtimeMonthlyCapMinutes: true,
  missingCheckOutStatus: true,
  missingCheckInStatus: true,
  irregularCheckInMode: true,
  irregularAfterShiftStartMinutes: true,
  defaultBreakMinutes: true,
  lateThresholdMinutes: true,
  earlyLeaveThresholdMinutes: true,
  weekendWorkRule: true,
  holidayWorkRule: true,
  duplicatePunchWindowSeconds: true,
  maxPlausibleSpanMinutes: true,
  allowImplausibleSpans: true,
  overnightCheckOutWindowMinutes: true,
  overnightCheckOutCutoff: true,
} as const;

/**
 * Reads the company baseline. Deliberately not cached: a policy change made in
 * settings has to affect the very next check-out, not the next restart.
 *
 * Weekend days and the check-in restrictions live only at this level. They
 * describe the company, not a person, so they are never overridden per team.
 */
export async function resolveAttendancePolicy(companyId: string): Promise<AttendancePolicy> {
  const { timezone, ...rest } = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: POLICY_SELECT,
  });
  return { ...rest, timeZone: timezone };
}

/** The thresholds an override can replace. Everything else stays company-wide. */
const OVERRIDABLE = [
  'graceMinutes',
  'halfDayMinutes',
  'fullDayMinutes',
  'earlyLeaveGraceMinutes',
  'overtimeEnabled',
  'overtimeAfterMinutes',
  'overtimeDailyCapMinutes',
  'defaultShiftStart',
  'defaultShiftEnd',
  'overtimeFromShiftEnd',
  'overtimeCountsEarlyArrival',
  'overtimeReducedByLateArrival',
  'fullDayToleranceMinutes',
  'overtimeMinimumMinutes',
  'overtimeRoundingMinutes',
  'overtimeWeeklyCapMinutes',
  'overtimeMonthlyCapMinutes',
  'breakIncludedInWindow',
  'irregularCheckInEnabled',
  'irregularCheckInCutoff',
  'irregularCheckInMode',
  'irregularAfterShiftStartMinutes',
  'lateTrackingEnabled',
  'earlyDepartureTrackingEnabled',
  'duplicatePunchWindowSeconds',
  'maxPlausibleSpanMinutes',
  'allowImplausibleSpans',
] as const;

/** Most specific wins. Two assignments at the same level are broken by date. */
const SCOPE_PRECEDENCE: Record<AttendancePolicyScope, number> = {
  EMPLOYEE: 4,
  TEAM: 3,
  DEPARTMENT: 2,
  COMPANY: 1,
};

export interface ResolvedPolicy extends AttendancePolicy {
  /** Null when the company baseline applied and no override matched. */
  policyId: string | null;
  policyName: string | null;
  scope: AttendancePolicyScope | null;
}

/**
 * The policy in force for one employee on one date.
 *
 * Two things make this more than a lookup:
 *
 *   - Specificity. An employee override beats a team one, which beats a
 *     department one, which beats a company-wide override; anything unmatched
 *     falls through to the Company row, so a company with no policies at all
 *     behaves exactly as it did before policies existed.
 *   - Effective dates. Rescoring a day in March has to use the policy that was
 *     in force in March. Passing the attendance date rather than "now" is what
 *     stops an approved correction from silently regrading history against
 *     today's rules.
 */
export async function resolvePolicyFor(
  companyId: string,
  employeeId: string,
  date: Date,
): Promise<ResolvedPolicy> {
  const [baseline, employee] = await Promise.all([
    resolveAttendancePolicy(companyId),
    prisma.employee.findUnique({
      where: { id: employeeId },
      select: { departmentId: true, teamId: true },
    }),
  ]);

  const unscoped: ResolvedPolicy = { ...baseline, policyId: null, policyName: null, scope: null };
  if (!employee) return unscoped;

  const targets: Array<{ scope: AttendancePolicyScope; targetId: string | null }> = [
    { scope: 'EMPLOYEE', targetId: employeeId },
    { scope: 'TEAM', targetId: employee.teamId },
    { scope: 'DEPARTMENT', targetId: employee.departmentId },
    { scope: 'COMPANY', targetId: null },
  ].filter((t) => t.scope === 'COMPANY' || t.targetId !== null) as Array<{
    scope: AttendancePolicyScope;
    targetId: string | null;
  }>;

  const candidates = await prisma.attendancePolicyAssignment.findMany({
    where: {
      companyId,
      policy: { isActive: true },
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      AND: [{ OR: targets.map((t) => ({ scope: t.scope, targetId: t.targetId })) }],
    },
    include: { policy: true },
  });

  if (candidates.length === 0) return unscoped;

  const winner = candidates.reduce((best, current) => {
    const byScope = SCOPE_PRECEDENCE[current.scope] - SCOPE_PRECEDENCE[best.scope];
    if (byScope !== 0) return byScope > 0 ? current : best;
    // Same level: the one that started later is the newer decision.
    return current.effectiveFrom > best.effectiveFrom ? current : best;
  });

  // Null means "inherit". An override that had to restate every rule would
  // drift from the baseline the moment the baseline changed, so only the
  // fields it actually sets are merged over.
  const overrides = Object.fromEntries(
    OVERRIDABLE.map((key) => [key, winner.policy[key]]).filter(([, value]) => value !== null),
  ) as Partial<Pick<AttendancePolicy, (typeof OVERRIDABLE)[number]>>;

  return {
    ...baseline,
    ...overrides,
    policyId: winner.policy.id,
    policyName: winner.policy.name,
    scope: winner.scope,
  };
}

/**
 * The same resolution as `resolvePolicyFor`, for many employees over a range.
 *
 * Derivation needs the policy in force for every employee on every day of a
 * month. Calling the single-employee resolver in that loop is two queries per
 * person per day; this reads the candidates once and answers from memory.
 *
 * The answer is per DAY, not per range, because an override can start midway
 * through a month and a report that spans the change has to show each half
 * under the rules that actually applied to it.
 */
export async function policyResolverFor(
  companyId: string,
  employeeIds: readonly string[],
  from: Date,
  to: Date,
): Promise<(employeeId: string, date: Date) => ResolvedPolicy> {
  const [baseline, employees, candidates] = await Promise.all([
    resolveAttendancePolicy(companyId),
    prisma.employee.findMany({
      where: { id: { in: [...employeeIds] } },
      select: { id: true, departmentId: true, teamId: true },
    }),
    prisma.attendancePolicyAssignment.findMany({
      where: {
        companyId,
        policy: { isActive: true },
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      include: { policy: true },
    }),
  ]);

  const unscoped: ResolvedPolicy = { ...baseline, policyId: null, policyName: null, scope: null };
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  /** Merging is not free and a month asks for the same answer thirty times. */
  const cache = new Map<string, ResolvedPolicy>();

  return (employeeId: string, date: Date): ResolvedPolicy => {
    const employee = employeeById.get(employeeId);
    if (!employee) return unscoped;

    const dayKey = date.toISOString().slice(0, 10);
    const cacheKey = `${employeeId}:${dayKey}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const applicable = candidates.filter((candidate) => {
      if (candidate.effectiveFrom > date) return false;
      if (candidate.effectiveTo !== null && candidate.effectiveTo < date) return false;
      switch (candidate.scope) {
        case 'EMPLOYEE':
          return candidate.targetId === employeeId;
        case 'TEAM':
          return employee.teamId !== null && candidate.targetId === employee.teamId;
        case 'DEPARTMENT':
          return employee.departmentId !== null && candidate.targetId === employee.departmentId;
        default:
          return candidate.targetId === null;
      }
    });

    if (applicable.length === 0) {
      cache.set(cacheKey, unscoped);
      return unscoped;
    }

    const winner = applicable.reduce((best, current) => {
      const byScope = SCOPE_PRECEDENCE[current.scope] - SCOPE_PRECEDENCE[best.scope];
      if (byScope !== 0) return byScope > 0 ? current : best;
      return current.effectiveFrom > best.effectiveFrom ? current : best;
    });

    const overrides = Object.fromEntries(
      OVERRIDABLE.map((key) => [key, winner.policy[key]]).filter(([, value]) => value !== null),
    ) as Partial<Pick<AttendancePolicy, (typeof OVERRIDABLE)[number]>>;

    const resolved: ResolvedPolicy = {
      ...baseline,
      ...overrides,
      policyId: winner.policy.id,
      policyName: winner.policy.name,
      scope: winner.scope,
    };
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

const WEEKDAY_BY_INDEX: readonly WeekDay[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

/**
 * Whether a date is a non-working day for this company.
 *
 * Lives here rather than in either calling module so attendance and leave read
 * the same answer from the same configuration. Nothing anywhere may assume
 * Saturday and Sunday - that pair is only the default value of a column.
 */
export function isWeekendFor(date: Date, weekendDays: readonly WeekDay[]): boolean {
  const day = WEEKDAY_BY_INDEX[date.getUTCDay()];
  return day !== undefined && weekendDays.includes(day);
}

/** The configured weekend for a company, read fresh. */
export async function weekendDaysFor(companyId: string): Promise<WeekDay[]> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { weekendDays: true },
  });
  return company.weekendDays;
}

/**
 * The rules a shift may override. Null inherits the company value, so a
 * shift states only what is different about it and follows the baseline for
 * everything else - exactly how the scoped policies already behave.
 */
export interface ShiftRules {
  graceMinutes?: number | null;
  earlyLeaveGraceMinutes?: number | null;
  lateTrackingEnabled?: boolean | null;
  earlyDepartureTrackingEnabled?: boolean | null;
  overtimeEnabled?: boolean | null;
  overtimeDailyCapMinutes?: number | null;
  overtimeMinimumMinutes?: number | null;
}

export interface ShiftWindow extends ShiftRules {
  startTime: string;
  endTime: string;
  /** Only read when the company says the break sits outside the window. */
  breakMinutes?: number;
  /** Rostered minutes. Null derives it from the window and the break. */
  expectedMinutes?: number | null;
  /** Empty means the company's working days. */
  workingDays?: readonly WeekDay[];
}

const SHIFT_RULE_KEYS = [
  'graceMinutes',
  'earlyLeaveGraceMinutes',
  'lateTrackingEnabled',
  'earlyDepartureTrackingEnabled',
  'overtimeEnabled',
  'overtimeDailyCapMinutes',
  'overtimeMinimumMinutes',
] as const;

export type ShiftRuleKey = (typeof SHIFT_RULE_KEYS)[number];

/**
 * The policy with the shift's own rules laid over it.
 *
 * The single merge point. Everything below that reads a grace period, a cap
 * or a tracking switch reads the merged policy, so a shift with a twenty
 * minute grace changes lateness, flags and overtime in step and nothing can
 * read the company value by mistake.
 */
export function withShiftRules<P extends AttendancePolicy>(
  policy: P,
  shift: ShiftRules | null | undefined,
): P & { shiftRuleKeys: ShiftRuleKey[] } {
  const merged = { ...policy, shiftRuleKeys: [] as ShiftRuleKey[] };
  if (!shift) return merged;
  for (const key of SHIFT_RULE_KEYS) {
    const value = shift[key];
    if (value === null || value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
    merged.shiftRuleKeys.push(key);
  }
  return merged;
}

/**
 * The rostered length of a day, in minutes.
 *
 * The shift's own figure when it has one; otherwise the window, less the
 * break when the company says the break sits outside it. An overnight window
 * wraps past midnight rather than going negative.
 */
export function expectedMinutesFor(
  shift: ShiftWindow,
  policy: Pick<AttendancePolicy, 'breakIncludedInWindow'>,
): number {
  if (shift.expectedMinutes !== null && shift.expectedMinutes !== undefined) {
    return Math.max(0, shift.expectedMinutes);
  }
  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  if (start === null || end === null) return 0;
  const window = end > start ? end - start : 24 * 60 - start + end;
  const deduction = policy.breakIncludedInWindow ? 0 : Math.max(0, shift.breakMinutes ?? 0);
  return Math.max(0, window - deduction);
}

/**
 * Whether a date is a working day for a shift.
 *
 * A shift with no working days listed follows the company: every day that is
 * not a configured weekend day. A shift with a list works exactly those days,
 * whatever the company weekend says - which is how a Sunday-to-Thursday team
 * lives inside a Monday-to-Friday company.
 */
export function isShiftWorkingDay(
  date: Date,
  shift: Pick<ShiftWindow, 'workingDays'> | null,
  weekendDays: readonly WeekDay[],
): boolean {
  const day = WEEKDAY_BY_INDEX[date.getUTCDay()];
  if (day === undefined) return true;
  if (shift?.workingDays && shift.workingDays.length > 0) return shift.workingDays.includes(day);
  return !weekendDays.includes(day);
}

/** Minutes since midnight for an "HH:mm" string, or null if unparseable. */
function minutesOfDay(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * The instant a shift boundary falls on a given attendance day.
 *
 * Anchored on the attendance day and the company zone, not on the UTC calendar
 * day of the timestamp. Those are the same thing only for a company on UTC; for
 * one in Asia/Karachi a 20:00 local punch is already tomorrow in UTC, and
 * measuring it against tomorrow's shift start would be an entire day out.
 */
function boundaryOn(dayKey: DayKey, hhmm: string, timeZone: string): Date | null {
  return clockBoundary(dayKey, hhmm, timeZone);
}

/**
 * Minutes late against the shift start, with the configured grace applied.
 *
 * Grace decides *whether* someone is late, not how late. Once past the
 * threshold the full lateness is reported, which is the convention payroll
 * expects - a five minute grace should not quietly shave five minutes off an
 * hour of lateness.
 *
 * Returns null when no shift applies, so "no shift assigned" stays
 * distinguishable from "on time".
 */
export function lateMinutesFor(
  checkInAt: Date,
  shift: ShiftWindow | null,
  policy: Pick<AttendancePolicy, 'graceMinutes' | 'timeZone'>,
  dayKey: DayKey,
): number | null {
  if (!shift) return null;
  const expected = boundaryOn(dayKey, shift.startTime, policy.timeZone);
  if (!expected) return null;

  const raw = Math.round((checkInAt.getTime() - expected.getTime()) / 60_000);
  if (raw <= 0) return 0;
  return raw <= policy.graceMinutes ? 0 : raw;
}

/**
 * Minutes left early against the shift end, with the configured grace applied.
 *
 * Overnight shifts (end at or before start) are not evaluated: the end falls on
 * the next calendar day and guessing which one would produce a confidently
 * wrong number. Returns null rather than pretending.
 */
export function earlyLeaveMinutesFor(
  checkOutAt: Date,
  shift: ShiftWindow | null,
  policy: Pick<AttendancePolicy, 'earlyLeaveGraceMinutes' | 'timeZone'>,
  dayKey: DayKey,
): number | null {
  if (!shift) return null;

  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  if (start === null || end === null || end <= start) return null;

  const expected = boundaryOn(dayKey, shift.endTime, policy.timeZone);
  if (!expected) return null;

  const raw = Math.round((expected.getTime() - checkOutAt.getTime()) / 60_000);
  if (raw <= 0) return 0;
  return raw <= policy.earlyLeaveGraceMinutes ? 0 : raw;
}

/**
 * The portion of worked time that counts as overtime.
 *
 * Overtime is a label on part of `workedMinutes`, never time added to it, so
 * the two can appear in the same report without double-counting. Capped daily
 * so a forgotten check-out cannot book fourteen hours of overtime.
 */
export function overtimeMinutesFor(
  workedMinutes: number | null,
  policy: Pick<
    AttendancePolicy,
    'overtimeEnabled' | 'overtimeAfterMinutes' | 'overtimeDailyCapMinutes'
  >,
): number | null {
  if (workedMinutes === null) return null;
  if (!policy.overtimeEnabled) return 0;

  const over = workedMinutes - policy.overtimeAfterMinutes;
  if (over <= 0) return 0;
  return Math.min(over, policy.overtimeDailyCapMinutes);
}

/**
 * The shift a day is measured against.
 *
 * Priority, most specific first:
 *   1. the employee's shift assignment for that date, passed in by the caller
 *   2. the company's default window
 *
 * Nothing below ever reads a clock time that is not one of these two, which is
 * what keeps 09:00 and 18:00 out of the arithmetic.
 */
export function effectiveShift(
  assigned: ShiftWindow | null,
  policy: Pick<AttendancePolicy, 'defaultShiftStart' | 'defaultShiftEnd' | 'defaultBreakMinutes'>,
): ShiftWindow {
  return (
    assigned ?? {
      startTime: policy.defaultShiftStart,
      endTime: policy.defaultShiftEnd,
      breakMinutes: policy.defaultBreakMinutes,
    }
  );
}

/**
 * The instant from which a departure is the only sensible reading of a punch.
 *
 * The scheduled end of the employee's own day, resolved through the same
 * `effectiveShift` every other figure uses: their shift assignment when they
 * have one, the company's default window when they do not. A company on
 * 09:00-18:00 and an employee rostered 10:00-19:00 therefore get different
 * boundaries, from one shift calculation rather than two.
 *
 * Null means "no boundary can be established", and every caller must read that
 * as "do not apply the rule" rather than as midnight:
 *
 *   - an unparseable window, and
 *   - an overnight window, whose end falls on the following calendar day.
 *     `scheduledMinutesCovered` already declines to measure those against a
 *     single day, and disagreeing with it here would be a second opinion about
 *     the same shift.
 *
 * This is deliberately the shift end and NOT the overtime threshold. Somebody
 * leaving ten minutes after their shift ends is going home, whether or not the
 * company credits the ten minutes - and reading the overtime boundary here
 * would make a payroll setting decide whether a departure was recorded at all.
 */
export function checkOutBoundaryOn(input: {
  shift: ShiftWindow | null;
  policy: Pick<
    AttendancePolicy,
    'defaultShiftStart' | 'defaultShiftEnd' | 'defaultBreakMinutes' | 'timeZone'
  >;
  dayKey: DayKey;
}): Date | null {
  const { shift, policy, dayKey } = input;
  const window = effectiveShift(shift, policy);

  const start = minutesOfDay(window.startTime);
  const end = minutesOfDay(window.endTime);
  if (start === null || end === null || end <= start) return null;

  return boundaryOn(dayKey, window.endTime, policy.timeZone);
}

/**
 * Whether the day started too late to be the shift it would be scored against.
 *
 * A 14:00 check-in measured against a shift ending at 18:00 is not three hours
 * of overtime, it is a day that does not fit the shift. Flagging it keeps the
 * record visible without inventing a figure for it, and the overtime below
 * returns null rather than zero so "not applicable" stays distinguishable from
 * "none earned".
 */
export function isIrregularArrival(
  checkInAt: Date | null,
  policy: Pick<
    AttendancePolicy,
    | 'irregularCheckInEnabled'
    | 'irregularCheckInCutoff'
    | 'irregularCheckInMode'
    | 'irregularAfterShiftStartMinutes'
    | 'timeZone'
  >,
  dayKey: DayKey,
  shift: ShiftWindow | null = null,
): boolean {
  if (!policy.irregularCheckInEnabled || !checkInAt) return false;

  // Measured from the employee's own shift start when configured that way.
  // An absolute cutoff only makes sense while everyone shares one schedule: it
  // would mark every night-shift worker irregular, every day.
  if (policy.irregularCheckInMode === 'AFTER_SHIFT_START' && shift) {
    const start = boundaryOn(dayKey, shift.startTime, policy.timeZone);
    if (!start) return false;
    const after = Math.round((checkInAt.getTime() - start.getTime()) / 60_000);
    return after > policy.irregularAfterShiftStartMinutes;
  }

  const cutoff = boundaryOn(dayKey, policy.irregularCheckInCutoff, policy.timeZone);
  return cutoff !== null && checkInAt > cutoff;
}

/**
 * How much of the scheduled day the employee actually covered.
 *
 * This is what full and half day are measured against, and it is deliberately
 * NOT the elapsed time between the punches. Elapsed time answers "how long were
 * they here?"; a day's worth answers "did they work the day they were rostered
 * for?", and for anyone who arrives late those two disagree.
 *
 * Counted from the shift start rather than from the arrival, so lateness does
 * not also shorten the day: someone who starts at 09:15 and leaves at 18:00 has
 * worked the day, and is fifteen minutes late. Both facts are recorded, and
 * neither is charged twice.
 *
 * Capped at the shift end, so staying late does not inflate the day either -
 * time past the end is overtime, counted once, over there.
 *
 * Returns null when the window cannot be established (an unparseable or
 * overnight shift), leaving the caller to fall back to elapsed time rather than
 * guess.
 */
export function scheduledMinutesCovered(input: {
  checkOutAt: Date | null;
  shift: ShiftWindow;
  timeZone: string;
  dayKey: DayKey;
}): number | null {
  const { checkOutAt, shift, timeZone, dayKey } = input;
  if (!checkOutAt) return null;

  const startOfDay = minutesOfDay(shift.startTime);
  const endOfDay = minutesOfDay(shift.endTime);
  // An overnight shift ends on the following calendar day; measuring it against
  // this one would be confidently wrong. Fall back instead.
  if (startOfDay === null || endOfDay === null || endOfDay <= startOfDay) return null;

  const start = boundaryOn(dayKey, shift.startTime, timeZone);
  const end = boundaryOn(dayKey, shift.endTime, timeZone);
  if (!start || !end) return null;

  const leftAt = checkOutAt < end ? checkOutAt : end;
  return Math.max(0, Math.round((leftAt.getTime() - start.getTime()) / 60_000));
}

/**
 * Overtime earned after the applicable shift end.
 *
 * The break is deliberately not subtracted anywhere: it sits inside the shift
 * window, so the window already accounts for it. Subtracting it as well would
 * charge it twice - once as unpaid time and once as overtime the employee never
 * worked, which is how every ordinary day came to book an hour.
 *
 * Returns null when no figure can honestly be produced: an open day, or one
 * that does not fit its shift.
 */
export function overtimeAfterShiftEnd(input: {
  checkInAt: Date | null;
  checkOutAt: Date | null;
  shift: ShiftWindow;
  policy: Pick<
    AttendancePolicy,
    | 'overtimeEnabled'
    | 'overtimeDailyCapMinutes'
    | 'overtimeCountsEarlyArrival'
    | 'overtimeReducedByLateArrival'
    | 'overtimeMinimumMinutes'
    | 'overtimeRoundingMinutes'
    | 'graceMinutes'
    | 'timeZone'
  >;
  dayKey: DayKey;
  irregular: boolean;
}): number | null {
  const { checkInAt, checkOutAt, shift, policy, dayKey, irregular } = input;

  if (!policy.overtimeEnabled) return 0;
  // No departure, no measurable overtime - the day is still open.
  if (!checkOutAt) return null;
  if (irregular) return null;

  const end = boundaryOn(dayKey, shift.endTime, policy.timeZone);
  if (!end) return null;

  let minutes = Math.round((checkOutAt.getTime() - end.getTime()) / 60_000);
  if (minutes < 0) minutes = 0;

  if (policy.overtimeCountsEarlyArrival && checkInAt) {
    const start = boundaryOn(dayKey, shift.startTime, policy.timeZone);
    if (start) {
      const early = Math.round((start.getTime() - checkInAt.getTime()) / 60_000);
      if (early > 0) minutes += early;
    }
  }

  if (policy.overtimeReducedByLateArrival && checkInAt) {
    const late = lateMinutesFor(checkInAt, shift, policy, dayKey);
    if (late !== null) minutes -= late;
  }

  if (minutes <= 0) return 0;

  // Below the configured minimum, nothing is credited: a two-minute overrun
  // should not become a payable figure. Zero credits every minute.
  if (minutes < policy.overtimeMinimumMinutes) return 0;

  // Rounded DOWN to the configured step, so rounding can never manufacture
  // time nobody worked. Zero is no rounding.
  if (policy.overtimeRoundingMinutes > 0) {
    minutes = Math.floor(minutes / policy.overtimeRoundingMinutes) * policy.overtimeRoundingMinutes;
  }

  return Math.min(minutes, policy.overtimeDailyCapMinutes);
}

export interface AttendanceComputation {
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  /** What the policy says the day is worth, before calendar overrides. */
  status: 'PRESENT' | 'HALF_DAY' | 'ABSENT';
  /**
   * The day started too late to belong to the shift it would be measured
   * against, so no overtime was derived from it. Reported rather than stored:
   * it is a property of the punches and the rules, both of which can change.
   */
  irregular: boolean;
  /**
   * Minutes of the scheduled shift the day actually covered, which is what
   * decided the status. Null when it could not be established and elapsed time
   * was used instead - an irregular day, an overnight shift, or an open day.
   */
  scheduledMinutes: number | null;
  /** The rostered length of the day the record was measured against. */
  expectedMinutes: number;
  /**
   * The break the policy took OFF the day, in minutes.
   *
   * Not a new figure - it is the deduction this function has always applied on
   * the line below, reported instead of being thrown away, so a screen can say
   * what came off the span without subtracting anything of its own. Zero when
   * `breakIncludedInWindow` is true, which is the default: the shift window
   * already accounts for the break and nothing is deducted.
   */
  breakMinutes: number;
  /**
   * How much the day's own times can be trusted. IMPLAUSIBLE is the one that
   * suppresses figures: the day is reported with no hours rather than with
   * hours nobody worked.
   */
  integrity: AttendanceIntegrity;
  /** First-to-last elapsed minutes, before the break. Null when unpaired. */
  spanMinutes: number | null;
}

/**
 * The single place a worked day is turned into numbers and a status.
 *
 * Status rules, all driven by the policy:
 *   - no check-in                -> ABSENT
 *   - checked in, not yet out    -> PRESENT (the day is still running; nobody
 *                                  is half a day at 11am)
 *   - worked >= fullDayMinutes   -> PRESENT
 *   - worked >= halfDayMinutes   -> HALF_DAY
 *   - anything less              -> ABSENT
 *
 * The check-in and check-out times stay on the record either way, so a day
 * scored ABSENT for being too short still shows what actually happened.
 */
export function computeAttendance(input: {
  /**
   * The attendance day this record belongs to, in the company zone. Passed in
   * rather than derived from the timestamps, because for an overnight shift the
   * check-out falls on the following calendar day and both still belong to the
   * day the shift started.
   */
  day: DayKey | Date;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  shift: ShiftWindow | null;
  policy: AttendancePolicy;
}): AttendanceComputation {
  const { checkInAt, checkOutAt } = input;
  const dayKey = typeof input.day === 'string' ? input.day : dateColumnToDayKey(input.day);

  // An assigned shift always wins; the company window is only the fallback.
  // Its rule overrides are merged once, here, and everything below reads the
  // merged policy.
  const shift = effectiveShift(input.shift, input.policy);
  const policy = withShiftRules(input.policy, input.shift);
  const irregularArrival = isIrregularArrival(checkInAt, policy, dayKey, shift);

  /**
   * Worked minutes, with the break handled the way the company says it is.
   *
   * `breakIncludedInWindow` true - the default and this company's rule - means
   * the shift window already accounts for the break, so nothing is subtracted:
   * deducting it as well would charge it twice. False means the break sits
   * outside the window and the shift's own break length comes off the day.
   */
  const rawMinutes =
    checkInAt && checkOutAt
      ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000))
      : null;

  /**
   * A span the company does not believe produces no figures at all.
   *
   * This is the difference between reporting a fact and inventing one. A
   * forgotten check-out, a stray evening swipe or a duplicate from a second
   * terminal all present as one enormous day, and there is no honest way to
   * tell which hours inside it were worked. So none are claimed: the times
   * stay on the record, the day is marked irregular, and somebody corrects it.
   *
   * Deliberately NOT a cap. Capping would still assert a number, and the
   * number would still be wrong - it would just be wrong by less.
   */
  const implausible = isImplausibleSpan(rawMinutes, policy);

  const integrity: AttendanceIntegrity = implausible
    ? 'IMPLAUSIBLE'
    : !checkInAt && !checkOutAt
      ? 'NONE'
      : checkInAt && checkOutAt
        ? 'COMPLETE'
        : checkInAt
          ? 'OPEN'
          : 'MISSING';

  const breakMinutes = policy.breakIncludedInWindow ? 0 : Math.max(0, shift.breakMinutes ?? 0);

  const workedMinutes =
    rawMinutes === null || implausible ? null : Math.max(0, rawMinutes - breakMinutes);

  /**
   * A day whose span is disbelieved is irregular by that fact alone, on top of
   * whatever the arrival time said. Both reasons land on the same flag because
   * they have the same consequence: no overtime is derived from the day.
   */
  const irregular = irregularArrival || implausible;

  // The arrival is a real punch and lateness is measured from it alone, so it
  // survives even when the departure is not believed.
  const lateMinutes =
    checkInAt && policy.lateTrackingEnabled
      ? lateMinutesFor(checkInAt, shift, policy, dayKey)
      : null;

  // The departure is the half in doubt, so nothing is derived from it.
  const earlyLeaveMinutes =
    checkOutAt && policy.earlyDepartureTrackingEnabled && !implausible
      ? earlyLeaveMinutesFor(checkOutAt, shift, policy, dayKey)
      : null;

  // Two models, chosen by configuration. The duration model is kept because it
  // is what every existing record was scored with; switching back has to remain
  // possible without a code change.
  const rawOvertime = policy.overtimeFromShiftEnd
    ? overtimeAfterShiftEnd({ checkInAt, checkOutAt, shift, policy, dayKey, irregular })
    : overtimeMinutesFor(workedMinutes, policy);

  /**
   * Overtime can never exceed the worked time it is a label on.
   *
   * Enforced here, once, rather than by each consumer clamping defensively -
   * which is what used to happen, and inconsistently: the chart clamped, the
   * summary beside it did not, and the CSV did not either, so one day could be
   * reported three ways. A guarantee made at the source needs no defending
   * downstream.
   *
   * Reachable when the break is deducted from the day (breakIncludedInWindow
   * false) while early arrival also counts toward overtime: both push the two
   * figures apart, and neither is wrong on its own.
   */
  const overtimeMinutes =
    rawOvertime === null || workedMinutes === null
      ? rawOvertime
      : Math.min(rawOvertime, workedMinutes);

  /**
   * What the day is worth, measured against the shift rather than the clock.
   *
   * An irregular day is scored on elapsed time instead: it does not fit the
   * shift it would otherwise be credited against, and crediting a 14:00 start
   * with a full 09:00 day is exactly the fabrication the irregular rule exists
   * to prevent.
   *
   * The thresholds themselves are unchanged - the same fullDayMinutes and
   * halfDayMinutes as before. Only what is compared against them has changed.
   */
  const scheduledMinutes = irregular
    ? null
    : scheduledMinutesCovered({ checkOutAt, shift, timeZone: policy.timeZone, dayKey });


  const dayWorth = scheduledMinutes ?? workedMinutes;

  /**
   * How far short of a full day still counts as one.
   *
   * Applied only to the scheduled measure. An irregular or overnight day falls
   * back to elapsed time, and stretching elapsed time by a tolerance meant for
   * a shift would credit a day nobody scheduled.
   *
   * Never below the half-day threshold: a tolerance wide enough to swallow it
   * would silently retire half days altogether.
   */
  const tolerance = scheduledMinutes === null ? 0 : Math.max(0, policy.fullDayToleranceMinutes);
  const fullDayFrom = Math.max(policy.halfDayMinutes, policy.fullDayMinutes - tolerance);

  /**
   * A day scored on its thresholds. Used directly, and as the THRESHOLD answer
   * for a day with a punch missing on one end.
   */
  const byThreshold = (worth: number | null): AttendanceComputation['status'] => {
    if (worth === null) return 'ABSENT';
    if (worth >= fullDayFrom) return 'PRESENT';
    if (worth >= policy.halfDayMinutes) return 'HALF_DAY';
    return 'ABSENT';
  };

  /** What a missing punch is worth, per configuration rather than per opinion. */
  const missing = (
    rule: MissingPunchRule,
    worth: number | null,
  ): AttendanceComputation['status'] =>
    rule === 'THRESHOLD' ? byThreshold(worth) : rule;

  let status: AttendanceComputation['status'];
  if (!checkInAt && !checkOutAt) status = missing(policy.missingCheckInStatus, null);
  else if (!checkInAt) status = missing(policy.missingCheckInStatus, dayWorth);
  // A disbelieved departure is, for scoring purposes, a departure nobody
  // recorded - so it follows the company's own missing-check-out rule rather
  // than a second policy invented here.
  else if (!checkOutAt || implausible) status = missing(policy.missingCheckOutStatus, dayWorth);
  else status = byThreshold(dayWorth);

  return {
    workedMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeMinutes,
    status,
    irregular,
    scheduledMinutes,
    expectedMinutes: expectedMinutesFor(shift, policy),
    breakMinutes,
    integrity,
    spanMinutes: rawMinutes,
  };
}

/**
 * What else was true about a day.
 *
 * Flags are derived, never stored: they are a reading of the figures under
 * the thresholds in force, and a threshold can change. A late day is still
 * PRESENT - the status says whether the day was worked, the flag says it was
 * late. Nothing here downgrades a status.
 */
export function attendanceFlags(
  day: {
    status: string;
    checkInAt: Date | string | null;
    checkOutAt: Date | string | null;
    lateMinutes: number | null;
    earlyLeaveMinutes: number | null;
    overtimeMinutes: number | null;
    irregular: boolean;
    source: string | null;
    hasRecord: boolean;
  },
  policy: Pick<AttendancePolicy, 'lateThresholdMinutes' | 'earlyLeaveThresholdMinutes'>,
): AttendanceFlag[] {
  const flags: AttendanceFlag[] = [];
  if (!day.hasRecord) return flags;

  const late = day.lateMinutes ?? 0;
  if (late > 0 && late >= policy.lateThresholdMinutes) flags.push('LATE');

  const early = day.earlyLeaveMinutes ?? 0;
  if (early > 0 && early >= policy.earlyLeaveThresholdMinutes) flags.push('EARLY_LEAVE');

  if ((day.overtimeMinutes ?? 0) > 0) flags.push('OVERTIME');

  // One punch without the other. A day with neither is absence, not a
  // missing punch - there is nothing to pair.
  const hasIn = day.checkInAt !== null;
  const hasOut = day.checkOutAt !== null;
  if (hasIn !== hasOut && (day.status === 'PRESENT' || day.status === 'HALF_DAY')) {
    flags.push('MISSING_PUNCH');
  }

  if (day.irregular) flags.push('IRREGULAR');
  if (day.source === 'ADMIN') flags.push('MANUAL');
  return flags;
}

/**
 * Overtime on a weekend or holiday, per the configured rule.
 *
 * Applied at derivation rather than at write time, so the day keeps the
 * figures the engine stored and a company can change its mind without a
 * recalculation. AS_WORKING_DAY - the default - returns the stored figure,
 * which is what every existing day already reported.
 */
export function nonWorkingDayOvertime(
  rule: NonWorkingDayWorkRule,
  stored: { workedMinutes: number | null; overtimeMinutes: number | null },
  policy: Pick<AttendancePolicy, 'overtimeEnabled' | 'overtimeDailyCapMinutes'>,
): number | null {
  switch (rule) {
    case 'IGNORE':
      return 0;
    case 'ALL_OVERTIME': {
      if (!policy.overtimeEnabled) return 0;
      if (stored.workedMinutes === null) return null;
      return Math.min(stored.workedMinutes, policy.overtimeDailyCapMinutes);
    }
    default:
      return stored.overtimeMinutes;
  }
}

// -------------------------------------------------------- network matching

/** Dotted-quad to a 32-bit number, or null if it is not an IPv4 address. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Whether an address falls inside an allow-list entry.
 *
 * Accepts a bare address or CIDR notation. IPv6 is compared literally rather
 * than by prefix: half-implemented IPv6 masking would be a security control
 * that quietly does the wrong thing, which is worse than one that only handles
 * what it claims.
 *
 * IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) are unwrapped first, because
 * that is how a dual-stack Node server reports an ordinary IPv4 client.
 */
export function ipMatches(address: string, entry: string): boolean {
  const ip = address.trim().replace(/^::ffff:/i, '');
  const rule = entry.trim();
  if (rule === '') return false;

  if (!rule.includes('/')) return ip.toLowerCase() === rule.toLowerCase();

  const [network, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  if (network === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null) return false;

  // A /0 shifts by 32, which is a no-op in JS - handle it explicitly.
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/** True when the address is permitted by any entry in the allow-list. */
export function isIpAllowed(address: string | null, allowList: readonly string[]): boolean {
  if (!address) return false;
  return allowList.some((entry) => ipMatches(address, entry));
}

// --------------------------------------------------------------- geofencing

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. Accurate enough for a site geofence. */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}
