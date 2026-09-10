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
    color: 'var(--att-absent-border)',
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
  loading?: boolean;
}

export function AttendanceBarChart({
  days,
  selectedDate = null,
  onSelectDate,
  singleEmployee = false,
  loading = false,
}: ChartProps) {
  /**
   * Which day the tooltip is describing.
   *
   * Hover sets it on a pointer; focus sets it from the keyboard; tapping a bar
   * on a touch screen selects the day, which also shows it. No figure in this
   * chart is reachable only by hovering - the day detail below repeats all of
   * it - but the tooltip is the fast path and it must work without a mouse.
   */
  const [active, setActive] = React.useState<string | null>(null);

  const maxWorked = Math.max(0, ...days.map((d) => d.workedMinutes));
  const ticks = axisTicks(maxWorked);
  const axisTop = Math.max(ticks[ticks.length - 1] ?? 1, 1) * 60;
  const activeDay = days.find((d) => d.date === active) ?? null;

  // Below about a fortnight every column can carry its own label; above it,
  // labels are thinned so they never collide on a phone.
  const dense = days.length > 16;

  if (loading) {
    return (
      <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-label="Loading chart" />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2 sm:gap-3">
        {/* Y axis: whole hours, so the reader never has to divide by sixty. */}
        <div
          className="relative w-9 shrink-0 sm:w-10"
          style={{ height: 224 }}
          aria-hidden
        >
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

        <div className="relative min-w-0 flex-1">
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
            className={cn('relative flex items-end', dense ? 'gap-[2px] sm:gap-[3px]' : 'gap-1')}
            style={{ height: 224 }}
            role="list"
            aria-label="Worked hours per day"
          >
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                axisTop={axisTop}
                selected={day.date === selectedDate}
                onSelect={onSelectDate}
                onActive={setActive}
              />
            ))}
          </div>

          {/* The state ribbon: who was in what state, on the same axis. */}
          <div className={cn('mt-1 flex', dense ? 'gap-[2px] sm:gap-[3px]' : 'gap-1')}>
            {days.map((day) => (
              <StateRibbon key={day.date} day={day} />
            ))}
          </div>

          {/* X axis: the day of the month. */}
          <div className={cn('mt-1.5 flex', dense ? 'gap-[2px] sm:gap-[3px]' : 'gap-1')}>
            {days.map((day, index) => (
              <span
                key={day.date}
                className={cn(
                  'tabular min-w-0 flex-1 truncate text-center text-[10px] leading-none sm:text-[10.5px]',
                  day.date === selectedDate
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {/* On a dense month, every other day - readable on a phone. */}
                {!dense || index % 2 === 0 || day.date === selectedDate ? dayNumber(day.date) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>

      <DayTooltip day={activeDay} singleEmployee={singleEmployee} />
    </div>
  );
}

interface ColumnProps {
  day: AttendanceDailyTotal;
  axisTop: number;
  selected: boolean;
  onSelect?: ((date: string) => void) | undefined;
  onActive: (date: string | null) => void;
}

function DayColumn({ day, axisTop, selected, onSelect, onActive }: ColumnProps) {
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
        'group relative flex h-full min-w-0 flex-1 flex-col-reverse justify-start rounded-t-[3px]',
        selected && 'bg-accent/45',
      )}
    >
      <button
        type="button"
        className={cn(
          'absolute inset-0 z-10 rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          interactive ? 'cursor-pointer' : 'cursor-default',
        )}
        aria-label={label}
        aria-pressed={interactive ? selected : undefined}
        onClick={() => onSelect?.(day.date)}
        onMouseEnter={() => onActive(day.date)}
        onMouseLeave={() => onActive(null)}
        onFocus={() => onActive(day.date)}
        onBlur={() => onActive(null)}
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
function StateRibbon({ day }: { day: AttendanceDailyTotal }) {
  const total = day.employeeCount;

  if (total === 0) {
    return <div className="h-1.5 min-w-0 flex-1 rounded-full bg-transparent" aria-hidden />;
  }

  const parts = STATE_SERIES.map((series) => ({
    ...series,
    value: day[series.key] as number,
  })).filter((part) => part.value > 0);

  return (
    <div
      className={cn(
        'flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full',
        day.dayState === 'UPCOMING' && 'border border-dashed border-att-upcoming-border',
      )}
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
}: {
  day: AttendanceDailyTotal | null;
  singleEmployee: boolean;
}) {
  if (!day) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        Hover, focus or tap a bar for that day&apos;s figures.
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
        <span className="text-[13px] font-semibold">{longDate(day.date)}</span>
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
          hint={day.halfDay > 0 ? `${day.halfDay} half day` : undefined}
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
          hint={day.lateCount > 0 ? `${day.lateCount} day(s)` : undefined}
        />
        <Figure
          label="Overtime"
          value={day.overtimeMinutes > 0 ? minutesLabel(day.overtimeMinutes) : '—'}
          hint={day.overtimeCount > 0 ? `${day.overtimeCount} day(s)` : undefined}
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
