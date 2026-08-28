/**
 * Timezone-aware day and clock arithmetic.
 *
 * Everything is stored in UTC and always has been. What was missing is that
 * attendance was also *reasoned* about in UTC: a shift starting at "09:00" was
 * compared against 09:00 UTC, and the attendance day ran from UTC midnight. On
 * a company in Asia/Karachi that is five hours wrong in both directions - an
 * 08:56 arrival looked like a four-hour early start, and a 02:00 local punch
 * landed on the previous day.
 *
 * These helpers convert between an instant (a UTC `Date`) and the wall clock a
 * company actually works to. They are deliberately dependency-free: `Intl`
 * already carries the IANA database, so pulling in a date library to ask what
 * the offset is would be adding a dependency to avoid twenty lines.
 */

/** A calendar day in a particular zone, as `YYYY-MM-DD`. */
export type DayKey = string;

const PARTS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = PARTS.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS.set(timeZone, dtf);
  }
  return dtf;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading a zone shows at a given instant. */
function wallClock(instant: Date, timeZone: string): Wall {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Minutes the zone is ahead of UTC at a given instant.
 *
 * Derived by asking the zone what time it is and comparing, which is what makes
 * this work for zones with daylight saving without shipping a rules table.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/** Whether a string is an IANA zone this runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day an instant falls on, in the given zone. */
export function dayKeyInZone(instant: Date, timeZone: string): DayKey {
  const w = wallClock(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * The instant at which a wall-clock time occurs in a zone.
 *
 * Two passes: guess using the offset at the naive instant, then re-check using
 * the offset at the corrected instant. That second pass is what gets daylight
 * saving right, where the offset before and after the guess differ.
 *
 * Ambiguous local times - the hour that repeats when clocks go back - resolve
 * to the first occurrence, and skipped times to the instant just after the
 * jump. Both are deterministic, which matters more here than which side of a
 * one-hour fold a punch lands on.
 */
export function instantInZone(
  dayKey: DayKey,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Not a calendar day: ${dayKey}`);
  }

  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  const firstGuess = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
  const corrected = new Date(naive - zoneOffsetMinutes(firstGuess, timeZone) * 60_000);
  return corrected;
}

/** Parses "HH:mm" into hours and minutes, or null if it is not a clock time. */
export function parseClock(hhmm: string | null | undefined): { hour: number; minute: number } | null {
  if (!hhmm) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The instant a "HH:mm" boundary falls on a given local day. */
export function clockBoundary(dayKey: DayKey, hhmm: string, timeZone: string): Date | null {
  const clock = parseClock(hhmm);
  if (!clock) return null;
  return instantInZone(dayKey, clock.hour, clock.minute, timeZone);
}

/** Midnight-to-midnight in the zone, as UTC instants. `to` is exclusive. */
export function dayBoundsInZone(dayKey: DayKey, timeZone: string): { from: Date; to: Date } {
  const from = instantInZone(dayKey, 0, 0, timeZone);
  const [y, m, d] = dayKey.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d!) + 86_400_000);
  const nextKey = next.toISOString().slice(0, 10);
  return { from, to: instantInZone(nextKey, 0, 0, timeZone) };
}

/** Today's calendar day in the given zone. */
export function todayInZone(timeZone: string, now = new Date()): DayKey {
  return dayKeyInZone(now, timeZone);
}

/**
 * A `@db.Date` value for a local calendar day.
 *
 * Date columns hold no time, and the codebase pins them to UTC midnight so the
 * stored day never shifts with the server's own zone. This keeps that contract
 * while letting the *choice* of day come from the company's zone rather than
 * from UTC.
 */
export function dayKeyToDateColumn(dayKey: DayKey): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

/** The local day a `@db.Date` value represents. */
export function dateColumnToDayKey(value: Date): DayKey {
  return value.toISOString().slice(0, 10);
}
