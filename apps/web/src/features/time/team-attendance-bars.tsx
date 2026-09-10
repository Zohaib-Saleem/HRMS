import * as React from 'react';
import { Users } from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  UNASSIGNED_TEAM_LABEL,
  type AttendanceDay,
  type TeamAttendanceRow,
} from '@hrms/shared';
import { cn, formatDate } from '@/lib/utils';
import { EmptyState } from '@/components/feedback/states';
import { minutesLabel, timeLabel } from './attendance-ui';

/**
 * Team attendance as bars: one vertical bar per employee per day.
 *
 * Reads the rows the table beside it already fetched from `/attendance/team` -
 * the same request, the same filters, the same data scope, the same page. There
 * is no second query and no second calculation: every figure here was derived
 * by the attendance engine on the server, and this only decides how tall to
 * draw it and what colour to paint it.
 *
 * Two rules keep it honest.
 *
 *   1. Bar height is `workedMinutes` and nothing else. A day with no worked
 *      time has no height to give, so it is drawn as a short marker in the
 *      colour of whatever it was - absent, leave, holiday, weekend, not yet
 *      arrived - rather than as a zero-height nothing that reads as a bug.
 *
 *   2. Overtime is carved OUT of worked time, never stacked on top, because
 *      that is what overtime is: a label on part of the day. The bar is the
 *      hours somebody worked; the indigo cap says how many of them counted as
 *      overtime.
 *
 * Colour comes from the status the engine assigned, with the LATE flag allowed
 * to tint an otherwise ordinary present day. Nothing here re-derives a status
 * from times, thresholds or shift rules.
 */

/** Never narrower than this; below it the plot scrolls sideways instead. */
const MIN_COLUMN = 26;
const GAP = 4;
const PLOT_HEIGHT = 224;

/**
 * The narrowest an employee's group may be drawn.
 *
 * A single-day range gives each person one bar, and a 26px column is not enough
 * to write a name under - every label came out as "Ad…". The group reserves
 * room for the name and centres its bars inside it instead.
 */
const MIN_GROUP = 74;

const groupWidth = (barCount: number): number =>
  Math.max(MIN_GROUP, barCount * MIN_COLUMN + Math.max(0, barCount - 1) * GAP);

interface Bar {
  key: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  /** The shift on the day itself where there is one, else the row's. */
  shiftName: string | null;
  teamName: string | null;
  departmentName: string | null;
  day: AttendanceDay;
}

/**
 * Was the day flagged late by the engine?
 *
 * `flags` is declared non-optional and the API always sends it, but this chart
 * draws whatever the endpoint returns and a missing array must not take the
 * page down over a tint. The question is only ever asked of the engine's own
 * flag - lateness is never re-derived here from times or thresholds.
 */
const isLate = (day: AttendanceDay): boolean => (day.flags ?? []).includes('LATE');

/**
 * The colour a bar takes.
 *
 * Status first, because a day that was not worked is not a late day or an
 * on-time day - it is an absence, a holiday, a weekend. Only once the day is
 * known to have been worked does lateness get to tint it.
 */
function barColor(day: AttendanceDay): string {
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
      return isLate(day)
        ? 'var(--att-half-day-border)'
        : 'var(--att-present-border)';
    default:
      // A status the engine grew that this file has not been taught yet reads
      // as neutral rather than as an absence.
      return 'var(--att-weekend-border)';
  }
}

/** What the bar is called in the legend and the panel. */
function barMeaning(day: AttendanceDay): string {
  if (day.status === 'PRESENT' && isLate(day)) return 'Late';
  return DERIVED_ATTENDANCE_STATUS_LABELS[day.status] ?? day.status;
}

/**
 * Ticks a reader can reach: whole hours.
 *
 * The top tick must COVER the tallest bar. Walking up from zero until the max
 * is passed does not guarantee that - a nine-hour day with a four-hour step
 * stops at eight, and the bar is then drawn at 112% of a plot it cannot leave.
 * Rounding the maximum up to the step first is what makes the axis a scale
 * rather than a suggestion.
 */
function axisTicks(maxMinutes: number): number[] {
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

export function TeamAttendanceBars({
  rows,
  loading = false,
  singleDay,
}: {
  rows: TeamAttendanceRow[];
  loading?: boolean;
  /** One bar per person when true; a group of days per person otherwise. */
  singleDay: boolean;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  const bars = React.useMemo<Bar[]>(
    () =>
      rows.flatMap((row) =>
        // `days` is optional in practice as well as in principle: a row for
        // somebody with nothing in range can arrive without it.
        (row.days ?? []).map((day) => ({
          key: `${row.employeeId}-${day.date}`,
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          employeeNumber: row.employeeNumber,
          shiftName: day.shiftName ?? row.shiftName ?? null,
          teamName: row.teamName,
          departmentName: row.departmentName,
          day,
        })),
      ),
    [rows],
  );

  const shownKey = hovered ?? selected;
  const shown = bars.find((b) => b.key === shownKey) ?? null;

  const maxWorked = Math.max(0, ...bars.map((b) => b.day.workedMinutes ?? 0));
  const ticks = axisTicks(maxWorked);
  // Never zero: an all-absent page still needs an axis to draw against.
  const axisTop = Math.max(ticks[ticks.length - 1] ?? 1, 1) * 60;

  if (loading) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-label="Loading chart" />;
  }

  if (bars.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nothing to chart"
        description="No attendance days match the current filters. Widen the date range, or clear a filter."
      />
    );
  }

  // Grouped by person so a range reads as "this employee's week" rather than as
  // an undifferentiated run of bars.
  const groups: Array<{ employeeId: string; label: string; bars: Bar[] }> = [];
  for (const bar of bars) {
    const last = groups[groups.length - 1];
    if (last && last.employeeId === bar.employeeId) last.bars.push(bar);
    else
      groups.push({
        employeeId: bar.employeeId,
        label: bar.employeeName,
        bars: [bar],
      });
  }

  const trackWidth =
    groups.reduce((sum, group) => sum + groupWidth(group.bars.length), 0) + groups.length * 12;

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
          <div className="relative" style={{ minWidth: trackWidth }}>
            <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: PLOT_HEIGHT }}>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute h-px w-full bg-chart-grid"
                  style={{ bottom: `${((tick * 60) / axisTop) * 100}%` }}
                />
              ))}
            </div>

            <div
              className="relative flex items-end gap-3"
              style={{ height: PLOT_HEIGHT }}
              role="list"
              aria-label="Worked hours per employee per day"
            >
              {groups.map((group) => (
                <div
                  key={group.employeeId}
                  className="flex h-full items-end justify-center"
                  style={{ gap: GAP, minWidth: groupWidth(group.bars.length) }}
                >
                  {group.bars.map((bar) => (
                    <BarColumn
                      key={bar.key}
                      bar={bar}
                      axisTop={axisTop}
                      selected={bar.key === selected}
                      onHover={setHovered}
                      onSelect={(key) => setSelected((prev) => (prev === key ? null : key))}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* The x axis: a day number under each bar, a name under each group. */}
            <div className="mt-1.5 flex gap-3">
              {groups.map((group) => (
                <div
                  key={group.employeeId}
                  className="min-w-0"
                  style={{ minWidth: groupWidth(group.bars.length) }}
                >
                  <div className="flex justify-center" style={{ gap: GAP }}>
                    {group.bars.map((bar) => (
                      <span
                        key={bar.key}
                        className={cn(
                          'tabular truncate text-center text-[10px] leading-none sm:text-[10.5px]',
                          bar.key === selected
                            ? 'font-semibold text-foreground'
                            : 'text-muted-foreground',
                        )}
                        style={{ minWidth: MIN_COLUMN }}
                      >
                        {singleDay ? '' : dayNumber(bar.day.date)}
                      </span>
                    ))}
                  </div>
                  <p
                    className="mt-1 truncate text-center text-[10.5px] text-muted-foreground"
                    title={group.label}
                  >
                    {group.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <BarDetail bar={shown} />
      <TeamBarsLegend />
    </div>
  );
}

function BarColumn({
  bar,
  axisTop,
  selected,
  onHover,
  onSelect,
}: {
  bar: Bar;
  axisTop: number;
  selected: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
}) {
  const { day } = bar;
  const worked = day.workedMinutes ?? 0;
  const overtime = Math.min(day.overtimeMinutes ?? 0, worked);
  const base = Math.max(0, worked - overtime);
  const color = barColor(day);

  const label = [
    bar.employeeName,
    formatDate(day.date),
    barMeaning(day),
    worked > 0 ? `${(worked / 60).toFixed(1)} hours worked` : 'no hours worked',
    day.lateMinutes ? `${day.lateMinutes} minutes late` : '',
    day.earlyLeaveMinutes ? `${day.earlyLeaveMinutes} minutes early leave` : '',
    overtime ? `${overtime} minutes overtime` : '',
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
      style={{ minWidth: MIN_COLUMN, width: MIN_COLUMN }}
    >
      {/*
        The whole column is the hit target, floor to ceiling. A three-pixel
        weekend marker cannot be tapped on a phone; a full-height button can.
      */}
      <button
        type="button"
        className="absolute inset-0 z-10 cursor-pointer rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        aria-label={label}
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
            style={{
              height: `${(base / axisTop) * 100}%`,
              backgroundColor: color,
              minHeight: 2,
            }}
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
    </div>
  );
}

/**
 * The figures for the hovered, focused or tapped bar.
 *
 * A panel under the chart rather than a floating box: on a phone there is
 * nowhere for a floating tooltip to go, and hover does not exist there at all.
 * Tapping a bar selects it, so the figures stay on screen instead of vanishing
 * when the finger lifts. Every field is listed even when unavailable, printed
 * as a dash, so a missing check-out reads as missing rather than as absent from
 * the panel.
 */
function BarDetail({ bar }: { bar: Bar | null }) {
  if (!bar) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        Tap or hover a bar for that employee&apos;s day.
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
        <span className="text-[13px] font-semibold">
          {bar.employeeName}
          <span className="tabular ml-1.5 text-[11.5px] font-normal text-muted-foreground">
            {orDash(bar.employeeNumber)}
          </span>
        </span>
        <span className="text-[12px] text-muted-foreground">{formatDate(day.date)}</span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-5">
        <Figure label="Status" value={day.holidayName ?? day.leaveTypeName ?? barMeaning(day)} />
        <Figure label="Shift" value={orDash(bar.shiftName) === '--' ? 'Unassigned' : bar.shiftName!} />
        <Figure label="Check in" value={timeLabel(day.checkInAt)} />
        <Figure label="Check out" value={timeLabel(day.checkOutAt)} />
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
        <Figure label="Team" value={bar.teamName ?? UNASSIGNED_TEAM_LABEL} />
        <Figure label="Department" value={orDash(bar.departmentName)} />
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

const LEGEND: Array<{ label: string; color: string; dashed?: boolean }> = [
  { label: 'On time', color: 'var(--att-present-border)' },
  { label: 'Late / half day', color: 'var(--att-half-day-border)' },
  { label: 'Overtime', color: 'var(--att-overtime-border)' },
  { label: 'Absent', color: 'var(--att-absent-border)' },
  { label: 'On leave', color: 'var(--att-leave-border)' },
  { label: 'Holiday', color: 'var(--att-holiday-border)' },
  { label: 'Weekend / off', color: 'var(--att-weekend-border)' },
];

export function TeamBarsLegend() {
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
    </div>
  );
}

/** Exported for tests: the colour and label rules, without any DOM. */
export const __testing = { barColor, barMeaning, axisTicks };
