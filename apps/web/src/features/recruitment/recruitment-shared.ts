import type { BadgeProps } from '@/components/ui/badge';
import type {
  CandidateStage,
  InterviewRecommendation,
  InterviewStatus,
  JobOpeningStatus,
  OfferStatus,
} from '@hrms/shared';

/**
 * Shared vocabulary for the recruitment screens.
 *
 * Two kinds of thing live here, and both are here for the same reason: a
 * candidate at SHORTLISTED has to look identical on the board, on the list, on
 * their profile and on the interview that was booked for them. A ternary
 * repeated in six files is how one screen ends up calling that amber and
 * another grey, which the reader then reads as a difference.
 *
 * The other kind is TIME, and it carries the single most important rule on
 * these screens: an interview is displayed in ITS OWN time zone, never the
 * browser's. The API stores an instant plus the zone it was booked in - see
 * `interviewCreateSchema`, which takes a day, two wall-clock times and a zone
 * for exactly this reason - and a coordinator working from home in another
 * country must be shown "10:00 in Karachi", not "10:00 converted to wherever
 * this laptop is". Every formatter below takes the zone as an argument and
 * none of them defaults to the machine's.
 */

type Tone = NonNullable<BadgeProps['variant']>;

/**
 * A vacancy's status, coloured by whether it is taking applications.
 *
 * OPEN is the only one that is, so it is the only one with the primary colour.
 * ON_HOLD is amber because it is a decision somebody has to come back to;
 * DRAFT, CLOSED and CANCELLED are all grey because none of them is asking
 * anything of the reader - one has not started and two are over.
 */
export const JOB_OPENING_STATUS_TONE: Record<JobOpeningStatus, Tone> = {
  DRAFT: 'neutral',
  OPEN: 'primary',
  ON_HOLD: 'warning',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
};

/**
 * A candidate's stage.
 *
 * The pipeline stages get no colour until the end of it. Painting NEW,
 * SCREENING, SHORTLISTED and INTERVIEW four different colours would turn a
 * board into a rainbow in which nothing stands out, and the column the card is
 * sitting in already says the stage. What is coloured is the three ANSWERS -
 * hired, rejected, withdrawn - because those are the rows a reader scanning a
 * list is actually looking for.
 */
export const CANDIDATE_STAGE_TONE: Record<CandidateStage, Tone> = {
  NEW: 'neutral',
  SCREENING: 'neutral',
  SHORTLISTED: 'neutral',
  INTERVIEW: 'primary',
  SELECTED: 'primary',
  OFFER: 'warning',
  HIRED: 'success',
  REJECTED: 'destructive',
  WITHDRAWN: 'neutral',
};

/**
 * An interview's status, coloured by whether anybody still has to do something.
 *
 * SCHEDULED is amber and CONFIRMED is not: the difference between them is
 * precisely "somebody has not answered yet", and that is the one thing a
 * coordinator scanning tomorrow's list needs to see. NO_SHOW is destructive
 * because it is a fact about a candidate that changes what happens next.
 */
export const INTERVIEW_STATUS_TONE: Record<InterviewStatus, Tone> = {
  SCHEDULED: 'warning',
  CONFIRMED: 'primary',
  COMPLETED: 'success',
  RESCHEDULED: 'warning',
  CANCELLED: 'neutral',
  NO_SHOW: 'destructive',
};

export const OFFER_STATUS_TONE: Record<OfferStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'destructive',
  EXPIRED: 'neutral',
};

/**
 * A recommendation.
 *
 * Coloured, because unlike a stage this IS an opinion and the reader is
 * comparing several of them side by side. What the colour must not do is turn
 * into arithmetic: nothing anywhere in this module averages recommendations,
 * ranks candidates by them or moves a stage because of one.
 */
export const RECOMMENDATION_TONE: Record<InterviewRecommendation, Tone> = {
  STRONG_YES: 'success',
  YES: 'success',
  MAYBE: 'warning',
  NO: 'destructive',
};

// --------------------------------------------------------------------- time

/**
 * A formatter, built once per (zone, options) pair.
 *
 * `Intl.DateTimeFormat` is expensive enough that constructing one per table
 * row is visible on a month calendar. An unknown zone throws on construction -
 * the zone is a string from the database - so the fallback is the browser's,
 * which is wrong but is still a time rather than a crashed page.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string | null, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timezone ?? 'local'}|${JSON.stringify(options)}`;
  const cached = formatters.get(key);
  if (cached) return cached;

  let built: Intl.DateTimeFormat;
  try {
    built = new Intl.DateTimeFormat(undefined, { ...options, timeZone: timezone ?? undefined });
  } catch {
    built = new Intl.DateTimeFormat(undefined, options);
  }
  formatters.set(key, built);
  return built;
}

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `10:00 am`, in the interview's own zone. */
export function interviewTime(value: string | null | undefined, timezone: string | null): string {
  const date = parse(value);
  if (!date) return '--';
  return formatter(timezone, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/** `Thu 18 Sep`, in the interview's own zone. */
export function interviewDay(value: string | null | undefined, timezone: string | null): string {
  const date = parse(value);
  if (!date) return '--';
  return formatter(timezone, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

/** `18 September 2026`, for a heading where the year matters. */
export function interviewLongDay(value: string | null | undefined, timezone: string | null): string {
  const date = parse(value);
  if (!date) return '--';
  return formatter(timezone, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/**
 * `10:00 am - 11:00 am`, both ends in the same zone.
 *
 * The zone itself is NOT appended here. It belongs beside the date on a detail
 * screen, where there is room to say it once, rather than repeated on every
 * row of a list where it is the same for all of them.
 */
export function interviewRange(
  startsAt: string,
  endsAt: string,
  timezone: string | null,
): string {
  return `${interviewTime(startsAt, timezone)} - ${interviewTime(endsAt, timezone)}`;
}

/**
 * The zone as a person reads it: `PKT`, or the raw name when the runtime has
 * no short form for it. Shown wherever a time is, because "10:00" without it
 * is the ambiguity this whole arrangement exists to remove.
 */
export function zoneLabel(value: string | null | undefined, timezone: string | null): string {
  const date = parse(value) ?? new Date();
  if (!timezone) return '';
  try {
    const parts = formatter(timezone, {
      hour: 'numeric',
      timeZoneName: 'short',
    }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

/**
 * An instant broken back into the three parts the scheduling form holds.
 *
 * The reschedule form is prefilled from an existing interview, and prefilling
 * it from `toISOString().slice(11, 16)` would put UTC in a field labelled
 * "start time" - the bug this module's day/time/zone split exists to prevent.
 * So the parts are read back in the interview's OWN zone.
 */
export function splitInZone(
  value: string,
  timezone: string | null,
): { day: string; time: string } {
  const date = parse(value);
  if (!date) return { day: '', time: '' };

  // `en-CA` yields `2026-09-18`, which is what a date input wants, and
  // `hourCycle: 'h23'` yields `09:05` rather than `9:05 AM` or a `24:00`.
  const day = formatter(timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

  const time = formatter(timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

  const hour = time.hour === '24' ? '00' : (time.hour ?? '00');

  return {
    day: `${day.year}-${day.month}-${day.day}`,
    time: `${hour}:${time.minute ?? '00'}`,
  };
}

/** Today in a given zone, as `yyyy-MM-dd` - the calendar's anchor day. */
export function todayIn(timezone: string | null): string {
  return splitInZone(new Date().toISOString(), timezone).day;
}

/** Shifts a `yyyy-MM-dd` by whole days without going near a time zone. */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  // UTC arithmetic on a date-only value: there is no instant here to shift, so
  // there is no zone to get wrong, and no daylight-saving hour to lose.
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return shifted.toISOString().slice(0, 10);
}

/** Adds minutes to an `HH:mm`, for the end time a start time implies. */
export function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return time;
  }
  const total = (hour * 60 + minute + minutes) % (24 * 60);
  const wrapped = total < 0 ? total + 24 * 60 : total;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// -------------------------------------------------------------------- money

/**
 * Money, whole units.
 *
 * No decimals anywhere in recruitment, deliberately: these are advertised
 * ranges and proposed salaries, which are round numbers somebody negotiated,
 * not payroll figures that have to reconcile to the cent. Payroll has its own
 * formatter and this is not it.
 */
export function money(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const code = currency ?? 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${code} ${Math.round(value).toLocaleString()}`;
  }
}

/** A salary range, which is often half-open - "from 250,000" is a real offer. */
export function salaryRange(
  min: number | null,
  max: number | null,
  currency: string | null,
): string {
  if (min === null && max === null) return 'Not stated';
  if (min !== null && max === null) return `From ${money(min, currency)}`;
  if (min === null && max !== null) return `Up to ${money(max, currency)}`;
  return `${money(min, currency)} - ${money(max, currency)}`;
}

/** Years of experience, where none stated and zero are different answers. */
export function experience(years: number | null | undefined): string {
  if (years === null || years === undefined) return 'Not stated';
  if (years === 0) return 'No experience required';
  return `${years}+ year${years === 1 ? '' : 's'}`;
}

/** A file size a person can read, in the decimal units their OS showed them. */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/**
 * The query key every recruitment screen invalidates from.
 *
 * One root, because the records are genuinely entangled: scheduling an
 * interview changes the dashboard's count, the candidate's interview list and
 * the calendar, and a mutation that had to name all three would eventually
 * forget one. Invalidating the root refetches only what is mounted.
 */
export const RECRUITMENT_KEY = ['recruitment'] as const;
