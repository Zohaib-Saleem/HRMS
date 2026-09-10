import * as React from 'react';
import { BarChart3, CalendarDays, Download, TableIcon } from 'lucide-react';
import {
  DERIVED_ATTENDANCE_STATUSES,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  type DerivedAttendanceStatus,
} from '@hrms/shared';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { useLookups } from '@/lib/lookups';
import { MonthNav } from './attendance-calendar';

/**
 * The Attendance page's shared chrome: which view is showing, which month, and
 * which filters.
 *
 * All three used to live inside whichever component happened to need them - the
 * chart owned the month and the four filters, the calendar owned a second month
 * of its own, and the table owned a third set of filters. Switching view
 * therefore threw the reader's month and filters away and silently answered a
 * different question. One state, owned by the page and passed down, is what
 * makes the switch a change of view rather than a change of subject.
 */

export type AttendanceView = 'chart' | 'calendar' | 'table';

/**
 * The bar chart leads.
 *
 * It is the only view that answers "how did the month go?" at a glance; the
 * calendar and the table are both ways of drilling into a day once that
 * question has been asked.
 */
export const DEFAULT_ATTENDANCE_VIEW: AttendanceView = 'chart';

export const ATTENDANCE_VIEWS: ReadonlyArray<{
  key: AttendanceView;
  label: string;
  icon: typeof BarChart3;
}> = [
  { key: 'chart', label: 'Bar chart', icon: BarChart3 },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'table', label: 'Table', icon: TableIcon },
];

export interface AttendanceFilters {
  departmentId: string;
  teamId: string;
  employeeId: string;
  /** A derived status, so "upcoming" and "off day" are askable. */
  status: string;
  /** Free text. Only the table can answer it; the other views ignore it. */
  q: string;
}

export const NO_ATTENDANCE_FILTERS: AttendanceFilters = {
  departmentId: '',
  teamId: '',
  employeeId: '',
  status: '',
  q: '',
};

export const hasAnyFilter = (filters: AttendanceFilters): boolean =>
  Object.values(filters).some((value) => value !== '');

// ------------------------------------------------------------------ the month

export const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export const currentMonth = () => startOfMonth(new Date());

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

export const monthLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const shiftMonthBy = (month: Date, delta: number) =>
  new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1));

/** First and last calendar day of the month, as the API's YYYY-MM-DD. */
export function monthRange(month: Date): { from: string; to: string } {
  const from = month.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/**
 * The filters as query parameters, shared by every view.
 *
 * One object so the chart, the calendar and the table are demonstrably asking
 * about the same population - and so a filter added here reaches all three
 * rather than one of them.
 */
export function analyticsParams(
  month: Date,
  filters: AttendanceFilters,
): Record<string, string | undefined> {
  return {
    month: monthKey(month),
    departmentId: filters.departmentId || undefined,
    teamId: filters.teamId || undefined,
    employeeId: filters.employeeId || undefined,
    status: filters.status || undefined,
  };
}

/**
 * Statuses that no stored attendance record can carry.
 *
 * `UPCOMING` and `OFF_DAY` are derived at read time - a day that has not
 * happened, and a day the shift does not work, have no row to filter on. The
 * table says so rather than quietly listing everything.
 */
export const isDerivedOnlyStatus = (status: string): boolean =>
  status === 'UPCOMING' || status === 'OFF_DAY';

// ----------------------------------------------------------- the view switcher

/**
 * Bar chart / Calendar / Table.
 *
 * A segmented control rather than a menu, because there are three options and
 * the reader must be able to see which one is active without opening anything.
 * The selected segment is the page's primary colour - the same treatment as a
 * primary button - so the active view is legible at a glance on both themes and
 * does not rely on a one-shade-lighter background nobody notices.
 *
 * It stretches to the full width on a phone, where three equal thumb-sized
 * targets beat three small ones huddled in a corner, and shrinks to its content
 * from the `sm` breakpoint up.
 */
export function AttendanceViewSwitcher({
  view,
  onChange,
  className,
}: {
  view: AttendanceView;
  onChange: (next: AttendanceView) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Attendance view"
      className={cn(
        // Full width on a phone, three equal thumb-sized targets. From `sm` up
        // it shrinks to its content AND stops stretching: in a column flex
        // container `inline-flex` still grows to the full row otherwise, which
        // left a segmented control the width of a tablet.
        'grid w-full grid-cols-3 gap-1 rounded-xl border border-border bg-surface-muted p-1 sm:inline-flex sm:w-auto sm:self-start',
        className,
      )}
    >
      {ATTENDANCE_VIEWS.map((option) => {
        const selected = view === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.key)}
            className={cn(
              // 44px tall on a phone: a tap target, not a link. The label
              // never wraps - "Bar chart" broken over two lines made the
              // control taller than the row it sits in.
              'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[13.5px] font-medium transition-colors sm:min-h-9 sm:px-4',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              selected
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <option.icon className="size-4 shrink-0" aria-hidden />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- the control bar

interface ControlBarProps {
  view: AttendanceView;
  onViewChange: (next: AttendanceView) => void;
  month: Date;
  onMonthChange: (next: Date) => void;
  filters: AttendanceFilters;
  onFiltersChange: (patch: Partial<AttendanceFilters>) => void;
  onResetFilters: () => void;
  /** Where the CSV for the current month and filters lives. */
  exportHref: string;
}

/**
 * Everything that decides what the page below is showing, in one card at the
 * top of it: the view, the month, and the four filters.
 *
 * Deliberately not folded into the page header. The header carries the page's
 * identity and its two unrelated actions; the switcher belongs with the month
 * and the filters because those are the controls a reader touches together, and
 * a control tucked among header buttons is a control nobody finds.
 */
export function AttendanceControlBar({
  view,
  onViewChange,
  month,
  onMonthChange,
  filters,
  onFiltersChange,
  onResetFilters,
  exportHref,
}: ControlBarProps) {
  const { lookups } = useLookups();

  const teamOptions = filters.departmentId
    ? lookups.teams.filter((t) => t.departmentId === filters.departmentId)
    : lookups.teams;

  const isCurrentMonth = monthKey(month) === monthKey(currentMonth());

  return (
    <Card className="mb-5">
      <CardHeader bordered className="gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <AttendanceViewSwitcher view={view} onChange={onViewChange} />

          <div className="flex flex-wrap items-center gap-2">
            {hasAnyFilter(filters) ? (
              <Button variant="ghost" size="sm" onClick={onResetFilters}>
                Clear filters
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <a href={exportHref} download>
                <Download />
                Export CSV
              </a>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <MonthNav onShift={(delta) => onMonthChange(shiftMonthBy(month, delta))} />
          <CardTitle className="min-w-[9rem]">{monthLabel(month)}</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMonthChange(currentMonth())}
            disabled={isCurrentMonth}
          >
            Today
          </Button>
          <label className="sr-only" htmlFor="attendance-month">
            Month
          </label>
          <input
            id="attendance-month"
            type="month"
            value={monthKey(month)}
            onChange={(e) => {
              // An empty value means the picker was cleared; keep the month
              // that is on screen rather than jumping to an invalid date.
              if (!e.target.value) return;
              onMonthChange(new Date(`${e.target.value}-01T00:00:00Z`));
            }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
          />
        </div>
      </CardHeader>

      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Filter label="Department">
          <NativeSelect
            value={filters.departmentId}
            onChange={(e) => onFiltersChange({ departmentId: e.target.value })}
            aria-label="Filter by department"
          >
            <option value="">All departments</option>
            {lookups.departments.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </NativeSelect>
        </Filter>

        <Filter label="Team">
          <NativeSelect
            value={filters.teamId}
            onChange={(e) => onFiltersChange({ teamId: e.target.value })}
            aria-label="Filter by team"
          >
            <option value="">All teams</option>
            {teamOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </NativeSelect>
        </Filter>

        <Filter label="Employee">
          <NativeSelect
            value={filters.employeeId}
            onChange={(e) => onFiltersChange({ employeeId: e.target.value })}
            aria-label="Filter by employee"
          >
            <option value="">All employees</option>
            {lookups.managers.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </NativeSelect>
        </Filter>

        <Filter label="Status">
          <NativeSelect
            value={filters.status}
            onChange={(e) => onFiltersChange({ status: e.target.value })}
            aria-label="Filter by attendance status"
          >
            <option value="">All statuses</option>
            {DERIVED_ATTENDANCE_STATUSES.map((s: DerivedAttendanceStatus) => (
              <option key={s} value={s}>{DERIVED_ATTENDANCE_STATUS_LABELS[s]}</option>
            ))}
          </NativeSelect>
        </Filter>
      </CardContent>
    </Card>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
