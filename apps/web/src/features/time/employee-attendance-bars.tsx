import * as React from 'react';
import { CalendarClock } from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type AttendanceDay,
} from '@hrms/shared';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/feedback/states';
import { clockLabel, durationLabel } from './attendance-ui';

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
 * this day's worked minutes against the axis the data itself set.
 *
 * In particular, worked time is never computed from `checkOutAt - checkInAt`.
 * That subtraction ignores the break the policy deducts and the spans the
 * engine refuses to believe, so it would disagree with the table, the 360
 * profile, the reports and payroll. `workedMinutes` is the answer; this file
 * only draws it.
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
 * 18, not 22, so that a 31-day month comes close to clearing a tablet's
 * content column: 31 columns, 30 gaps and the label lead come to 668px, and the
 * axis beside them to another 48. On a narrower screen the month scrolls
 * whatever this is, and the hit target stays the full height of the plot rather
 * than the width of the bar.
 */
const MIN_COLUMN = 18;
const GAP = 3;
const PLOT_HEIGHT = 224;

/**
 * Room under the plot for the date labels.
 *
 * "01-Sep" is around 34px wide and a column is 18, so the labels are laid at
 * -45 degrees rather than thinned out or abbreviated: the brief is every
 * calendar day, named. Turned, a label needs `width x sin 45` of vertical room
 * - about 24px - and neighbours stay clear of one another because they are all
 * turned the same way.
 */
const LABEL_BAND = 36;

/**
 * A turned label runs down and to the LEFT of the day it names, so the first
 * one runs off the left of the plot. This much room in front of the first
 * column is what keeps it from being cut in half by the scroller.
 */
const LABEL_LEAD = 20;

/** Fixed, so the tooltip can be kept inside the viewport without measuring it. */
const TOOLTIP_WIDTH = 224;
const TOOLTIP_EDGE = 6;

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

/** What the bar is called in the legend and the tooltip. */
export function barMeaning(day: AttendanceDay): string {
  if (day.status === 'PRESENT' && hasFlag(day, 'LATE')) return 'Late';
  return DERIVED_ATTENDANCE_STATUS_LABELS[day.status] ?? day.status;
}

/**
 * The tick steps the axis is allowed to use, in MINUTES.
 *
 * Units of clock time, every one of them - a quarter hour, a half, an hour, an
 * hour and a half - so that whichever the data reaches still reads as a
 * duration when it is printed "1:30". Deliberately not "nice numbers" in the
 * decimal sense: 0:00, 0:50, 1:40 divides a day evenly and tells a reader
 * nothing.
 *
 * Not a statement about the working day. Nothing here knows or cares how long
 * one is; the steps merely have to cover anything from a ten-minute appearance
 * to a double shift.
 */
const AXIS_STEPS = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];

/**
 * Bands above zero. Seven gives an axis a reader can count without crowding
 * 224px of plot: at most eight labels, roughly 28px apart at their tightest.
 */
const AXIS_BANDS = 7;

/**
 * A little air above the tallest day, so the longest bar does not touch the
 * ceiling and read as clipped.
 */
const AXIS_HEADROOM = 1.06;

/**
 * The ticks, in minutes, for a month whose longest day was `maxMinutes`.
 *
 * Scaled to the DATA, never to a fixed working day: a six-hour company and a
 * twelve-hour one each get an axis that fits them, and neither is told what a
 * day should have been.
 *
 * The top tick must COVER the tallest bar, which is why the maximum is rounded
 * UP to a whole step rather than walked up to from below. Walking up stops one
 * step short - a nine-hour day against a four-hour step stops at eight - and
 * the bar is then drawn at 112% of a plot it cannot leave.
 */
export function axisTicks(maxMinutes: number): number[] {
  // An all-absent month still needs a scale to draw nothing against.
  if (!(maxMinutes > 0)) return [0, 60];

  const target = maxMinutes * AXIS_HEADROOM;
  const step = AXIS_STEPS.find((s) => target / s <= AXIS_BANDS) ?? AXIS_STEPS[AXIS_STEPS.length - 1]!;
  const top = Math.max(step, Math.ceil(target / step) * step);

  const ticks: number[] = [];
  for (let m = 0; m <= top; m += step) ticks.push(m);
  return ticks;
}

/** "01-Sep", the way the x axis names a day. */
const dayMonthLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const month = d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
  return `${iso.slice(8, 10)}-${month}`;
};

/** "Mon", for the tooltip's heading. */
const weekdayLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
};

/**
 * Where the tooltip and its guide line sit, measured from the real layout.
 *
 * Measured rather than computed from the day's index: columns share the width
 * with gaps between them, so an index is only ever an approximation, and a
 * tooltip that points a few pixels away from its own bar is worse than no
 * tooltip.
 *
 * Two coordinates because the two things being placed live in different boxes.
 * `trackX` is where the bar is inside the track, which scrolls; `x` is where
 * that lands in the chart as a whole, which is where the tooltip is drawn so
 * that the scroller cannot clip it. `viewLeft` and `viewWidth` are the
 * scroller's window, which is what the tooltip has to stay inside.
 */
interface Anchor {
  key: string;
  trackX: number;
  x: number;
  viewLeft: number;
  viewWidth: number;
}

export function EmployeeAttendanceBars({
  days,
  employeeName,
  loading = false,
  plotHeight = PLOT_HEIGHT,
  showLegend = true,
  hint = true,
}: {
  days: AttendanceDay[];
  employeeName: string;
  loading?: boolean;
  /**
   * How tall the plot is drawn, in pixels. Defaults to the full-page height.
   *
   * The dashboard passes a shorter one: the same chart, the same data and the
   * same colours, in the room a summary card can spare. It is a dimension and
   * nothing else - no figure, threshold or status is affected by it, and the
   * bars stay proportional to one another because every height in here is a
   * percentage of the axis the data itself set.
   */
  plotHeight?: number;
  /** The colour key. Off on the dashboard, where /attendance carries it. */
  showLegend?: boolean;
  /** The "hover a bar" line. Off where space is tight. */
  hint?: boolean;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [anchor, setAnchor] = React.useState<Anchor | null>(null);

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);

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

  /**
   * Read the live geometry of one column.
   *
   * Reads only refs, so it never needs rebuilding, and returns null rather than
   * guessing when the chart is not laid out yet - a test renderer with no
   * layout, or the frame before the first paint.
   */
  const locate = React.useCallback((key: string | null): Anchor | null => {
    const track = trackRef.current;
    const scroller = scrollerRef.current;
    if (!key || !track || !scroller) return null;

    const column = track.querySelector<HTMLElement>(`[data-bar-key="${key}"]`);
    if (!column) return null;

    const trackX = column.offsetLeft + column.offsetWidth / 2;
    return {
      key,
      trackX,
      x: scroller.offsetLeft + trackX - scroller.scrollLeft,
      viewLeft: scroller.offsetLeft,
      viewWidth: scroller.clientWidth || track.offsetWidth,
    };
  }, []);

  React.useLayoutEffect(() => {
    setAnchor(locate(shownKey));
  }, [shownKey, keys, locate]);

  // The card is resizable and the track scrolls, and the tooltip is placed in
  // pixels: both have to put it back where its bar went.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const recheck = () => setAnchor((prev) => (prev ? locate(prev.key) : null));
    scroller.addEventListener('scroll', recheck, { passive: true });

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(recheck);
    observer?.observe(scroller);

    return () => {
      scroller.removeEventListener('scroll', recheck);
      observer?.disconnect();
    };
  }, [locate]);

  const maxWorked = Math.max(0, ...bars.map((b) => b.day.workedMinutes ?? 0));
  const ticks = axisTicks(maxWorked);
  // Never zero: an all-absent month still needs an axis to divide by.
  const axisTop = Math.max(ticks[ticks.length - 1] ?? 60, 1);

  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg bg-muted/60" aria-label="Loading chart" />;
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

  /**
   * The tooltip's centre, kept inside the part of the track a reader can see.
   *
   * Clamped against the SCROLLER's window rather than the track, because on a
   * phone the track is far wider than the screen and a box centred on a bar at
   * the right edge of the window would hang off it. The guide line stays on the
   * bar itself, so the association survives the clamp.
   */
  const tipCentre = (() => {
    if (!anchor) return 0;
    const half = TOOLTIP_WIDTH / 2;
    const min = anchor.viewLeft + half + TOOLTIP_EDGE;
    const max = anchor.viewLeft + anchor.viewWidth - half - TOOLTIP_EDGE;
    return Math.min(Math.max(anchor.x, min), Math.max(min, max));
  })();

  return (
    <div className="space-y-3">
      {/*
        Full bleed inside the card: no max-width, no grid column, no basis.

        `relative` because the tooltip is drawn HERE rather than inside the
        scroller - a box that a scroller can clip is not a tooltip - and the
        top padding is the half of the topmost axis label that sits above the
        plot's ceiling.
      */}
      <div className="relative w-full pt-2">
       <div className="flex w-full items-stretch gap-2 sm:gap-3">
        {/* The axis sits outside the scroller: a scale that slides away is not a scale. */}
        <div
          className="relative w-9 shrink-0 sm:w-10"
          style={{ height: plotHeight }}
          aria-hidden
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="tabular absolute right-0 -translate-y-1/2 text-[10.5px] leading-none text-muted-foreground"
              style={{ bottom: `${(tick / axisTop) * 100}%` }}
            >
              {durationLabel(tick)}
            </span>
          ))}
        </div>

        <div
          ref={scrollerRef}
          className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setHovered(null);
          }}
        >
          <div
            ref={trackRef}
            className="relative w-full"
            style={{ minWidth: trackWidth + LABEL_LEAD, paddingLeft: LABEL_LEAD }}
          >
            <div
              className="pointer-events-none absolute inset-x-0 top-0"
              style={{ height: plotHeight }}
            >
              {ticks.map((tick) => (
                <div
                  key={tick}
                  className="absolute h-px w-full bg-chart-grid"
                  style={{ bottom: `${(tick / axisTop) * 100}%` }}
                />
              ))}
            </div>

            {/* The line that ties the tooltip to its bar even when the box is
                clamped away from it. */}
            {anchor ? (
              <div
                className="pointer-events-none absolute top-0 z-20 w-px bg-foreground/25"
                style={{ left: anchor.trackX, height: plotHeight }}
                aria-hidden
              />
            ) : null}

            <div
              className="relative flex w-full items-end"
              style={{ height: plotHeight, gap: GAP }}
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

            {/* The x axis: every calendar day, named, turned so that a 31-day
                month still fits the card it is drawn in.

                The turn is done with a transform rather than by shortening the
                label, because "03" and "03-Sep" are not the same answer to
                "which day is this?" when the reader has stepped back a month.
                Each label's right end sits under the centre of its own column
                and the text runs down-left from there, which is why every cell
                keeps the bars' `flex: 1 1 0` footing: label and bar have to
                move together or they stop naming each other. */}
            <div className="flex w-full" style={{ gap: GAP, marginTop: 4 }}>
              {bars.map((bar) => (
                <span
                  key={bar.key}
                  className="relative block"
                  style={{ minWidth: MIN_COLUMN, flex: '1 1 0', height: LABEL_BAND }}
                >
                  <span
                    className={cn(
                      'tabular absolute left-1/2 top-0 whitespace-nowrap text-[10px] leading-none sm:text-[10.5px]',
                      bar.key === shownKey
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground',
                    )}
                    style={{
                      transformOrigin: '0 0',
                      transform: 'rotate(-45deg) translateX(-100%)',
                    }}
                  >
                    {dayMonthLabel(bar.day.date)}
                  </span>
                </span>
              ))}
            </div>

          </div>
        </div>
       </div>

        {shown ? (
          <BarTooltip bar={shown} employeeName={employeeName} left={tipCentre} />
        ) : null}
      </div>

      {shown || !hint ? null : (
        <p className="text-[12.5px] text-muted-foreground">
          Hover a bar, or tap one on a phone, for that day&apos;s figures.
        </p>
      )}

      {showLegend ? <BarsLegend /> : null}
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

  /**
   * Was this column's focus caused by a press?
   *
   * A press focuses the button somewhere between pressing and clicking - where
   * exactly differs between browsers - so a tap meant to CLOSE the tooltip
   * would reopen it through the focus handler, and on a phone that focus never
   * goes away, so the tooltip would look stuck. The flag is raised on the press
   * and lowered by the click that ends it, which is after the focus either way
   * round. Focus opens the tooltip only when it arrived on its own, which is
   * what a keyboard does.
   */
  const pressed = React.useRef(false);

  const worked = day.workedMinutes ?? 0;
  // Clamped to the day so a data oddity cannot draw a bar out of its own plot.
  const overtime = Math.min(day.overtimeMinutes ?? 0, worked);
  const base = Math.max(0, worked - overtime);
  const color = barColor(day);

  const label = [
    employeeName,
    dayMonthLabel(day.date),
    barMeaning(day),
    worked > 0 ? `${durationLabel(worked)} worked` : 'no hours worked',
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
      data-bar-key={bar.key}
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
        aria-pressed={selected}
        onClick={() => {
          pressed.current = false;
          onSelect(bar.key);
        }}
        /*
          Pointer events with a mouse guard, not mouse events.
          
          A tap on a phone is followed by an emulated mouseenter that never
          leaves, which would pin the tooltip open and make a second tap look
          broken. Asking the pointer what it is keeps hover a mouse idea and
          leaves the tap to the click handler, which toggles.
        */
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') onHover(bar.key);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') onHover(null);
        }}
        onPointerDown={() => {
          pressed.current = true;
        }}
        onFocus={() => {
          if (!pressed.current) onHover(bar.key);
        }}
        onBlur={() => {
          pressed.current = false;
          onHover(null);
        }}
      />

      {/* A day the engine flagged as missing a punch gets a mark of its own:
          the height is honest but incomplete, and that is worth saying. Laid
          in the column's own flow - which runs bottom to top - so it rides on
          the bar rather than floating at the ceiling above an empty one. */}
      {hasFlag(day, 'MISSING_PUNCH') ? (
        <span
          className="pointer-events-none order-last block text-center text-[10px] font-bold leading-none text-att-absent-foreground"
          aria-hidden
        >
          !
        </span>
      ) : null}

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

    </div>
  );
}

/**
 * The day's figures, floating beside the bar they belong to.
 *
 * One component for both interactions. Hovering a bar shows it; tapping one
 * pins it, because hover does not exist on a phone and a panel that vanishes
 * when the finger lifts has told nobody anything. Tapping a second bar moves
 * it; tapping the same bar again puts it away.
 *
 * `pointer-events-none` so that a box overlapping the bar beneath it cannot
 * steal the hover that is keeping it open.
 *
 * It floats over the plot from the `sm` breakpoint up and sits UNDER the chart
 * below it. Not a preference: a 224px card over a 272px plot is not a tooltip,
 * it is a lid, and a phone has nowhere for it to go. `left` is left in place
 * for both - it simply has no effect while the box is in normal flow - so one
 * element serves both and there is no second copy to drift out of step.
 *
 * Every field is listed even when unavailable, printed as a dash, so a missing
 * check-out reads as missing rather than as absent from the tooltip. A dash is
 * the honest answer; a zero would be a claim.
 */
function BarTooltip({
  bar,
  employeeName,
  left,
}: {
  bar: BarDay;
  employeeName: string;
  left: number;
}) {
  const { day } = bar;
  const worked = day.workedMinutes;

  /**
   * Remote hours, from the engine's own `mode` and `workedMinutes`.
   *
   * A day is worked at the office or worked remotely - the record carries which
   * - so a remote day's remote hours ARE its worked hours. Nothing is
   * apportioned or re-timed here. A day with no record has no mode, and gets a
   * dash rather than a zero it cannot vouch for.
   */
  const remote = !day.hasRecord ? null : day.mode === 'REMOTE' ? worked : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none static mt-3 w-full rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg sm:absolute sm:top-3.5 sm:z-30 sm:mt-0 sm:w-56 sm:-translate-x-1/2"
      style={{ left }}
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1.5">
        <span className="tabular text-[13px] font-semibold">{dayMonthLabel(day.date)}</span>
        <span className="text-[11px] text-muted-foreground">{weekdayLabel(day.date)}</span>
      </div>

      <dl className="mt-1.5 space-y-1">
        <Figure label="Time In" value={clockLabel(day.checkInAt)} />
        <Figure
          label="Time Out"
          value={
            day.checkOutAt
              ? clockLabel(day.checkOutAt)
              : hasFlag(day, 'MISSING_PUNCH')
                ? 'Missing'
                : '--'
          }
        />
        <Figure label="Break Hrs" value={durationLabel(day.breakMinutes)} />
        <Figure label="Remote Hrs" value={durationLabel(remote)} />
        <Figure label="Total Worked Hrs" value={durationLabel(worked)} strong />
        <Figure label="Status" value={day.holidayName ?? day.leaveTypeName ?? barMeaning(day)} />

        {/* Only when the engine had something to say. Overtime is named here
            rather than drawn as extra height: the bar is the worked day. */}
        {day.overtimeMinutes ? (
          <Figure label="Overtime" value={durationLabel(day.overtimeMinutes)} />
        ) : null}
        {day.lateMinutes ? <Figure label="Late" value={durationLabel(day.lateMinutes)} /> : null}
        {day.earlyLeaveMinutes ? (
          <Figure label="Early leave" value={durationLabel(day.earlyLeaveMinutes)} />
        ) : null}
        <Figure label="Shift" value={day.shiftName ?? 'Unassigned'} />
      </dl>

      <p className="sr-only">{employeeName}</p>
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'tabular truncate text-[12.5px]',
          strong ? 'font-semibold' : 'font-medium',
        )}
      >
        {value}
      </dd>
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
