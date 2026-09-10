import * as React from 'react';
import { CalendarClock } from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceDay,
} from '@hrms/shared';
import { cn, formatDate } from '@/lib/utils';
import { EmptyState } from '@/components/feedback/states';
import { minutesLabel, timeLabel } from './attendance-ui';

/**
 * One employee's month as bars: one vertical bar per day.
 *
 * Draws the days the calendar beside it already fetched from
 * `/attendance/summary` - the same request, the same month, the same employee.
 * There is no second query and no second derivation: every figure here was
 * produced by the attendance engine on the server, and this file only decides
 * how tall to draw it and what colour to paint it.
 *
 * Nothing in here knows what a working day is worth. No hour count, no grace
 * period, no late or half-day or overtime threshold appears in this file, and
 * none may be added: a company that moves from an eight-hour day to a nine-hour
 * one changes its policy, the engine re-scores the days, and these bars follow
 * without being touched. The only arithmetic performed here is a proportion -
 * this day's worked minutes against the tallest day on screen.
 *
 * Two rules keep the drawing honest.
 *
 *   1. Bar height is `workedMinutes` and nothing else. A day with no worked
 *      time has no height to give, so it is drawn as a short marker in the
 *      colour of whatever it was - absent, leave, holiday, weekend, not yet
 *      arrived - rather than as a zero-height nothing that reads as a bug.
 *
 *   2. Overtime is carved OUT of worked time, never stacked on top, because
 *      that is what overtime is: a label on part of the day. The bar is the
 *      hours somebody worked; the indigo cap says how many of them the engine
 *      counted as overtime.
 *
 * Colour comes from the status the engine assigned, with its own LATE flag
 * allowed to tint an otherwise ordinary present day. Nothing here re-derives a
 * status from times, thresholds or shift rules.
 */

/**
 * The narrowest a day may be drawn. NOT its width.
 *
 * Columns share the plot out between them - `flex: 1 1 0` each - so a month
 * fills whatever room the card gives it. This floor only decides when there is
 * no longer enough room to be legible, at which point the track stops shrinking
 * and scrolls sideways instead. Giving a column a fixed `width` here is what
 * previously pinned a 30-day month to 750px inside a 1500px card.
 *
 * 18, not 22, so that a 31-day month clears a tablet's content column without
 * scrolling: 31 columns and 30 gaps come to 648px against roughly 690px there.
 * On a phone the month scrolls whatever this is, and the hit target stays the
 * full height of the plot rather than the width of the bar.
 */
const MIN_COLUMN = 18;
const GAP = 3;
const PLOT_HEIGHT = 224;

interface BarDay {
  day: AttendanceDay;
  key: string;
}

/**
 * Was the day flagged late by the engine?
 *
 * `flags` is declared non-optional and the API always sends it, but this chart
 * draws whatever the endpoint returns and a missing array must not take the
 * page down over a tint. The question is only ever asked of the engine's own
 * flag - lateness is never re-derived here from times or thresholds.
 */
const hasFlag = (day: AttendanceDay, flag: string): boolean =>
  (day.flags ?? []).includes(flag as never);

/**
 * The colour a bar takes.
 *
 * Status first, because a day that was not worked is not a late day or an
 * on-time day - it is an absence, a holiday, a weekend. Only once the day is
 * known to have been worked does lateness get to tint it.
 */
export function barColor(day: AttendanceDay): string {
  switch (day.status) {
    case 'ABSENT':
      return 'var(--att-absent-border)';
    case 'ON_LEAVE':
      return 'var(--att-leave-border)';
    case 'HOLIDAY':
      return 'var(--att-holiday-border)';
    case 'WEEKEND':
    case 'OFF_DAY':
      return 'var(--att-weekend-border)';
    case 'UPCOMING':
      return 'transparent';
    case 'HALF_DAY':
      return 'var(--att-half-day-border)';
    case 'PRESENT':
      return hasFlag(day, 'LATE') ? 'var(--att-half-day-border)' : 'var(--att-present-border)';
    default:
      // A status the engine grew that this file has not been taught yet reads
      // as neutral rather than as an absence.
      return 'var(--att-weekend-border)';
  }
}

/** What the bar is called in the legend and the detail panel. */
export function barMeaning(day: AttendanceDay): string {
  if (day.status === 'PRESENT' && hasFlag(day, 'LATE')) return 'Late';
  return DERIVED_ATTENDANCE_STATUS_LABELS[day.status] ?? day.status;
}

/**
 * Ticks a reader can reach: whole hours.
 *
 * The top tick must COVER the tallest bar. Walking up from zero until the max
 * is passed does not guarantee that - a nine-hour day against a four-hour step
 * stops at eight, and the bar is then drawn at 112% of a plot it cannot leave.
 * Rounding the maximum up to the step first is what makes the axis a scale
 * rather than a suggestion.
 *
 * The candidate steps are units of clock time, not a statement about the
 * working day: whichever the data reaches is the one used.
 */
export function axisTicks(maxMinutes: number): number[] {
  if (maxMinutes <= 0) return [0];
  const maxHours = maxMinutes / 60;
  const step = [1, 2, 4, 8, 12, 24].find((s) => s >= maxHours / 4) ?? 24;
  const top = Math.max(step, Math.ceil(maxHours / step) * step);
  const ticks: number[] = [];
  for (let h = 0; h <= top + 1e-9; h += step) ticks.push(h);
  return ticks;
}

const dayNumber = (iso: string): string => iso.slice(8, 10).replace(/^0/, '');

/** A null figure is a dash, never a zero - a zero is a claim. */
const orDash = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '--' : value;

export function EmployeeAttendanceBars({
  days,
  employeeName,
  loading = false,
}: {
  days: AttendanceDay[];
  employeeName: string;
  loading?: boolean;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  // A day that arrives without a date cannot be placed on an axis, and a null
  // entry in the array is not worth a crash.
  const bars = React.useMemo<BarDay[]>(
    () => (days ?? []).filter((day) => day?.date).map((day) => ({ day, key: day.date })),
    [days],
  );

  // The month changing under a selection must not leave a stale day on screen.
  const keys = bars.map((b) => b.key).join('|');
  React.useEffect(() => {
    setSelected(null);
    setHovered(null);
  }, [keys]);

  const shownKey = hovered ?? selected;
  const shown = bars.find((b) => b.key === shownKey) ?? null;

  const maxWorked = Math.max(0, ...bars.map((b) => b.day.workedMinutes ?? 0));
  const ticks = axisTicks(maxWorked);
  // Never zero: an all-absent month still needs an axis to draw against.
  const axisTop = Math.max(ticks[ticks.length - 1] ?? 1, 1) * 60;

  if (loading) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-label="Loading chart" />;
  }

  if (bars.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="Nothing to chart"
        description="No attendance days in this month. Try another month with the arrows above."
      />
    );
  }

  // The width below which the plot scrolls rather than shrinks: every column at
  // its floor, plus the gaps between them.
  const trackWidth = bars.length * MIN_COLUMN + Math.max(0, bars.length - 1) * GAP;

  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2 sm:gap-3">
        {/* The axis sits outside the scroller: a scale that slides away is not a scale. */}
        <div className="relative w-9 shrink-0 sm:w-10" style={{ height: PLOT_HEIGHT }} aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className="tabular absolute right-0 -translate-y-1/2 text-[10.5px] leading-none text-muted-foreground"
              style={{ bottom: `${((tick * 60) / axisTop) * 100}%` }}
            >
              {tick}h
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain pb-1">
          <div className="relative w-full" style={{ minWidth: trackWidth }}>
            <div
              className="pointer-events-none absolute inset-x-0 top-0"
              style={{ height: PLOT_HEIGHT }}
            >
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute h-px w-full bg-chart-grid"
                  style={{ bottom: `${((tick * 60) / axisTop) * 100}%` }}
                />
              ))}
            </div>

            <div
              className="relative flex w-full items-end"
              style={{ height: PLOT_HEIGHT, gap: GAP }}
              role="list"
              aria-label={`Worked hours per day for ${employeeName}`}
            >
              {bars.map((bar) => (
                <BarColumn
                  key={bar.key}
                  bar={bar}
                  employeeName={employeeName}
                  axisTop={axisTop}
                  selected={bar.key === selected}
                  onHover={setHovered}
                  onSelect={(key) => setSelected((prev) => (prev === key ? null : key))}
                />
              ))}
            </div>

            {/* The x axis: the day of the month under each bar. */}
            <div className="mt-1.5 flex w-full" style={{ gap: GAP }}>
              {bars.map((bar) => (
                <span
                  key={bar.key}
                  className={cn(
                    'tabular text-center text-[10px] leading-none sm:text-[10.5px]',
                    bar.key === selected
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground',
                  )}
                  style={{ minWidth: MIN_COLUMN, flex: '1 1 0' }}
                >
                  {dayNumber(bar.day.date)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <BarDetail bar={shown} employeeName={employeeName} />
      <BarsLegend />
    </div>
  );
}

function BarColumn({
  bar,
  employeeName,
  axisTop,
  selected,
  onHover,
  onSelect,
}: {
  bar: BarDay;
  employeeName: string;
  axisTop: number;
  selected: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
}) {
  const { day } = bar;
  const worked = day.workedMinutes ?? 0;
  // Clamped to the day so a data oddity cannot draw a bar out of its own plot.
  const overtime = Math.min(day.overtimeMinutes ?? 0, worked);
  const base = Math.max(0, worked - overtime);
  const color = barColor(day);

  const label = [
    employeeName,
    formatDate(day.date),
    barMeaning(day),
    worked > 0 ? `${(worked / 60).toFixed(1)} hours worked` : 'no hours worked',
    day.lateMinutes ? `${day.lateMinutes} minutes late` : '',
    day.earlyLeaveMinutes ? `${day.earlyLeaveMinutes} minutes early leave` : '',
    overtime ? `${overtime} minutes overtime` : '',
    hasFlag(day, 'MISSING_PUNCH') ? 'missing punch' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      role="listitem"
      className={cn(
        'group relative flex h-full flex-col-reverse justify-start rounded-t-[3px]',
        selected && 'bg-accent/45',
      )}
      style={{ minWidth: MIN_COLUMN, flex: '1 1 0' }}
    >
      {/*
        The whole column is the hit target, floor to ceiling. A three-pixel
        weekend marker cannot be tapped on a phone; a full-height button can.
      */}
      <button
        type="button"
        className="absolute inset-0 z-10 cursor-pointer rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        aria-label={label}
        title={label}
        aria-pressed={selected}
        onClick={() => onSelect(bar.key)}
        onMouseEnter={() => onHover(bar.key)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(bar.key)}
        onBlur={() => onHover(null)}
      />

      {worked <= 0 ? (
        day.status === 'UPCOMING' ? (
          <div
            className="w-full rounded-t-[3px] border border-dashed border-att-upcoming-border"
            style={{ height: 10 }}
          />
        ) : (
          <div className="w-full rounded-t-[3px]" style={{ height: 8, backgroundColor: color }} />
        )
      ) : (
        <>
          <div
            className="w-full transition-opacity group-hover:opacity-85"
            style={{ height: `${(base / axisTop) * 100}%`, backgroundColor: color, minHeight: 2 }}
          />
          {overtime > 0 ? (
            <div
              className="w-full rounded-t-[3px] transition-opacity group-hover:opacity-85"
              style={{
                height: `${(overtime / axisTop) * 100}%`,
                backgroundColor: 'var(--att-overtime-border)',
                minHeight: 2,
              }}
            />
          ) : null}
        </>
      )}

      {/* A day the engine flagged as missing a punch gets a mark of its own:
          the height is honest but incomplete, and that is worth saying. */}
      {hasFlag(day, 'MISSING_PUNCH') ? (
        <span
          className="pointer-events-none absolute inset-x-0 -top-3 text-center text-[10px] font-bold leading-none text-att-absent-foreground"
          aria-hidden
        >
          !
        </span>
      ) : null}
    </div>
  );
}

/**
 * The figures for the hovered, focused or tapped bar.
 *
 * A panel under the chart rather than a floating box: on a phone there is
 * nowhere for a floating tooltip to go, and hover does not exist there at all.
 * Tapping a bar selects it, so the figures stay on screen instead of vanishing
 * when the finger lifts. Desktop also gets the same text as a native `title`
 * tooltip on the bar itself.
 *
 * Every field is listed even when unavailable, printed as a dash, so a missing
 * check-out reads as missing rather than as absent from the panel.
 */
function BarDetail({ bar, employeeName }: { bar: BarDay | null; employeeName: string }) {
  if (!bar) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        Hover a bar, or tap one on a phone, for that day&apos;s figures.
      </p>
    );
  }

  const { day } = bar;

  return (
    <div
      className="rounded-lg border border-border bg-surface-muted/60 px-3 py-2.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold">{employeeName}</span>
        <span className="text-[12px] text-muted-foreground">{formatDate(day.date)}</span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-5">
        <Figure label="Status" value={day.holidayName ?? day.leaveTypeName ?? barMeaning(day)} />
        <Figure label="Shift" value={day.shiftName ?? 'Unassigned'} />
        <Figure
          label="Check in"
          value={day.checkInAt ? timeLabel(day.checkInAt) : '--'}
        />
        <Figure
          label="Check out"
          value={
            day.checkOutAt
              ? timeLabel(day.checkOutAt)
              : hasFlag(day, 'MISSING_PUNCH')
                ? 'Missing'
                : '--'
          }
        />
        <Figure label="Worked" value={minutesLabel(day.workedMinutes)} />
        <Figure label="Late" value={day.lateMinutes ? minutesLabel(day.lateMinutes) : '--'} />
        <Figure
          label="Early leave"
          value={day.earlyLeaveMinutes ? minutesLabel(day.earlyLeaveMinutes) : '--'}
        />
        <Figure
          label="Overtime"
          value={day.overtimeMinutes ? minutesLabel(day.overtimeMinutes) : '--'}
        />
        <Figure label="Source" value={orDash(day.source)} />
      </dl>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular truncate text-[13px] font-medium">{value}</dd>
    </div>
  );
}

const LEGEND: Array<{ label: string; color: string }> = [
  { label: 'On time', color: 'var(--att-present-border)' },
  { label: 'Late / half day', color: 'var(--att-half-day-border)' },
  { label: 'Overtime', color: 'var(--att-overtime-border)' },
  { label: 'Absent', color: 'var(--att-absent-border)' },
  { label: 'On leave', color: 'var(--att-leave-border)' },
  { label: 'Holiday', color: 'var(--att-holiday-border)' },
  { label: 'Weekend / off', color: 'var(--att-weekend-border)' },
];

export function BarsLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3">
      {LEGEND.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px]"
            style={{ backgroundColor: item.color }}
            aria-hidden
          />
          <span className="text-[12px] text-muted-foreground">{item.label}</span>
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span
          className="size-2.5 rounded-[3px] border border-dashed border-att-upcoming-border"
          aria-hidden
        />
        <span className="text-[12px] text-muted-foreground">Upcoming</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-att-absent-foreground" aria-hidden>
          !
        </span>
        <span className="text-[12px] text-muted-foreground">Missing punch</span>
      </span>
    </div>
  );
}
