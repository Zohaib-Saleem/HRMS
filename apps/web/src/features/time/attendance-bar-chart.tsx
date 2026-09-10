import * as React from 'react';
import type { AttendanceDailyTotal } from '@hrms/shared';
import { cn } from '@/lib/utils';
import { minutesLabel, timeLabel } from './attendance-ui';

/**
 * The monthly attendance bar chart.
 *
 * Drawn by hand, like the dashboard's charts and for the same reason: a column
 * of stacked divs is a few lines of CSS, and neither shape here is worth a
 * dependency the rest of the app would have to carry.
 *
 * Three rules the chart is built on, all of which exist to keep it honest:
 *
 *   1. Bar height is worked time and nothing else. The three segments are
 *      disjoint parts of the same worked minutes - the server splits them, and
 *      they sum to the total - so a column is never taller than the hours
 *      somebody actually worked. Overtime in particular is carved OUT of
 *      worked time rather than piled on top of it, because that is what
 *      overtime is: a label on part of the day.
 *
 *   2. Late minutes are not drawn as height. They are time missed at the start
 *      of a shift - time NOT worked - so adding them to a bar would draw hours
 *      nobody was there for. The yellow segment is the ordinary worked time
 *      contributed by days that carried the LATE flag; the late minutes
 *      themselves are a figure in the tooltip and a summary card.
 *
 *   3. A day nobody worked has no height to give it, so it is drawn as a state
 *      marker in its own colour instead of as a zero-height nothing. The
 *      ribbon under every column carries the same information for mixed days:
 *      who was present, absent, on leave, on holiday or off.
 *
 * Colours are the `--att-*` tokens the calendar, the badges and the table
 * already use, so one status is one colour everywhere in the module.
 */

/** The three parts of worked time, in stacking order from the axis up. */
const WORK_SERIES = [
  {
    key: 'onTimeMinutes',
    label: 'On time',
    color: 'var(--att-present-border)',
    hint: 'Worked time on days that were not late',
  },
  {
    key: 'lateWorkedMinutes',
    label: 'Late arrival',
    color: 'var(--att-half-day-border)',
    hint: 'Worked time on days flagged late',
  },
  {
    key: 'overtimeMinutes',
    label: 'Overtime',
    /**
     * Its own hue, not the red of absence.
     *
     * Overtime is time somebody worked; absence is time nobody did. Drawing
     * them in the same colour made the tallest, best-attended columns look
     * like the worst ones.
     */
    color: 'var(--att-overtime-border)',
    hint: 'The overtime portion of worked time',
  },
] as const satisfies ReadonlyArray<{
  key: keyof AttendanceDailyTotal;
  label: string;
  color: string;
  hint: string;
}>;

/** Headcount states for the ribbon, in the order they stack left to right. */
const STATE_SERIES = [
  { key: 'present', label: 'Present', color: 'var(--att-present-border)' },
  { key: 'halfDay', label: 'Half day', color: 'var(--att-half-day-border)' },
  { key: 'absent', label: 'Absent', color: 'var(--att-absent-border)' },
  { key: 'onLeave', label: 'On leave', color: 'var(--att-leave-border)' },
  { key: 'holiday', label: 'Holiday', color: 'var(--att-holiday-border)' },
  { key: 'weekend', label: 'Weekend', color: 'var(--att-weekend-border)' },
  { key: 'offDay', label: 'Off day', color: 'var(--att-weekend-border)' },
] as const satisfies ReadonlyArray<{
  key: keyof AttendanceDailyTotal;
  label: string;
  color: string;
}>;

/** Ticks a reader can actually reach on the y-axis: whole hours. */
function axisTicks(maxMinutes: number): number[] {
  if (maxMinutes <= 0) return [0];
  const maxHours = maxMinutes / 60;
  // Four gridlines at most, on a step that is a round number of hours.
  const rawStep = maxHours / 4;
  const step = [1, 2, 4, 8, 12, 24, 48, 96, 168, 336, 720].find((s) => s >= rawStep) ?? 720;
  const ticks: number[] = [];
  for (let h = 0; h <= maxHours + step / 2; h += step) ticks.push(h);
  return ticks;
}

const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`;

const dayNumber = (iso: string): string => iso.slice(8, 10).replace(/^0/, '');

const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** An unavailable figure reads as a dash. Never as a zero, which is a claim. */
const orDash = (value: string | null): string => value ?? '—';

interface ChartProps {
  days: AttendanceDailyTotal[];
  /** The date whose detail is open, highlighted in the chart. */
  selectedDate?: string | null;
  onSelectDate?: (date: string) => void;
  /** True when exactly one employee is in scope; changes the tooltip wording. */
  singleEmployee?: boolean;
  /** Who the single employee is, when there is one. Shown in the panel header. */
  employeeName?: string | null;
  loading?: boolean;
}

export function AttendanceBarChart({
  days,
  selectedDate = null,
  onSelectDate,
  singleEmployee = false,
  employeeName = null,
  loading = false,
}: ChartProps) {
  /**
   * Which day the panel below is describing.
   *
   * Hover sets it with a pointer and focus sets it from the keyboard, but
   * neither exists on a phone: iOS does not reliably focus a button on tap and
   * there is no hover state to leave. So the panel falls back to the SELECTED
   * day, which a tap always sets - tapping a bar shows its figures, and they
   * stay on screen instead of vanishing the moment the finger lifts.
   *
   * No figure here is reachable only by hovering: the day detail table below
   * the chart repeats all of it. This is the fast path, not the only one.
   */
  const [hovered, setHovered] = React.useState<string | null>(null);
  const shown = hovered ?? selectedDate;

  const maxWorked = Math.max(0, ...days.map((d) => d.workedMinutes));
  const ticks = axisTicks(maxWorked);
  const axisTop = Math.max(ticks[ticks.length - 1] ?? 1, 1) * 60;
  const activeDay = days.find((d) => d.date === shown) ?? null;

  /**
   * The narrowest a column may be drawn.
   *
   * A month squeezed into a phone gives each day about eight pixels, which is
   * too narrow to read, too narrow to aim at, and too narrow to carry its own
   * date. Below this width the plot scrolls sideways instead - the axis stays
   * put, the columns keep a usable size, and every day keeps its label.
   */
  const MIN_COLUMN = 22;
  const GAP = days.length > 16 ? 3 : 4;
  const trackWidth = days.length * MIN_COLUMN + (days.length - 1) * GAP;

  if (loading) {
    return (
      <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-label="Loading chart" />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2 sm:gap-3">
        {/*
          The y axis sits OUTSIDE the scroller on purpose. A scale that slides
          away with the bars stops being a scale, and on a phone it would be
          off screen for most of the month.
        */}
        <div className="relative w-9 shrink-0 sm:w-10" style={{ height: 224 }} aria-hidden>
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

        {/*
          Scrolls only when it has to. `min-width` on the track means a desktop
          card wider than the track draws the whole month at once with no
          scrollbar, and a phone scrolls a month of readable columns rather
          than showing thirty slivers.
        */}
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain pb-1">
          <div className="relative" style={{ minWidth: trackWidth }}>
            {/* Gridlines, one shade off the surface so they never compete. */}
            <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: 224 }}>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute h-px w-full bg-chart-grid"
                  style={{ bottom: `${((tick * 60) / axisTop) * 100}%` }}
                />
              ))}
            </div>

            <div
              className="relative flex items-end"
              style={{ height: 224, gap: GAP }}
              role="list"
              aria-label="Worked hours per day"
            >
              {days.map((day) => (
                <DayColumn
                  key={day.date}
                  day={day}
                  axisTop={axisTop}
                  minWidth={MIN_COLUMN}
                  selected={day.date === selectedDate}
                  onSelect={onSelectDate}
                  onHover={setHovered}
                />
              ))}
            </div>

            {/* The state ribbon: who was in what state, on the same axis. */}
            <div className="mt-1 flex" style={{ gap: GAP }}>
              {days.map((day) => (
                <StateRibbon key={day.date} day={day} minWidth={MIN_COLUMN} />
              ))}
            </div>

            {/*
              X axis. Every day carries its own number - that is what the
              minimum column width buys, and thinning the labels was only ever
              a workaround for columns too narrow to hold one.
            */}
            <div className="mt-1.5 flex" style={{ gap: GAP }}>
              {days.map((day) => (
                <span
                  key={day.date}
                  className={cn(
                    'tabular flex-1 truncate text-center text-[10px] leading-none sm:text-[10.5px]',
                    day.date === selectedDate
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground',
                  )}
                  style={{ minWidth: MIN_COLUMN }}
                >
                  {dayNumber(day.date)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <DayTooltip
        day={activeDay}
        singleEmployee={singleEmployee}
        employeeName={employeeName}
        opened={activeDay !== null && activeDay.date === selectedDate}
      />
    </div>
  );
}

interface ColumnProps {
  day: AttendanceDailyTotal;
  axisTop: number;
  /** Never drawn narrower than this; the plot scrolls instead. */
  minWidth: number;
  selected: boolean;
  onSelect?: ((date: string) => void) | undefined;
  onHover: (date: string | null) => void;
}

function DayColumn({ day, axisTop, minWidth, selected, onSelect, onHover }: ColumnProps) {
  const segments = WORK_SERIES.map((series) => ({
    ...series,
    value: day[series.key] as number,
  })).filter((segment) => segment.value > 0);

  /**
   * The accessible name for the column.
   *
   * Every figure the tooltip shows is in here too, so the chart is usable by
   * anyone who cannot see the colours or reach a hover state.
   */
  const label = [
    longDate(day.date),
    day.workedMinutes > 0 ? `${hours(day.workedMinutes)} worked` : 'no hours worked',
    ...segments.map((s) => `${s.label} ${hours(s.value)}`),
    day.lateMinutes > 0 ? `${day.lateMinutes} minutes late` : '',
    day.earlyLeaveMinutes > 0 ? `${day.earlyLeaveMinutes} minutes early leave` : '',
    day.present > 0 ? `${day.present} present` : '',
    day.absent > 0 ? `${day.absent} absent` : '',
    day.onLeave > 0 ? `${day.onLeave} on leave` : '',
    day.dayState !== 'WORKING' ? DAY_STATE_LABEL[day.dayState] : '',
  ]
    .filter(Boolean)
    .join(', ');

  const interactive = onSelect !== undefined;

  return (
    <div
      role="listitem"
      className={cn(
        'group relative flex h-full flex-1 flex-col-reverse justify-start rounded-t-[3px]',
        selected && 'bg-accent/45',
      )}
      style={{ minWidth }}
    >
      {/*
        The whole column is one hit target, floor to ceiling, not just the
        coloured part of it. A three-pixel weekend marker is impossible to tap
        on a phone; the full-height button is comfortably reachable and is what
        makes every day selectable regardless of how tall its bar is.
      */}
      <button
        type="button"
        className={cn(
          'absolute inset-0 z-10 rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          interactive ? 'cursor-pointer' : 'cursor-default',
        )}
        aria-label={label}
        aria-pressed={interactive ? selected : undefined}
        onClick={() => onSelect?.(day.date)}
        onMouseEnter={() => onHover(day.date)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(day.date)}
        onBlur={() => onHover(null)}
      />

      {segments.length === 0 ? (
        /**
         * Nothing was worked. Rather than a zero-height column - which reads
         * as a rendering fault - the day is drawn as a marker in the colour of
         * whatever it was: a weekend, a holiday, leave, an absence, or a date
         * that has not arrived yet.
         */
        <EmptyDayMarker day={day} />
      ) : (
        segments.map((segment, index) => (
          <div
            key={segment.key}
            className={cn(
              'w-full transition-opacity group-hover:opacity-85',
              index === segments.length - 1 ? 'rounded-t-[3px]' : '',
            )}
            style={{
              height: `${(segment.value / axisTop) * 100}%`,
              backgroundColor: segment.color,
              minHeight: 2,
            }}
          />
        ))
      )}
    </div>
  );
}

const DAY_STATE_LABEL: Record<AttendanceDailyTotal['dayState'], string> = {
  WORKING: 'Working day',
  WEEKEND: 'Weekend',
  HOLIDAY: 'Holiday',
  OFF_DAY: 'Off day',
  UPCOMING: 'Upcoming',
};

/**
 * A day with no worked time.
 *
 * Dashed and empty for a date that has not arrived - nobody has failed to
 * attend a day that has not happened, and it must never read as a mark against
 * anyone. Otherwise a short bar in the colour of the day's dominant state, tall
 * enough to see and short enough that it cannot be mistaken for hours.
 */
function EmptyDayMarker({ day }: { day: AttendanceDailyTotal }) {
  if (day.dayState === 'UPCOMING' || day.employeeCount === 0) {
    return (
      <div
        className="w-full rounded-t-[3px] border border-dashed border-att-upcoming-border"
        style={{ height: 10 }}
      />
    );
  }

  /**
   * On a working day with no hours, the marker is whatever most of the day
   * actually was - and that is often "present".
   *
   * Today is the case that matters: everyone has checked in and nobody has
   * checked out, so there are no worked minutes yet and every one of those
   * days is PRESENT. Reaching for red because the bar is empty would paint the
   * current day as mass absence every morning.
   */
  const attended = day.present + day.halfDay;
  const dominant = Math.max(attended, day.absent, day.onLeave);
  const color =
    day.dayState === 'HOLIDAY'
      ? 'var(--att-holiday-border)'
      : day.dayState === 'WEEKEND' || day.dayState === 'OFF_DAY'
        ? 'var(--att-weekend-border)'
        : dominant === 0
          ? 'var(--att-weekend-border)'
          : dominant === attended
            ? 'var(--att-present-border)'
            : dominant === day.onLeave
              ? 'var(--att-leave-border)'
              : 'var(--att-absent-border)';

  return (
    <div className="w-full rounded-t-[3px]" style={{ height: 8, backgroundColor: color }} />
  );
}

/**
 * The headcount ribbon under each column.
 *
 * The bar above answers "how many hours?"; this answers "and what was everyone
 * else doing?". Absence, leave and holiday have no hours to contribute, so
 * without this they would be invisible on a chart of worked time.
 *
 * With a single employee selected the ribbon is one solid block - that person's
 * status for the day - which is exactly the right reading.
 */
function StateRibbon({ day, minWidth }: { day: AttendanceDailyTotal; minWidth: number }) {
  const total = day.employeeCount;

  if (total === 0) {
    return (
      <div
        className="h-1.5 flex-1 rounded-full bg-transparent"
        style={{ minWidth }}
        aria-hidden
      />
    );
  }

  const parts = STATE_SERIES.map((series) => ({
    ...series,
    value: day[series.key] as number,
  })).filter((part) => part.value > 0);

  return (
    <div
      className={cn(
        'flex h-1.5 flex-1 overflow-hidden rounded-full',
        day.dayState === 'UPCOMING' && 'border border-dashed border-att-upcoming-border',
      )}
      style={{ minWidth }}
      aria-hidden
    >
      {parts.map((part) => (
        <span
          key={part.key}
          style={{ width: `${(part.value / total) * 100}%`, backgroundColor: part.color }}
        />
      ))}
    </div>
  );
}

/**
 * The figures for the hovered or focused day.
 *
 * A fixed panel under the chart rather than a floating box: on a phone there is
 * nowhere for a floating tooltip to go, and a panel that never moves is easier
 * to read than one that follows a finger. Every value it can show is listed
 * even when unavailable, printed as an em dash, so a missing check-out reads as
 * missing rather than as absent from the panel.
 */
function DayTooltip({
  day,
  singleEmployee,
  employeeName,
  opened,
}: {
  day: AttendanceDailyTotal | null;
  singleEmployee: boolean;
  employeeName: string | null;
  /** True when this day's per-employee detail is already open below. */
  opened: boolean;
}) {
  if (!day) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        Tap or hover a bar for that day&apos;s figures.
      </p>
    );
  }

  const statuses = STATE_SERIES.map((s) => ({ ...s, value: day[s.key] as number })).filter(
    (s) => s.value > 0,
  );

  return (
    <div
      className="rounded-lg border border-border bg-surface-muted/60 px-3 py-2.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-semibold">
          {longDate(day.date)}
          {/*
            Whose day it is, when the answer is one person. With several people
            in scope no single name is true of the column, so the panel says how
            many instead and the day detail table below names them one by one.
          */}
          {singleEmployee && employeeName ? (
            <span className="ml-2 font-normal text-muted-foreground">{employeeName}</span>
          ) : null}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {day.holidayName ??
            (day.dayState === 'WORKING' ? 'Working day' : DAY_STATE_LABEL[day.dayState])}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
        <Figure
          label={singleEmployee ? 'Status' : 'Employees'}
          value={
            singleEmployee
              ? (statuses[0]?.label ?? '—')
              : day.employeeCount > 0
                ? String(day.employeeCount)
                : '—'
          }
        />
        <Figure
          label="Present"
          value={day.employeeCount > 0 ? `${day.present + day.halfDay}` : '—'}
          hint={day.halfDay > 0 ? `incl. ${day.halfDay} half` : undefined}
        />
        <Figure label="Worked" value={day.workedMinutes > 0 ? hours(day.workedMinutes) : '—'} />
        <Figure
          label="Expected"
          value={day.expectedMinutes > 0 ? hours(day.expectedMinutes) : '—'}
        />
        <Figure label="On time" value={day.onTimeMinutes > 0 ? hours(day.onTimeMinutes) : '—'} />
        <Figure
          label="Late"
          value={day.lateMinutes > 0 ? minutesLabel(day.lateMinutes) : '—'}
          hint={day.lateCount > 0 ? `over ${day.lateCount} day(s)` : undefined}
        />
        <Figure
          label="Early leave"
          value={day.earlyLeaveMinutes > 0 ? minutesLabel(day.earlyLeaveMinutes) : '—'}
        />
        <Figure
          label="Overtime"
          value={day.overtimeMinutes > 0 ? minutesLabel(day.overtimeMinutes) : '—'}
          hint={day.overtimeCount > 0 ? `over ${day.overtimeCount} day(s)` : undefined}
        />
        <Figure label="First in" value={orDash(day.firstCheckInAt && timeLabel(day.firstCheckInAt))} />
        <Figure
          label="Last out"
          value={orDash(day.lastCheckOutAt && timeLabel(day.lastCheckOutAt))}
        />
        {day.absent > 0 ? <Figure label="Absent" value={String(day.absent)} /> : null}
        {day.onLeave > 0 ? <Figure label="On leave" value={String(day.onLeave)} /> : null}
        {day.halfDay > 0 ? <Figure label="Half day" value={String(day.halfDay)} /> : null}
      </dl>

      {/*
        Shift is a property of a person's day, not of the column: on a mixed day
        there are as many shifts as there are rosters. The day detail table
        below names the shift per employee, so the panel points at it rather
        than inventing a single answer.
      */}
      <p className="mt-2 text-[11.5px] text-muted-foreground">
        {opened
          ? 'Every employee on this day is listed below, with their shift, check-in and check-out.'
          : 'Select the bar to list every employee on this day with their shift, check-in and check-out.'}
      </p>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="tabular truncate text-[13px] font-medium">
        {value}
        {hint ? <span className="ml-1 text-[11px] text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The legend, which doubles as the key to both rows of the chart.
 *
 * Split in two because the chart carries two different quantities: the bar is
 * time, the ribbon is people. Labelling them together would invite the reader
 * to think the purple in the ribbon has a height somewhere.
 */
export function AttendanceChartLegend() {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:gap-x-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Hours
        </span>
        {WORK_SERIES.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5" title={series.hint}>
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: series.color }}
              aria-hidden
            />
            <span className="text-[12px] text-muted-foreground">{series.label}</span>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Days
        </span>
        {STATE_SERIES.filter((s) => s.key !== 'offDay').map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ backgroundColor: series.color }}
              aria-hidden
            />
            <span className="text-[12px] text-muted-foreground">{series.label}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px] border border-dashed border-att-upcoming-border"
            aria-hidden
          />
          <span className="text-[12px] text-muted-foreground">Upcoming</span>
        </span>
      </div>
    </div>
  );
}
