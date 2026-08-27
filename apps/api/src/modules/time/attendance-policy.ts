import type { AttendancePolicyScope, WeekDay } from '@prisma/client';
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
  ipRestrictionEnabled: boolean;
  allowedCheckInCidrs: string[];
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
  ipRestrictionEnabled: true,
  allowedCheckInCidrs: true,
} as const;

/**
 * Reads the company baseline. Deliberately not cached: a policy change made in
 * settings has to affect the very next check-out, not the next restart.
 *
 * Weekend days and the check-in restrictions live only at this level. They
 * describe the company, not a person, so they are never overridden per team.
 */
export async function resolveAttendancePolicy(companyId: string): Promise<AttendancePolicy> {
  return prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: POLICY_SELECT });
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

  const overrides = Object.fromEntries(
    OVERRIDABLE.map((key) => [key, winner.policy[key]]),
  ) as Pick<AttendancePolicy, (typeof OVERRIDABLE)[number]>;

  return {
    ...baseline,
    ...overrides,
    policyId: winner.policy.id,
    policyName: winner.policy.name,
    scope: winner.scope,
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
