import type { AttendancePunchPairing } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { dayKeyToDateColumn } from '../../core/zoned-time.js';
import {
  checkOutBoundaryOn,
  computeAttendance,
  resolvePolicyFor,
} from '../time/attendance-policy.js';
import { shiftOnDate } from '../time/attendance.service.js';

/**
 * Turning raw punches into attendance.
 *
 * This is the only place device data meets the attendance engine, and it holds
 * exactly one rule of its own: which punch is the arrival and which is the
 * departure. Everything after that - lateness, half days, overtime, weekends,
 * holidays, leave - is the existing engine's job and is not reimplemented here.
 * A punch does not make someone present; the policy decides that.
 */

export interface RecalculationResult {
  employeeId: string;
  dayKey: string;
  /** Null when nothing was written, with the reason recorded below. */
  status: string | null;
  skipped: 'MANUAL_RECORD' | 'NO_USABLE_PUNCH' | null;
}

/** What a punch meant for attendance, as against which key was pressed. */
export type PunchRole = 'IN' | 'OUT';

/** Directions a terminal reports that mean what they say. */
const STATED_ROLES: Readonly<Record<string, PunchRole>> = { IN: 'IN', OUT: 'OUT' };

/**
 * Directions that describe the terminal's mode rather than the employee's.
 *
 * A K50 whose punch mode is nudged into an overtime setting stamps OVERTIME_IN
 * - or OVERTIME_OUT - on every transaction until somebody notices, an ordinary
 * evening departure included. The transaction is real and the employee is not
 * the one who chose the label, so reading the label literally is how a normal
 * day acquires two arrivals and no departure.
 *
 * They are also not a claim about overtime. Whether the day earned any is the
 * policy's decision from the hours worked, exactly as for a day of IN and OUT.
 */
const MODE_ROLES: ReadonlySet<string> = new Set(['OVERTIME_IN', 'OVERTIME_OUT']);

/**
 * Reads a day's punches as arrivals and departures.
 *
 * A stated direction is taken at its word. A direction that came from the
 * terminal's *mode* is not a direction at all, so it is resolved from when the
 * punch happened, against the scheduled end of that employee's own day:
 *
 *   - at or after the scheduled end, it is a departure. Somebody standing at
 *     the terminal after their shift has finished is going home, and this is
 *     the case the whole rule exists for: it is what stops a mis-set punch
 *     mode from turning an ordinary six-o'clock departure into "check out:
 *     missing".
 *   - before the scheduled end, the label is not evidence of anything. The
 *     first punch of a day is still the arrival, because something has to be;
 *     a later one is left unread rather than promoted into a departure at ten
 *     in the morning, which would close the day hours early.
 *
 * `checkOutFrom` is that boundary, and null means it could not be established -
 * no shift, an unparseable window, an overnight one. Then there is no time to
 * reason from and the reading falls back to position alone, which is what this
 * function did before the boundary existed: first punch in, anything after an
 * arrival out.
 *
 * Nothing is invented and nothing is dropped - every punch handed in comes
 * back, carrying the role it was read as and whether that role was stated or
 * inferred.
 *
 * The raw punch is untouched. `punchState` is what the device said and remains
 * what the device said; this is a reading of it, taken fresh each time the day
 * is calculated, so an audit can always see both.
 */
export function resolvePunchRoles<T extends { punchedAt: Date; punchState: string | null }>(
  punches: ReadonlyArray<T>,
  /** Scheduled end of the employee's day; from here a mode label means OUT. */
  checkOutFrom: Date | null = null,
): Array<{ punch: T; role: PunchRole | null; inferred: boolean }> {
  const ordered = [...punches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());

  let arrived = false;
  return ordered.map((punch) => {
    const stated = punch.punchState === null ? undefined : STATED_ROLES[punch.punchState];
    if (stated) {
      arrived ||= stated === 'IN';
      return { punch, role: stated, inferred: false };
    }

    if (punch.punchState !== null && MODE_ROLES.has(punch.punchState)) {
      // Something has to be the arrival, and the first punch of a day is it -
      // whatever mode the terminal happened to be in. Reading a lone evening
      // punch as a departure instead would leave the day with no arrival, and
      // a day with no arrival is written as no day at all.
      if (!arrived) {
        arrived = true;
        return { punch, role: 'IN', inferred: true };
      }

      // Past the end of the scheduled day: this is somebody going home, and it
      // is the case the rule exists for.
      if (checkOutFrom !== null && punch.punchedAt.getTime() >= checkOutFrom.getTime()) {
        return { punch, role: 'OUT', inferred: true };
      }

      // Still inside the scheduled day. With a boundary to measure against,
      // refusing to read the label is the honest answer: the punch is kept,
      // and it closes nothing. Promoting it would end the day early - at ten
      // in the morning, for the shapes that prompted this.
      if (checkOutFrom !== null) return { punch, role: null, inferred: false };

      // No boundary at all - position is the only thing left to read.
      return { punch, role: 'OUT', inferred: true };
    }

    // A state this system has no reading for - a break, or a spelling from a
    // terminal nobody has met yet. Repeating the old behaviour: it is kept,
    // and it is not guessed at.
    return { punch, role: null, inferred: false };
  });
}

/**
 * Chooses the arrival and departure from a day's punches.
 *
 * FIRST_IN_LAST_OUT is the default because it is the only rule that is right
 * when a terminal reports no direction at all, which is common. A single punch
 * yields an arrival and no departure: inventing a departure would manufacture
 * worked hours nobody recorded, and the engine already handles a day that is
 * still open.
 */
export function pairPunches(
  punches: ReadonlyArray<{ punchedAt: Date; punchState: string | null }>,
  strategy: AttendancePunchPairing,
  /**
   * Punches closer together than this are the same event seen twice. Comes
   * from the company's own configuration; zero takes every punch at face
   * value, which is what this function did before the setting existed.
   */
  duplicateWindowSeconds = 0,
  /**
   * The scheduled end of the employee's day, from `checkOutBoundaryOn`. Only
   * DEVICE_STATE reads it, and only for punches carrying an overtime mode
   * label; FIRST_IN_LAST_OUT never looks at a state at all. Null means no
   * boundary could be established, and the label is then read by position.
   */
  checkOutFrom: Date | null = null,
): { checkInAt: Date | null; checkOutAt: Date | null } {
  if (punches.length === 0) return { checkInAt: null, checkOutAt: null };

  const ordered = collapseDuplicates(punches, duplicateWindowSeconds);

  if (strategy === 'DEVICE_STATE') {
    const read = resolvePunchRoles(ordered, checkOutFrom);
    const ins = read.filter((p) => p.role === 'IN');
    const outs = read.filter((p) => p.role === 'OUT');

    // A device configured to report direction, that then reports none, is a
    // configuration problem. Falling back silently would hide it; returning
    // nothing surfaces the day as unresolved instead of inventing times.
    return {
      checkInAt: ins[0]?.punch.punchedAt ?? null,
      checkOutAt: outs.length > 0 ? outs[outs.length - 1]!.punch.punchedAt : null,
    };
  }

  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  return {
    checkInAt: first.punchedAt,
    // One punch is an arrival, not an arrival and a departure at the same
    // instant. Zero worked minutes would otherwise be reported as fact.
    checkOutAt: ordered.length > 1 ? last.punchedAt : null,
  };
}

/**
 * Drops punches that are the same event reported twice.
 *
 * A terminal will happily record a badge twice in a second, and a site with
 * two readers on one door reports the same arrival from both. Neither is a
 * second event, and keeping them is how an ordinary morning acquires a
 * spurious "departure" a few seconds after the arrival.
 *
 * Only consecutive punches are compared, and the FIRST of a cluster is kept:
 * the earliest report of an event is the one that happened. The raw punches
 * are never touched - this is a reading of them, not an edit.
 */
export function collapseDuplicates<T extends { punchedAt: Date; punchState: string | null }>(
  punches: ReadonlyArray<T>,
  windowSeconds: number,
): T[] {
  const ordered = [...punches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
  if (windowSeconds <= 0) return ordered;

  const kept: T[] = [];
  for (const punch of ordered) {
    const previous = kept[kept.length - 1];
    if (!previous) {
      kept.push(punch);
      continue;
    }
    const gapSeconds = (punch.punchedAt.getTime() - previous.punchedAt.getTime()) / 1000;
    /**
     * A punch inside the window is a duplicate only when it says the same
     * thing. A reader that reports IN and then OUT four seconds apart is
     * describing two different events badly, but they are still two events,
     * and collapsing them would silently discard a departure.
     */
    if (gapSeconds < windowSeconds && punch.punchState === previous.punchState) continue;
    kept.push(punch);
  }
  return kept;
}

/**
 * Recalculates one employee-day from its punches.
 *
 * A record an administrator has corrected is never overwritten. The device is
 * the source of raw events; a human decision about what a day means outranks
 * it, and the punches remain underneath either way.
 */
export async function recalculateFromPunches(input: {
  companyId: string;
  employeeId: string;
  dayKey: string;
  pairing: AttendancePunchPairing;
}): Promise<RecalculationResult> {
  const { companyId, employeeId, dayKey, pairing } = input;
  const date = dayKeyToDateColumn(dayKey);

  const [punches, existing] = await Promise.all([
    prisma.attendanceRawPunch.findMany({
      where: { companyId, employeeId, localDayKey: dayKey },
      select: { id: true, punchedAt: true, punchState: true },
      orderBy: { punchedAt: 'asc' },
    }),
    prisma.attendanceRecord.findUnique({
      where: { employeeId_date: { employeeId, date } },
      select: { id: true, source: true },
    }),
  ]);

  if (punches.length === 0) {
    return { employeeId, dayKey, status: null, skipped: 'NO_USABLE_PUNCH' };
  }

  // A correction that a device sync could undo is not a correction.
  if (existing && existing.source === 'ADMIN') {
    await markProcessed(punches.map((p) => p.id));
    return { employeeId, dayKey, status: null, skipped: 'MANUAL_RECORD' };
  }

  const [policy, shift] = await Promise.all([
    resolvePolicyFor(companyId, employeeId, date),
    shiftOnDate(employeeId, date),
  ]);

  // The employee's own scheduled end, from the shift and policy already
  // resolved above - not a second shift calculation, and not a literal 18:00.
  const { checkInAt, checkOutAt } = pairPunches(
    punches,
    pairing,
    policy.duplicatePunchWindowSeconds,
    checkOutBoundaryOn({ shift, policy, dayKey }),
  );
  if (!checkInAt) {
    await markProcessed(punches.map((p) => p.id));
    return { employeeId, dayKey, status: null, skipped: 'NO_USABLE_PUNCH' };
  }

  const computed = computeAttendance({ day: dayKey, checkInAt, checkOutAt, shift, policy });

  const values = {
    status: computed.status,
    checkInAt,
    checkOutAt,
    workedMinutes: computed.workedMinutes,
    lateMinutes: computed.lateMinutes,
    earlyLeaveMinutes: computed.earlyLeaveMinutes,
    overtimeMinutes: computed.overtimeMinutes,
    irregular: computed.irregular,
    shiftId: shift?.id ?? null,
    source: 'DEVICE' as const,
  };

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId, date } },
    create: { companyId, employeeId, date, ...values },
    update: values,
  });

  await markProcessed(punches.map((p) => p.id));
  return { employeeId, dayKey, status: computed.status, skipped: null };
}

async function markProcessed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.attendanceRawPunch.updateMany({
    where: { id: { in: [...ids] } },
    data: { processedAt: new Date() },
  });
}

/**
 * Recalculates every employee-day a batch of punches touched.
 *
 * Failures are per-day: one employee whose recalculation throws must not stop
 * the rest of a night's import from landing.
 */
export async function recalculateDays(input: {
  companyId: string;
  pairing: AttendancePunchPairing;
  days: ReadonlyArray<{ employeeId: string; dayKey: string }>;
}): Promise<{ recalculated: number; skipped: number; failed: number }> {
  let recalculated = 0;
  let skipped = 0;
  let failed = 0;

  for (const day of input.days) {
    try {
      const result = await recalculateFromPunches({
        companyId: input.companyId,
        employeeId: day.employeeId,
        dayKey: day.dayKey,
        pairing: input.pairing,
      });
      if (result.skipped) skipped += 1;
      else recalculated += 1;
    } catch {
      failed += 1;
    }
  }

  return { recalculated, skipped, failed };
}
