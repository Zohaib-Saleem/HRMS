import type { WeekDay } from '@prisma/client';
import { prisma } from '../../core/db.js';

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
}

const POLICY_SELECT = {
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
} as const;

/**
 * Reads the live policy. Deliberately not cached: a policy change made in
 * settings has to affect the very next check-out, not the next restart.
 */
export async function resolveAttendancePolicy(companyId: string): Promise<AttendancePolicy> {
  return prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: POLICY_SELECT });
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

export interface ShiftWindow {
  startTime: string;
  endTime: string;
}

/** Minutes since midnight for an "HH:mm" string, or null if unparseable. */
function minutesOfDay(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** The instant a shift boundary falls on the calendar day of `onDate` (UTC). */
function boundaryOn(onDate: Date, hhmm: string): Date | null {
  const mins = minutesOfDay(hhmm);
  if (mins === null) return null;
  return new Date(
    Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate()) + mins * 60_000,
  );
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
  policy: Pick<AttendancePolicy, 'graceMinutes'>,
): number | null {
  if (!shift) return null;
  const expected = boundaryOn(checkInAt, shift.startTime);
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
  policy: Pick<AttendancePolicy, 'earlyLeaveGraceMinutes'>,
): number | null {
  if (!shift) return null;

  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  if (start === null || end === null || end <= start) return null;

  const expected = boundaryOn(checkOutAt, shift.endTime);
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

export interface AttendanceComputation {
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  /** What the policy says the day is worth, before calendar overrides. */
  status: 'PRESENT' | 'HALF_DAY' | 'ABSENT';
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
  checkInAt: Date | null;
  checkOutAt: Date | null;
  shift: ShiftWindow | null;
  policy: AttendancePolicy;
}): AttendanceComputation {
  const { checkInAt, checkOutAt, shift, policy } = input;

  const workedMinutes =
    checkInAt && checkOutAt
      ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000))
      : null;

  const lateMinutes = checkInAt ? lateMinutesFor(checkInAt, shift, policy) : null;
  const earlyLeaveMinutes = checkOutAt ? earlyLeaveMinutesFor(checkOutAt, shift, policy) : null;
  const overtimeMinutes = overtimeMinutesFor(workedMinutes, policy);

  let status: AttendanceComputation['status'];
  if (!checkInAt) status = 'ABSENT';
  else if (workedMinutes === null) status = 'PRESENT';
  else if (workedMinutes >= policy.fullDayMinutes) status = 'PRESENT';
  else if (workedMinutes >= policy.halfDayMinutes) status = 'HALF_DAY';
  else status = 'ABSENT';

  return { workedMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, status };
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
