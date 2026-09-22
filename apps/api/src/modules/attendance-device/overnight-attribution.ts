import type { AttendancePunchPairing } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { clockBoundary, type DayKey } from '../../core/zoned-time.js';
import { pairPunches } from './attendance-import.service.js';

/**
 * Which of a day's punches actually belong to the day before it.
 *
 * The case: somebody arrives at 09:00, works very late, and badges out at
 * 00:29. That punch carries the next date, so read literally it opens a new
 * day - leaving the long day with an arrival and no departure, earning
 * nothing, and scoring the next day from an arrival nobody made. The evening's
 * overtime is the half of that which costs somebody money.
 *
 * The rule is a question about the previous day rather than an hour of the
 * clock, because an hour cannot tell a late departure from an early arrival.
 * Three things must all hold:
 *
 *   1. the punch falls before the cutoff, so a whole ordinary morning can
 *      never be dragged backwards;
 *   2. the previous day is OPEN - its own punches yield an arrival and no
 *      departure. A day that already closed is not waiting for one;
 *   3. the punch is within the window of that day's first punch. This is what
 *      separates a long day from a forgotten departure: at some point "they
 *      are still here" stops being the likelier story.
 *
 * Openness is asked of `pairPunches` rather than counted here, so a company on
 * DEVICE_STATE and one on FIRST_IN_LAST_OUT both get the reading their own
 * strategy would give, and this never becomes a second opinion about pairing.
 */
export interface OvernightSettings {
  /** Zero switches the rule off. */
  windowMinutes: number;
  /** Local time, `HH:MM`. */
  cutoff: string;
  timeZone: string;
  pairing: AttendancePunchPairing;
  duplicateWindowSeconds: number;
}

export interface AttributablePunch {
  id: string;
  punchedAt: Date;
  punchState: string | null;
}

/**
 * Returns the ids of `dayPunches` that belong to `previousDayKey`.
 *
 * Pure, and deliberately given both days' punches rather than a database
 * handle: the rule is the part worth testing, and it is testable only if it
 * cannot read anything.
 */
export function punchesBelongingToPreviousDay(input: {
  dayKey: DayKey;
  previousDayPunches: ReadonlyArray<AttributablePunch>;
  dayPunches: ReadonlyArray<AttributablePunch>;
  settings: OvernightSettings;
}): string[] {
  const { dayKey, previousDayPunches, dayPunches, settings } = input;
  const { windowMinutes, cutoff, timeZone, pairing, duplicateWindowSeconds } = settings;

  if (windowMinutes <= 0) return [];
  if (previousDayPunches.length === 0 || dayPunches.length === 0) return [];

  // 2. Is the previous day waiting for a departure? Asked of the same function
  //    that will score it, so the answer cannot disagree with the record.
  const previous = pairPunches(previousDayPunches, pairing, duplicateWindowSeconds);
  if (!previous.checkInAt || previous.checkOutAt) return [];

  // 1. Nothing at or after the cutoff can be yesterday's departure. A cutoff
  //    that will not parse is treated as no rule at all rather than as
  //    midnight - the same reading `checkOutBoundaryOn` gives an unparseable
  //    window, and for the same reason.
  const cutoffAt = clockBoundary(dayKey, cutoff, timeZone);
  if (!cutoffAt) return [];

  // 3. The window runs from the previous day's ARRIVAL, not from its last
  //    punch: the question is how long the day has been running.
  const latest = previous.checkInAt.getTime() + windowMinutes * 60_000;

  const ordered = [...dayPunches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
  const moving: string[] = [];

  for (const punch of ordered) {
    // Only a LEADING run moves. Once a punch stays, every later one is on the
    // near side of an arrival and belongs to this day whatever its time -
    // which is what makes "the next punch is the check-in" true rather than
    // hopeful.
    if (punch.punchedAt.getTime() >= cutoffAt.getTime()) break;
    if (punch.punchedAt.getTime() > latest) break;
    moving.push(punch.id);
  }

  return moving;
}

/** The calendar day before `dayKey`, as a day key. */
export function previousDayKey(dayKey: DayKey): DayKey {
  const [year, month, day] = dayKey.split('-').map(Number);
  const instant = new Date(Date.UTC(year!, month! - 1, day!));
  instant.setUTCDate(instant.getUTCDate() - 1);
  return instant.toISOString().slice(0, 10);
}

/**
 * Moves an employee's post-midnight punches onto the day they close.
 *
 * `localDayKey` is an attribution, not a fact - the fact is `punchedAt`, which
 * is never touched. Re-attributing here rather than reinterpreting at scoring
 * time is what keeps the reports, the punch viewer and the corrections screen
 * agreeing with the record: they all group by this one key, and a punch that
 * belongs to Monday should appear under Monday everywhere, not only in the
 * hours.
 *
 * Idempotent: a punch already attributed to the previous day is no longer in
 * that day's set to be moved again. Returns every day key whose punches
 * changed, so the caller can recalculate exactly those.
 */
export async function reattributeOvernightPunches(input: {
  companyId: string;
  employeeId: string;
  dayKeys: readonly string[];
  settings: OvernightSettings;
}): Promise<string[]> {
  const { companyId, employeeId, settings } = input;
  if (settings.windowMinutes <= 0) return [];

  // Ascending, so a day that has just been given a departure is already
  // settled by the time the day after it is considered. A chain of late
  // nights then resolves in one pass rather than needing several.
  const dayKeys = [...new Set(input.dayKeys)].sort();
  const touched = new Set<string>();

  for (const dayKey of dayKeys) {
    const yesterday = previousDayKey(dayKey);

    const [previousDayPunches, dayPunches] = await Promise.all([
      prisma.attendanceRawPunch.findMany({
        where: { companyId, employeeId, localDayKey: yesterday },
        select: { id: true, punchedAt: true, punchState: true },
        orderBy: { punchedAt: 'asc' },
      }),
      prisma.attendanceRawPunch.findMany({
        where: { companyId, employeeId, localDayKey: dayKey },
        select: { id: true, punchedAt: true, punchState: true },
        orderBy: { punchedAt: 'asc' },
      }),
    ]);

    const moving = punchesBelongingToPreviousDay({
      dayKey,
      previousDayPunches,
      dayPunches,
      settings,
    });
    if (moving.length === 0) continue;

    await prisma.attendanceRawPunch.updateMany({
      where: { id: { in: moving } },
      data: { localDayKey: yesterday },
    });

    touched.add(dayKey);
    touched.add(yesterday);
  }

  return [...touched];
}

/** One day whose punches moved back, as the scan found it. */
export interface RangeMove {
  employeeId: string;
  fromDayKey: string;
  toDayKey: string;
  punchesMoved: number;
}

/**
 * Re-attributes a window of history that was imported before the rule existed.
 *
 * The import path only ever sees the days a batch touched, so a company that
 * turns the rule on - or changes the window - still has every earlier late
 * night read the old way. This is the way to go back for them.
 *
 * What it deliberately does NOT do is re-derive the range. Re-scoring every
 * day in a window re-reads days nothing was wrong with under today's policy,
 * which restates history that was correct; only the days where a punch
 * actually changed sides are returned for scoring. That scope is the whole
 * point of the function.
 *
 * `dryRun` answers the same question without writing, because "show me what
 * would move" is the first thing anybody sane asks of a backfill.
 */
export async function reattributeDateRange(input: {
  companyId: string;
  from: string;
  to: string;
  employeeId?: string;
  dryRun: boolean;
  settingsFor: (employeeId: string, dayKey: string) => Promise<OvernightSettings | null>;
}): Promise<{ employeesScanned: number; daysScanned: number; moved: RangeMove[] }> {
  const { companyId, from, to, dryRun, settingsFor } = input;

  /*
   * `localDayKey` is a `YYYY-MM-DD` string, so the range is a string
   * comparison. That is sound for this format and only this format - it is
   * zero-padded and big-endian, so lexical order IS date order.
   */
  const candidates = await prisma.attendanceRawPunch.groupBy({
    by: ['employeeId', 'localDayKey'],
    where: {
      companyId,
      employeeId: input.employeeId ? input.employeeId : { not: null },
      localDayKey: { gte: from, lte: to },
    },
  });

  const byEmployee = new Map<string, string[]>();
  for (const row of candidates) {
    if (!row.employeeId) continue;
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row.localDayKey);
    byEmployee.set(row.employeeId, list);
  }

  const moved: RangeMove[] = [];

  /*
   * Punches this scan has already given to an earlier day.
   *
   * A real run has written them and would not read them back under their old
   * day; a dry run has not. Without this a dry run reads a day that is about
   * to lose its leading punches as though it still had them - so a chain of
   * late nights reports only its first link, and the preview disagrees with
   * the run it is previewing. Filtering here makes both paths read the same.
   */
  const relocated = new Set<string>();

  const punchesOn = async (employeeId: string, dayKey: string) => {
    const rows = await prisma.attendanceRawPunch.findMany({
      where: { companyId, employeeId, localDayKey: dayKey },
      select: { id: true, punchedAt: true, punchState: true },
      orderBy: { punchedAt: 'asc' },
    });
    return rows.filter((row) => !relocated.has(row.id));
  };

  for (const [employeeId, dayKeys] of byEmployee) {
    // Ascending, for the same reason the writer sorts: a day that has just
    // been closed is settled before the day after it is considered.
    const ordered = [...new Set(dayKeys)].sort();
    const settings = await settingsFor(employeeId, ordered[0]!);
    if (!settings || settings.windowMinutes <= 0) continue;

    for (const dayKey of ordered) {
      const yesterday = previousDayKey(dayKey);

      const [previousDayPunches, dayPunches] = await Promise.all([
        punchesOn(employeeId, yesterday),
        punchesOn(employeeId, dayKey),
      ]);

      const moving = punchesBelongingToPreviousDay({
        dayKey,
        previousDayPunches,
        dayPunches,
        settings,
      });
      if (moving.length === 0) continue;

      if (!dryRun) {
        await prisma.attendanceRawPunch.updateMany({
          where: { id: { in: moving } },
          data: { localDayKey: yesterday },
        });
      }

      for (const id of moving) relocated.add(id);

      moved.push({
        employeeId,
        fromDayKey: dayKey,
        toDayKey: yesterday,
        punchesMoved: moving.length,
      });
    }
  }

  return {
    employeesScanned: byEmployee.size,
    daysScanned: candidates.length,
    moved,
  };
}
