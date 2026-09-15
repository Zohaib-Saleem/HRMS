import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { TrendPoint } from './dashboard-data';

/**
 * The dashboard's two charts, drawn by hand.
 *
 * No charting library: the shapes needed here are a ring and a stack of bars,
 * both of which are a few lines of SVG and CSS, and neither is worth a
 * dependency the rest of the app would then have to carry.
 *
 * Both charts follow the same three rules. Every segment is drawn once - the
 * categories partition the population rather than overlapping, so the parts
 * genuinely sum to the whole. Segments are separated by a gap in the surface
 * colour rather than by a border. And no value is reachable only by colour or
 * only by hovering: each chart ships a legend that prints the figure beside its
 * swatch, which is also the table view for anyone who cannot use the colours.
 */

/** Arc-length gap between ring segments, and the pixel gap between bar segments. */
const SEGMENT_GAP = 2;

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** A CSS colour, always a validated `--chart-*` token. */
  color: string;
  /**
   * Where the slice drills down to, when it drills down at all.
   *
   * Optional because the legend is also used to describe a chart nobody can
   * click into; a slice without one stays a plain row rather than becoming a
   * link that goes nowhere.
   */
  to?: string;
}

// -------------------------------------------------------------------- donut

interface DonutProps {
  slices: Slice[];
  /** The figure printed in the middle. Null renders a dash, never a zero. */
  centerValue: string;
  centerLabel: string;
  className?: string;
}

/**
 * Part-to-whole at a glance, five segments at most.
 *
 * A ring rather than a pie because the middle is the most valuable space on the
 * chart and a pie wastes it; the headline rate lives there instead.
 */
export function DonutChart({ slices, centerValue, centerLabel, className }: DonutProps) {
  const drawn = slices.filter((slice) => slice.value > 0);
  const total = drawn.reduce((sum, slice) => sum + slice.value, 0);

  const size = 168;
  const stroke = 22;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  // A single segment is a complete ring, so it gets no gap - a 2px notch in an
  // otherwise unbroken circle reads as a rendering fault.
  const gap = drawn.length > 1 ? SEGMENT_GAP : 0;

  let offset = 0;

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="presentation">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--chart-grid)"
          strokeWidth={total === 0 ? stroke : 1}
        />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {drawn.map((slice) => {
            const length = (slice.value / total) * circumference;
            const dash = Math.max(length - gap, 0.5);
            const node = (
              <circle
                key={slice.key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              >
                <title>{`${slice.label}: ${slice.value} (${Math.round((slice.value / total) * 100)}%)`}</title>
              </circle>
            );
            offset += length;
            return node;
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[26px] font-semibold leading-none tracking-tight">{centerValue}</span>
        <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {centerLabel}
        </span>
      </div>
    </div>
  );
}

/**
 * The legend, which doubles as the table view.
 *
 * Every row carries the count and the share in text, so the chart never depends
 * on anyone telling two hues apart.
 */
export function SliceLegend({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <ul className="min-w-0 flex-1 space-y-1">
      {slices.map((slice) => {
        const body = (
          <>
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: slice.color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">{slice.label}</span>
            <span className="tabular text-[13px] font-semibold">{slice.value}</span>
            <span className="tabular w-10 text-right text-[12px] text-muted-foreground">
              {total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '--'}
            </span>
          </>
        );
        // The row already lifts on hover, which on a plain legend is decoration
        // and on a linked one is the affordance; the chevron is what tells the
        // two apart, and it is the only thing the link adds to the layout.
        const shell = 'flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors';

        return (
          <li key={slice.key}>
            {slice.to ? (
              <Link
                to={slice.to}
                className={`${shell} group hover:bg-accent focus-visible:bg-accent`}
                aria-label={`${slice.label}: ${slice.value}. Open in team attendance.`}
              >
                {body}
                <ChevronRight
                  className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                  aria-hidden
                />
              </Link>
            ) : (
              <span className={`${shell} hover:bg-accent/45`}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// --------------------------------------------------------------------- bars

const TREND_SERIES = [
  { key: 'onTime', label: 'On time', color: 'var(--chart-present)' },
  { key: 'late', label: 'Late', color: 'var(--chart-late)' },
  { key: 'absent', label: 'Absent', color: 'var(--chart-absent)' },
  { key: 'other', label: 'On leave', color: 'var(--chart-other)' },
] as const;

const dayTick = (iso: string, withMonth: boolean): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    ...(withMonth ? { month: 'short' as const } : {}),
    timeZone: 'UTC',
  });

const weekdayTick = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });

/**
 * One column per day, stacked on-time / late / absent / on leave.
 *
 * The stack is the honest shape for this data: the four states are exclusive
 * and together make up everyone whose day was scored, so a column's height is
 * the workforce that day and the segments divide it. Plotting present, absent
 * and late as three separate bars would draw the late people twice.
 *
 * Bars share one scale - the tallest day in the range - so a short column means
 * fewer people were scored that day, not a shorter axis.
 */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const max = Math.max(1, ...points.map((point) => point.scored));
  const dense = points.length > 10;
  // Every column on a week, then thinned so labels never collide.
  const tickEvery = points.length > 20 ? 5 : points.length > 10 ? 3 : 1;

  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-3">
        <div className="flex w-6 shrink-0 flex-col justify-between py-px text-right">
          <span className="tabular text-[11px] leading-none text-muted-foreground">{max}</span>
          <span className="tabular text-[11px] leading-none text-muted-foreground">0</span>
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Recessive solid hairlines, one shade off the surface. */}
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {[0, 1, 2].map((line) => (
              <div key={line} className="h-px w-full bg-chart-grid" />
            ))}
          </div>

          <div
            className={cn('relative flex h-44 items-end', dense ? 'gap-[3px]' : 'gap-1.5')}
            role="presentation"
          >
            {points.map((point) => (
              <TrendColumn key={point.date} point={point} max={max} />
            ))}
          </div>
        </div>
      </div>

      <div className={cn('flex pl-9', dense ? 'gap-[3px]' : 'gap-1.5')}>
        {points.map((point, index) => (
          <span
            key={point.date}
            className="min-w-0 flex-1 truncate text-center text-[10.5px] leading-none text-muted-foreground"
          >
            {index % tickEvery === 0
              ? dense
                ? dayTick(point.date, index === 0)
                : weekdayTick(point.date)
              : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function TrendColumn({ point, max }: { point: TrendPoint; max: number }) {
  const segments = TREND_SERIES.map((series) => ({
    ...series,
    value: point[series.key],
  })).filter((segment) => segment.value > 0);

  const tooltip = [
    `${dayTick(point.date, true)} - ${point.rate === null ? 'not a working day' : `${point.rate}% attendance`}`,
    ...segments.map((segment) => `${segment.label}: ${segment.value}`),
  ].join('\n');

  return (
    <div
      className="group relative flex h-full min-w-0 flex-1 flex-col-reverse justify-start gap-[2px]"
      title={tooltip}
    >
      {segments.length === 0 ? (
        // A weekend or holiday: nothing was scored, so nothing is drawn beyond
        // a marker that the day exists.
        <div className="h-[3px] w-full rounded-sm bg-chart-grid" />
      ) : (
        segments.map((segment, index) => (
          <div
            key={segment.key}
            className={cn(
              'w-full transition-opacity group-hover:opacity-80',
              // Only the data end is rounded, and only when it is the top of
              // the stack; the baseline end stays square on the axis.
              index === segments.length - 1 ? 'rounded-t-[4px]' : '',
            )}
            style={{
              height: `${(segment.value / max) * 100}%`,
              backgroundColor: segment.color,
              minHeight: 2,
            }}
          />
        ))
      )}
    </div>
  );
}

/** Shared legend for the trend chart. Present for every multi-series chart. */
export function TrendLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {TREND_SERIES.map((series) => (
        <li key={series.key} className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px]"
            style={{ backgroundColor: series.color }}
            aria-hidden
          />
          <span className="text-[12px] text-muted-foreground">{series.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------- meters

/**
 * The inline attendance bar used in the department and team tables.
 *
 * A single-hue meter, not a categorical colour: it encodes one magnitude, and
 * the figure beside it is the value - the bar is there to make the column
 * scannable, never to be read on its own.
 */
export function RateMeter({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-[13px] text-muted-foreground">--</span>;
  }

  const tone =
    value >= 90
      ? 'var(--chart-present)'
      : value >= 75
        ? 'var(--chart-late)'
        : 'var(--chart-absent)';

  return (
    <span className="flex items-center justify-end gap-2">
      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(value, 100)}%`, backgroundColor: tone }}
        />
      </span>
      <span className="tabular w-10 text-right text-[13px] font-semibold">{value}%</span>
    </span>
  );
}
