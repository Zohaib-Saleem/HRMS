import type { AttendanceSource, WeekDay } from '@prisma/client';
import type {
  AttendanceFlag,
  AttendanceMonthlyTotals,
  AttendanceTotals,
  DerivedAttendanceStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import { toDateOnly } from '../leave/leave.service.js';
import { todayInZone } from '../../core/zoned-time.js';
import { reconcileAfterAttendanceWrite } from '../leave/leave-reconciliation.service.js';
import {
  EMPLOYMENT_WINDOW_SELECT,
  isEmployeeInAttendancePopulation,
  type EmploymentWindowFields,
} from './employment-window.js';
import {
  attendanceFlags,
  computeAttendance,
  effectiveShift,
  expectedMinutesFor,
  haversineMeters,
  isIpAllowed,
  isShiftWorkingDay,
  isWeekendFor,
  nonWorkingDayOvertime,
  policyResolverFor,
  resolveAttendancePolicy,
  resolvePolicyFor,
  type AttendanceIntegrity,
  type AttendancePolicy,
  type ShiftWindow,
} from './attendance-policy.js';

export { isWeekendFor } from './attendance-policy.js';

/**
 * Daily attendance derivation.
 *
 * A day's status is not a free-text field someone types - it is decided by
 * these inputs, in this order of precedence:
 *
 *   1. weekend / off day - from the company's weekendDays, or the working days
 *                          of the shift in force when the shift lists any
 *   2. holiday            - from the employee's location calendar plus company-wide days
 *   3. on leave           - from approved leave covering the date, less any
 *                          day reconciliation gave back because it was worked
 *   4. the stored record, or ABSENT when there is none
 *
 * Weekend and holiday win over leave deliberately: booking leave across a
 * public holiday should not report the holiday as a day of leave, and the
 * working-day count in Phase 4 already excluded it from the balance.
 *
 * Flags are computed here from the stored figures and the rules in force, so
 * a late day is reported PRESENT with a LATE flag rather than having its
 * status replaced.
 */

export interface DerivedDay {
  date: string;
  status: DerivedAttendanceStatus;
  flags: AttendanceFlag[];
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  /** Rostered minutes on a working day; null on a day nobody was rostered for. */
  expectedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  /**
   * The break the policy deducted from the day, as the engine computed it.
   *
   * Reported, never re-derived: it is `computeAttendance`'s own deduction, so a
   * screen showing "break" and a screen showing "worked" are quoting the same
   * arithmetic. Null for a day the engine did not score - no record, or a
   * record an administrator corrected by hand, whose figures are a human
   * decision rather than a deduction anybody can restate.
   */
  breakMinutes?: number | null;
  irregular: boolean;
  /**
   * How far the day's own times can be trusted. Carried so a caller can tell
   * "no hours because the punches do not add up" from "no hours because
   * nobody came", which the status alone cannot express.
   */
  integrity: AttendanceIntegrity;
  mode: string | null;
  shiftId: string | null;
  shiftName: string | null;
  notes: string | null;
  /** Set when the day is covered by approved leave. */
  leaveTypeName: string | null;
  /**
   * Whether that leave is paid.
   *
   * Read by payroll, which must tell a paid absence from an unpaid one and has
   * no business querying the leave tables itself. Null when the day is not
   * leave at all - deliberately not `false`, so "unpaid" and "not leave"
   * cannot be confused by a caller that forgets to check the status.
   */
  leaveIsPaid: boolean | null;
  /**
   * Whether the leave type is one payroll deducts even though it is paid.
   * Read by payroll, which has no business querying the leave tables itself.
   * Null when the day is not leave, for the same reason `leaveIsPaid` is.
   */
  leaveIsDeductible: boolean | null;
  /** FULL_DAY, FIRST_HALF or SECOND_HALF; null when the day is not leave. */
  leaveDayPart: string | null;
  /** Set when the day is a holiday that applies to this employee. */
  holidayName: string | null;
  source: AttendanceSource | null;
  recordId: string | null;
  /** True when a stored record exists; false when the status is inferred. */
  hasRecord: boolean;
}

const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** The shift fields the engine and the screens read. */
export const SHIFT_WINDOW_SELECT = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  breakMinutes: true,
  expectedMinutes: true,
  workingDays: true,
  graceMinutes: true,
  earlyLeaveGraceMinutes: true,
  lateTrackingEnabled: true,
  earlyDepartureTrackingEnabled: true,
  overtimeEnabled: true,
  overtimeDailyCapMinutes: true,
  overtimeMinimumMinutes: true,
} as const;

export interface ResolvedShift extends ShiftWindow {
  id: string;
  name: string;
  breakMinutes: number;
  workingDays: WeekDay[];
}

/**
 * Every shift assignment touching a range, grouped by employee and ordered so
 * the latest-starting assignment comes first - the same tie-break
 * `shiftOnDate` uses, so a range and a single day can never disagree.
 */
export async function shiftAssignmentsForRange(
  employeeIds: readonly string[],
  from: Date,
  to: Date,
): Promise<Map<string, Array<{ effectiveFrom: Date; effectiveTo: Date | null; shift: ResolvedShift }>>> {
  const result = new Map<
    string,
    Array<{ effectiveFrom: Date; effectiveTo: Date | null; shift: ResolvedShift }>
  >();
  if (employeeIds.length === 0) return result;

  const rows = await prisma.employeeShiftAssignment.findMany({
    where: {
      employeeId: { in: [...employeeIds] },
      effectiveFrom: { lte: to },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
    },
    select: {
      employeeId: true,
      effectiveFrom: true,
      effectiveTo: true,
      shift: { select: SHIFT_WINDOW_SELECT },
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  for (const row of rows) {
    const list = result.get(row.employeeId);
    const entry = { effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, shift: row.shift };
    if (list) list.push(entry);
    else result.set(row.employeeId, [entry]);
  }
  return result;
}

/** The assignment covering one day, from a list ordered latest-first. */
export function assignmentOn<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  assignments: readonly T[],
  key: string,
): T | null {
  return (
    assignments.find(
      (a) => dateKey(a.effectiveFrom) <= key && (a.effectiveTo === null || dateKey(a.effectiveTo) >= key),
    ) ?? null
  );
}

/**
 * Everything the deriver needs to know about a person.
 *
 * The lifecycle columns are REQUIRED rather than optional, and that is the
 * whole point of the type: a caller that forgets to select them gets a
 * compiler error instead of a month of absences for somebody who had already
 * left. `EMPLOYMENT_WINDOW_SELECT` spreads the four of them into any `select`.
 */
export type DerivableEmployee = { id: string; locationId: string | null } & EmploymentWindowFields;

/**
 * Derivation for several employees at once.
 *
 * The per-employee version delegates here so the team view does not fan out
 * into four queries per person - the whole range is fetched once and grouped in
 * memory. One implementation, so a team row and a personal row can never
 * disagree about the same day.
 *
 * Days outside the employment are not classified at all - see
 * `isEmployeeInAttendancePopulation`. Skipping them here, rather than in each
 * of the dozen callers, is what makes the rule impossible to apply
 * inconsistently: the team page, the dashboard counts and their drill-downs,
 * every report, every export and an individual's own calendar are all sums of
 * the days this function returns, so a day it declines to emit cannot be
 * counted as present, absent, half day, late, overtime, leave, a holiday or a
 * weekend anywhere downstream.
 */
export interface DeriveRangeOptions {
  /**
   * Whether days outside the employment are skipped. Defaults to true, which
   * is the rule described above and what every attendance figure in the
   * product wants.
   *
   * Payroll, and only payroll, passes false. Not because the days are
   * meaningful there - they are not - but because what a period PAYS is a
   * separate decision from what it DISPLAYS, and this fix was scoped to the
   * second. A run covering somebody who left mid-period currently sees their
   * post-exit days as ABSENT and prices them accordingly; silently changing
   * that would move money on a final settlement with no test watching. It is
   * a real bug and it wants its own change, with payroll tests and somebody's
   * sign-off - see the note at the call site in payroll.service.ts.
   */
  restrictToEmploymentWindow?: boolean;
}

export async function deriveRangeForEmployees(
  companyId: string,
  employees: ReadonlyArray<DerivableEmployee>,
  from: Date,
  to: Date,
  options: DeriveRangeOptions = {},
): Promise<Map<string, DerivedDay[]>> {
  const restrictToEmploymentWindow = options.restrictToEmploymentWindow ?? true;
  const result = new Map<string, DerivedDay[]>();
  if (employees.length === 0) return result;

  const employeeIds = employees.map((e) => e.id);

  const [policy, policyFor, records, leave, holidayRows, assignments] = await Promise.all([
    resolveAttendancePolicy(companyId),
    policyResolverFor(companyId, employeeIds, from, to),
    prisma.attendanceRecord.findMany({
      where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
      include: { shift: { select: { name: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: {
        leaveType: { select: { name: true, isPaid: true, isDeductible: true } },
        reversals: { select: { date: true } },
      },
    }),
    prisma.holiday.findMany({
      where: { companyId, isActive: true, date: { gte: from, lte: to } },
      select: { date: true, name: true, locationId: true },
    }),
    shiftAssignmentsForRange(employeeIds, from, to),
  ]);

  const recordsByEmployee = new Map<string, Map<string, (typeof records)[number]>>();
  for (const r of records) {
    let byDate = recordsByEmployee.get(r.employeeId);
    if (!byDate) recordsByEmployee.set(r.employeeId, (byDate = new Map()));
    byDate.set(dateKey(r.date), r);
  }

  const leaveByEmployee = new Map<string, typeof leave>();
  for (const l of leave) {
    const list = leaveByEmployee.get(l.employeeId);
    if (list) list.push(l);
    else leaveByEmployee.set(l.employeeId, [l]);
  }

  // "Future" is relative to the company's own clock, not the server's: at
  // 02:00 UTC it is already the next working day in Karachi.
  const todayKey = todayInZone(policy.timeZone);

  for (const employee of employees) {
    const recordByDate = recordsByEmployee.get(employee.id) ?? new Map();
    const employeeLeave = leaveByEmployee.get(employee.id) ?? [];
    const employeeShifts = assignments.get(employee.id) ?? [];

    // Only holidays that apply to this employee: their location plus company-wide.
    const holidayByDate = new Map<string, string>();
    for (const h of holidayRows) {
      if (h.locationId !== null && h.locationId !== employee.locationId) continue;
      holidayByDate.set(dateKey(h.date), h.name);
    }

    const days: DerivedDay[] = [];

    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      /**
       * Days this person was not employed for are not theirs to answer for.
       *
       * Checked before anything else is read, so a date outside the employment
       * produces no day at all rather than a day that has to be filtered out
       * again by whoever is counting. Their real days inside the employment are
       * untouched, and no stored record is read, written or hidden by this -
       * a terminated employee's September 1st to 10th still derive exactly as
       * they always did.
       */
      if (restrictToEmploymentWindow && !isEmployeeInAttendancePopulation(employee, d)) continue;

      const key = dateKey(d);
      const record = recordByDate.get(key);
      const holidayName = holidayByDate.get(key) ?? null;
      const assigned = assignmentOn(employeeShifts, key)?.shift ?? null;

      // A day given back because the person worked it is not leave; the
      // stored record decides it below like any other working day.
      const onLeave = employeeLeave.find(
        (l) =>
          dateKey(l.startDate) <= key &&
          dateKey(l.endDate) >= key &&
          !(l.reversals ?? []).some((r) => dateKey(r.date) === key),
      );

      /**
       * Which calendar decides whether this is a working day.
       *
       * A shift that lists its working days decides for the people on it; a
       * shift that lists none follows the company weekend. A day the shift
       * does not work that is not a company weekend is an OFF_DAY: rostered
       * off, not a weekend and not an absence.
       */
      const companyWeekend = isWeekendFor(d, policy.weekendDays);
      const shiftDecides = (assigned?.workingDays.length ?? 0) > 0;
      const working = isShiftWorkingDay(d, assigned, policy.weekendDays);

      /**
       * The figures AND the status, RECOMPUTED rather than read back.
       *
       * This is the single source of truth for what a day is worth. The stored
       * columns are a write-time cache of the same calculation, and a cache is
       * exactly what goes stale: every one of them was written under whatever
       * policy happened to be in force that night, so reading them back meant
       * a company could change its overtime rule and watch nothing change.
       *
       * The status used to be the one column still read back. The hours, the
       * lateness and the overtime followed the policy in force; the PRESENT /
       * HALF_DAY / ABSENT verdict beside them followed whatever the half-day
       * and full-day thresholds were on the night the day was imported. So a
       * company could raise its half-day threshold in Settings and watch every
       * figure on the screen move except the one the setting is named after.
       * The verdict now comes from the same `computeAttendance` call as the
       * figures, so the configured thresholds decide it - and changing them
       * changes it, with no import and no code change.
       *
       * The policy used is the one resolved for THIS employee on THIS date -
       * employee over team over department over company, effective-dated - so
       * an override no longer silently disagrees with the figure the import
       * stored under it.
       *
       * A record an administrator corrected is the exception and keeps its
       * stored figures and its stored status. Those are a human decision about
       * what the day was worth, and re-deriving them would quietly overrule the
       * person who made it.
       */
      const dayPolicy = policyFor(employee.id, d);
      const admin = record?.source === 'ADMIN';

      const computed =
        record && !admin
          ? computeAttendance({
              day: key,
              checkInAt: record.checkInAt,
              checkOutAt: record.checkOutAt,
              shift: assigned ? effectiveShift(assigned, dayPolicy) : null,
              policy: dayPolicy,
            })
          : null;

      /**
       * Order matters. Weekend, off day, holiday and approved leave describe
       * the day itself and hold whether it is past or future. A stored record
       * is fact - its punches are, and the policy in force says what they are
       * worth. Only then does the absence of a record mean anything - and it
       * means "absent" solely for a day that has already happened. A working
       * day in the future is UPCOMING: nobody has failed to attend a day that
       * has not arrived.
       */
      let status: DerivedAttendanceStatus;
      if (!working) status = companyWeekend || !shiftDecides ? 'WEEKEND' : 'OFF_DAY';
      else if (holidayName) status = 'HOLIDAY';
      else if (onLeave) status = 'ON_LEAVE';
      else if (computed) status = computed.status;
      else if (record) status = record.status;
      else if (key > todayKey) status = 'UPCOMING';
      else status = 'ABSENT';

      const workedMinutes = computed ? computed.workedMinutes : (record?.workedMinutes ?? null);
      const lateMinutes = computed ? computed.lateMinutes : (record?.lateMinutes ?? null);
      const earlyLeaveMinutes = computed
        ? computed.earlyLeaveMinutes
        : (record?.earlyLeaveMinutes ?? null);
      const irregular = computed ? computed.irregular : (record?.irregular ?? false);
      const integrity: AttendanceIntegrity = computed
        ? computed.integrity
        : record
          ? record.checkInAt && record.checkOutAt
            ? 'COMPLETE'
            : record.checkInAt
              ? 'OPEN'
              : 'NONE'
          : 'NONE';

      /**
       * Overtime on a day nobody was rostered for follows the company rule;
       * an ordinary working day takes the recomputed figure.
       */
      const stored = {
        workedMinutes,
        overtimeMinutes: computed ? computed.overtimeMinutes : (record?.overtimeMinutes ?? null),
      };
      const overtimeMinutes = !record
        ? null
        : status === 'HOLIDAY'
          ? nonWorkingDayOvertime(dayPolicy.holidayWorkRule, stored, dayPolicy)
          : status === 'WEEKEND' || status === 'OFF_DAY'
            ? nonWorkingDayOvertime(dayPolicy.weekendWorkRule, stored, dayPolicy)
            : stored.overtimeMinutes;

      const expectedMinutes = working
        ? expectedMinutesFor(effectiveShift(assigned, dayPolicy), dayPolicy)
        : null;

      const base = {
        date: key,
        status,
        checkInAt: record?.checkInAt?.toISOString() ?? null,
        checkOutAt: record?.checkOutAt?.toISOString() ?? null,
        workedMinutes,
        expectedMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        overtimeMinutes,
        breakMinutes: computed ? computed.breakMinutes : null,
        irregular,
        integrity,
        mode: record?.mode ?? null,
        shiftId: record?.shiftId ?? assigned?.id ?? null,
        shiftName: record?.shift?.name ?? assigned?.name ?? null,
        notes: record?.notes ?? null,
        leaveTypeName: onLeave?.leaveType.name ?? null,
        leaveIsPaid: onLeave ? onLeave.leaveType.isPaid : null,
        leaveIsDeductible: onLeave ? onLeave.leaveType.isDeductible : null,
        leaveDayPart: onLeave ? onLeave.dayPart : null,
        holidayName,
        source: record?.source ?? null,
        recordId: record?.id ?? null,
        hasRecord: record !== undefined,
      };

      days.push({ ...base, flags: attendanceFlags(base, dayPolicy) });
    }

    result.set(employee.id, days);
  }

  return result;
}

/**
 * Builds one row per calendar day in the range, merging stored attendance with
 * the leave, holiday and weekend calendars. Days with no record are still
 * returned, classified rather than simply missing.
 */
export async function deriveRange(
  companyId: string,
  employeeId: string,
  from: Date,
  to: Date,
): Promise<DerivedDay[]> {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { id: true, locationId: true, ...EMPLOYMENT_WINDOW_SELECT },
  });

  const byEmployee = await deriveRangeForEmployees(companyId, [employee], from, to);
  return byEmployee.get(employeeId) ?? [];
}

// ------------------------------------------------------------------- tallying

/**
 * Everything the tally reads, and nothing else.
 *
 * Spelled out as a `Pick` rather than taking a whole `DerivedDay` so that the
 * DTO-shaped `AttendanceDay` the routes hand around is accepted too - and so
 * the signature itself says which seven values a total is made of.
 */
type TallyableDay = Pick<
  DerivedDay,
  | 'status'
  | 'flags'
  | 'workedMinutes'
  | 'expectedMinutes'
  | 'lateMinutes'
  | 'earlyLeaveMinutes'
  | 'overtimeMinutes'
>;

export const emptyTotals = (): AttendanceTotals => ({
  present: 0,
  halfDay: 0,
  absent: 0,
  onLeave: 0,
  holiday: 0,
  weekend: 0,
  upcoming: 0,
  offDay: 0,
  workedMinutes: 0,
  expectedMinutes: 0,
  lateMinutes: 0,
  overtimeMinutes: 0,
});

export const emptyMonthlyTotals = (): AttendanceMonthlyTotals => ({
  ...emptyTotals(),
  late: 0,
  earlyLeave: 0,
  overtime: 0,
  missingPunch: 0,
  irregular: 0,
  manual: 0,
  earlyLeaveMinutes: 0,
  attendancePercentage: null,
});

/**
 * Headline numbers for a set of derived days.
 *
 * The one place days become totals. It lives beside the derivation rather than
 * in any screen's own file because three screens and the 360 profile all show
 * "this month" and none of them may reach a different answer from the same
 * days - which is exactly what happened when the correction centre and the
 * summary endpoint each kept their own adder.
 *
 * It counts; it decides nothing. Every value it reads - status, flags, worked,
 * expected, late, early, overtime - was already settled by the policy, so no
 * threshold, grace period or overtime rule appears anywhere below.
 *
 * The attendance percentage counts present and half days against the working
 * days that were actually scored, so a month half elapsed reads as the
 * attendance so far rather than as half the staff missing. A day still to come
 * is never in the denominator.
 */
export function tallyDerived(days: readonly TallyableDay[]): AttendanceMonthlyTotals {
  const totals = emptyMonthlyTotals();
  let scored = 0;
  let attended = 0;

  for (const day of days) {
    switch (day.status) {
      case 'PRESENT':
        totals.present += 1;
        break;
      case 'HALF_DAY':
        totals.halfDay += 1;
        break;
      case 'ABSENT':
        totals.absent += 1;
        break;
      case 'ON_LEAVE':
        totals.onLeave += 1;
        break;
      case 'HOLIDAY':
        totals.holiday += 1;
        break;
      case 'WEEKEND':
        totals.weekend += 1;
        break;
      case 'OFF_DAY':
        totals.offDay += 1;
        break;
      default:
        // A working day that has not arrived is counted separately and is
        // never treated as absence.
        totals.upcoming += 1;
        break;
    }

    totals.workedMinutes += day.workedMinutes ?? 0;
    totals.expectedMinutes += day.expectedMinutes ?? 0;
    totals.lateMinutes += day.lateMinutes ?? 0;
    totals.earlyLeaveMinutes += day.earlyLeaveMinutes ?? 0;
    totals.overtimeMinutes += day.overtimeMinutes ?? 0;

    for (const flag of day.flags) {
      if (flag === 'LATE') totals.late += 1;
      else if (flag === 'EARLY_LEAVE') totals.earlyLeave += 1;
      else if (flag === 'OVERTIME') totals.overtime += 1;
      else if (flag === 'MISSING_PUNCH') totals.missingPunch += 1;
      else if (flag === 'IRREGULAR') totals.irregular += 1;
      else if (flag === 'MANUAL') totals.manual += 1;
    }

    // Weekends, holidays, off days and days still ahead are not attendance
    // anybody was expected to produce.
    const countable =
      day.status === 'PRESENT' ||
      day.status === 'HALF_DAY' ||
      day.status === 'ABSENT' ||
      day.status === 'ON_LEAVE';
    if (countable) {
      scored += 1;
      if (day.status === 'PRESENT') attended += 1;
      else if (day.status === 'HALF_DAY') attended += 0.5;
    }
  }

  totals.attendancePercentage = scored > 0 ? Math.round((attended / scored) * 1000) / 10 : null;
  return totals;
}

/**
 * The shift in force for an employee on a given date, if any.
 *
 * Returns the whole window including the shift's rule overrides, so the engine
 * scores the day against the shift's own grace and caps and not only its
 * times.
 */
export async function shiftOnDate(employeeId: string, date: Date): Promise<ResolvedShift | null> {
  const assignment = await prisma.employeeShiftAssignment.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: date },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { shift: { select: SHIFT_WINDOW_SELECT } },
  });

  return assignment?.shift ?? null;
}

// ------------------------------------------------------- location restriction

/**
 * Enforces the company check-in geofence, server side.
 *
 * Deliberately fail-closed. When the restriction is on, a check-in the server
 * cannot place is refused rather than waved through - an employee with no work
 * location, or a location with no coordinates, is a configuration gap that
 * should be visible, not a silent bypass. The rule applies to remote check-ins
 * too: exempting them would make the whole restriction one dropdown away from
 * being defeated.
 *
 * Does nothing at all when the restriction is off, which is the default, so
 * existing companies are unaffected.
 */
/**
 * Enforces the company check-in network allow-list, server side.
 *
 * Fails closed the same way the geofence does: with the restriction on and an
 * empty allow-list, nothing is permitted. An allow-list that silently means
 * "everything" would be a security control that does the opposite of what its
 * name says.
 *
 * The address comes from Fastify, which honours `trustProxy` when configured;
 * it is never taken from a client-supplied header here.
 */
export function assertCheckInIpAllowed(input: {
  policy: AttendancePolicy;
  ip: string | null;
}): void {
  const { policy, ip } = input;
  if (!policy.ipRestrictionEnabled) return;

  if (policy.allowedCheckInCidrs.length === 0) {
    throw new ForbiddenError(
      'Check-in is restricted to approved networks, but no networks have been configured. Ask an administrator to add one.',
    );
  }

  if (!isIpAllowed(ip, policy.allowedCheckInCidrs)) {
    // Deliberately does not echo the address or the allow-list back.
    throw new ForbiddenError(
      'You are not on a network approved for check-in. Connect to a company network and try again.',
    );
  }
}

export async function assertCheckInLocationAllowed(input: {
  employee: { locationId: string | null };
  policy: AttendancePolicy;
  latitude: number | null;
  longitude: number | null;
}): Promise<{ distanceMeters: number; radiusMeters: number } | null> {
  const { employee, policy, latitude, longitude } = input;
  if (!policy.locationRestrictionEnabled) return null;

  if (latitude === null || longitude === null) {
    throw new ValidationError({
      latitude: ['Your company requires check-in from an approved location. Share your location and try again.'],
    });
  }

  if (!employee.locationId) {
    throw new ForbiddenError(
      'Check-in is restricted to approved work locations, but you have no work location assigned. Ask HR to set one.',
    );
  }

  const site = await prisma.location.findUnique({
    where: { id: employee.locationId },
    select: { name: true, latitude: true, longitude: true, geofenceRadiusMeters: true },
  });

  if (!site || site.latitude === null || site.longitude === null) {
    throw new ForbiddenError(
      `Check-in is restricted to approved work locations, but ${site?.name ?? 'your location'} has no coordinates set. Ask HR to configure it.`,
    );
  }

  const radiusMeters = site.geofenceRadiusMeters ?? policy.defaultGeofenceRadiusM;
  const distanceMeters = haversineMeters(
    { latitude: site.latitude, longitude: site.longitude },
    { latitude, longitude },
  );

  if (distanceMeters > radiusMeters) {
    throw new ForbiddenError(
      `You appear to be ${distanceMeters}m from ${site.name}, outside the ${radiusMeters}m check-in area.`,
    );
  }

  return { distanceMeters, radiusMeters };
}

/**
 * Whether a web check-out is being made from somewhere it is allowed.
 *
 * Two boundaries, around the same centre - the employee's work location:
 *
 *  - PREMISES, for an employee explicitly allowed to check out away from the
 *    terminal (`premisesCheckOutAllowed`): within `checkOutRadiusMeters`. The
 *    boundary must be configured; without it the check-out is refused rather
 *    than allowed from anywhere, and no coordinates are invented.
 *  - OFFICE, for everyone else, only while the company enforces it: within
 *    the same geofence check-in uses.
 *
 * Returns null when no location rule applies - a company that has not turned
 * enforcement on and an employee who is not on premises check-out - which is
 * exactly how web check-out behaved before any of this existed.
 *
 * Fails closed throughout, and every message says what to do next, because
 * "permission denied" and "your phone could not find itself" need different
 * fixes from the person standing in the car park.
 */
export async function assertCheckOutLocationAllowed(input: {
  employee: { locationId: string | null; premisesCheckOutAllowed?: boolean };
  policy: AttendancePolicy;
  latitude: number | null;
  longitude: number | null;
  locationUnavailable: string | null;
}): Promise<{ distanceMeters: number; radiusMeters: number; boundary: 'PREMISES' | 'OFFICE' } | null> {
  const { employee, policy, latitude, longitude } = input;
  const premises = employee.premisesCheckOutAllowed === true;
  if (!premises && !policy.checkOutLocationEnforced) return null;

  if (latitude === null || longitude === null) {
    const why =
      input.locationUnavailable === 'DENIED'
        ? 'Location permission was denied. Allow location for this site in your browser settings and try again, or check out at the terminal.'
        : input.locationUnavailable === 'UNSUPPORTED'
          ? 'This browser cannot share a location. Use a phone or browser that can, or check out at the terminal.'
          : input.locationUnavailable === 'TIMEOUT' || input.locationUnavailable === 'UNAVAILABLE'
            ? 'Your device could not determine its location. Move somewhere with a clearer signal and try again, or check out at the terminal.'
            : 'Checking out on the web needs your location. Share it and try again, or check out at the terminal.';
    throw new ValidationError({ latitude: [why] });
  }

  if (!employee.locationId) {
    throw new ForbiddenError(
      'Web check-out is limited to your work location, but you have no work location assigned. Ask HR to set one, or check out at the terminal.',
    );
  }

  const site = await prisma.location.findUnique({
    where: { id: employee.locationId },
    select: {
      name: true,
      latitude: true,
      longitude: true,
      geofenceRadiusMeters: true,
      checkOutRadiusMeters: true,
    },
  });
  if (!site || site.latitude === null || site.longitude === null) {
    throw new ForbiddenError(
      `${site?.name ?? 'Your work location'} has no office coordinates configured, so web check-out cannot be checked. Ask HR to set them, or check out at the terminal.`,
    );
  }

  const radiusMeters = premises
    ? site.checkOutRadiusMeters
    : (site.geofenceRadiusMeters ?? policy.defaultGeofenceRadiusM);
  if (radiusMeters === null || radiusMeters === undefined) {
    throw new ForbiddenError(
      `No office premises boundary is configured for ${site.name}, so check-out away from the terminal is not available yet. Ask HR to set one, or check out at the terminal.`,
    );
  }

  const distanceMeters = haversineMeters(
    { latitude: site.latitude, longitude: site.longitude },
    { latitude, longitude },
  );
  if (distanceMeters > radiusMeters) {
    throw new OutsideBoundaryError(
      `You appear to be ${distanceMeters}m from ${site.name}, outside the ${radiusMeters}m ${premises ? 'office premises' : 'check-out'} area. Check out from inside it, or at the terminal.`,
      { distanceMeters, radiusMeters, boundary: premises ? 'PREMISES' : 'OFFICE' },
    );
  }

  return { distanceMeters, radiusMeters, boundary: premises ? 'PREMISES' : 'OFFICE' };
}

/** A refusal that carries the measurement, so the route can put it on the record. */
export class OutsideBoundaryError extends ForbiddenError {
  constructor(
    message: string,
    readonly measured: { distanceMeters: number; radiusMeters: number; boundary: 'PREMISES' | 'OFFICE' },
  ) {
    super(message);
  }
}

// ----------------------------------------------------- approval write-through

/**
 * Applies an approved regularisation to the attendance record.
 *
 * Called by the approval engine's write-through. Without this an approved
 * correction would flip a status and change nothing that anyone actually reads,
 * which is worse than refusing the request outright.
 *
 * The requested status wins when the approver named one - a human decision
 * beats the arithmetic. Everything else (worked, late, early, overtime) is
 * recomputed from the policy so a corrected day is scored exactly like a day
 * captured live.
 */
export async function applyRegularization(regularizationId: string): Promise<void> {
  const req = await prisma.attendanceRegularizationRequest.findUnique({
    where: { id: regularizationId },
  });
  if (!req || req.status !== 'APPROVED') return;

  const date = toDateOnly(req.attendanceDate);
  const [existing, policy, shift] = await Promise.all([
    prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId: req.employeeId, date } },
    }),
    resolvePolicyFor(req.companyId, req.employeeId, date),
    shiftOnDate(req.employeeId, date),
  ]);

  const checkInAt = req.requestedCheckInAt ?? existing?.checkInAt ?? null;
  const checkOutAt = req.requestedCheckOutAt ?? existing?.checkOutAt ?? null;

  const computed = computeAttendance({ day: date, checkInAt, checkOutAt, shift, policy });
  const status = req.requestedStatus ?? computed.status;
  const note = `Corrected by approved request: ${req.reason}`;

  const values = {
    status,
    checkInAt,
    checkOutAt,
    workedMinutes: computed.workedMinutes ?? existing?.workedMinutes ?? null,
    lateMinutes: computed.lateMinutes,
    earlyLeaveMinutes: computed.earlyLeaveMinutes,
    overtimeMinutes: computed.overtimeMinutes,
    irregular: computed.irregular,
    shiftId: shift?.id ?? existing?.shiftId ?? null,
    notes: note,
    // The value came from an approval decision, not from the person.
    source: 'ADMIN' as const,
  };

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: req.employeeId, date } },
    create: { companyId: req.companyId, employeeId: req.employeeId, date, ...values },
    update: values,
  });

  await reconcileAfterAttendanceWrite({
    companyId: req.companyId,
    employeeId: req.employeeId,
    dayKey: date.toISOString().slice(0, 10),
  });
}

/**
 * Applies an approved shift change by creating the assignment and closing off
 * whatever was in force before it.
 */
export async function applyShiftChange(shiftChangeId: string): Promise<void> {
  const req = await prisma.shiftChangeRequest.findUnique({ where: { id: shiftChangeId } });
  if (!req || req.status !== 'APPROVED') return;

  const from = toDateOnly(req.effectiveFrom);

  // Nothing to do if the assignment already exists - approval is idempotent.
  const already = await prisma.employeeShiftAssignment.findFirst({
    where: { employeeId: req.employeeId, shiftId: req.requestedShiftId, effectiveFrom: from },
    select: { id: true },
  });
  if (already) return;

  const dayBefore = new Date(from);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);

  await prisma.$transaction([
    // Close any open assignment so two shifts never overlap.
    prisma.employeeShiftAssignment.updateMany({
      where: { employeeId: req.employeeId, effectiveTo: null, effectiveFrom: { lt: from } },
      data: { effectiveTo: dayBefore },
    }),
    prisma.employeeShiftAssignment.create({
      data: {
        companyId: req.companyId,
        employeeId: req.employeeId,
        shiftId: req.requestedShiftId,
        effectiveFrom: from,
      },
    }),
  ]);
}
