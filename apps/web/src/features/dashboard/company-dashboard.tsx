import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlarmClock,
  Banknote,
  BarChart3,
  Boxes,
  Building2,
  ClipboardCheck,
  HandCoins,
  Headset,
  Sun,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Clock,
  Fingerprint,
  Layers,
  KeyRound,
  Percent,
  ScrollText,
  Settings,
  ShieldCheck,
  TrendingUp,
  UserMinus,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERMISSIONS, type AttendanceDay, type AuditLogEntry } from '@hrms/shared';
import { api } from '@/lib/api';
import { cn, formatRelative, humanise } from '@/lib/utils';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton, TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useAuthenticatedSession, usePermissions } from '@/features/auth/session-context';
import { STATUS_TONE } from '@/features/time/attendance-ui';
import { teamAttendancePath } from '@/features/time/team-attendance-filter';
import { DonutChart, RateMeter, SliceLegend, TrendChart, TrendLegend } from './dashboard-charts';
import type { Slice } from './dashboard-charts';
import {
  TREND_RANGES,
  attendanceRate,
  buildTrend,
  groupByDepartment,
  groupByTeam,
  isLateArrival,
  recentPunches,
  tallyDays,
  todayExceptions,
  todayIso,
  trendRange,
  applyRoster,
  useAttendanceRange,
  useAttendanceToday,
  useEmployeeRoster,
  type GroupCounts,
  type PersonDay,
  type TrendRangeKey,
} from './dashboard-data';
import { MyAssignedWorkCard } from '@/features/cases/my-assigned-work-card';
import { MentionsCard } from '@/features/cases/mentions-card';

/**
 * The company dashboard.
 *
 * One question, answered from the top down: how is attendance today, how has it
 * been trending, where is it going wrong, and what do I do about it. Everything
 * on the page is read from endpoints that already existed - `/company/stats`
 * for the headcount figures and `/attendance/team` for every attendance number -
 * and aggregated in `dashboard-data.ts`. No figure here is estimated, sampled
 * or filled in: a number that cannot be derived is shown as a dash rather than
 * as a zero, because zero is a claim.
 */

interface CompanyStats {
  employees: number;
  activeEmployees: number;
  onLeave: number;
  departments: number;
  teams: number;
  activeUsers: number;
  newThisMonth: number;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

const shortDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

const clockTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '--';

/**
 * What a captured check-in should be called.
 *
 * The list is every day carrying a check-in, and a punch on a weekend, a public
 * holiday or an approved leave day carries one too - overtime and call-outs are
 * real, and the derivation keeps the punch while classifying the day as what it
 * was. Calling all of those "Present" described the day as something it was not,
 * so the day's own status supplies the label, with lateness taking precedence
 * because that is the fact the row exists to surface.
 */
const punchLabel = (day: AttendanceDay): string => {
  if (isLateArrival(day)) return 'Late';
  if (day.status === 'PRESENT') return 'Present';
  if (day.status === 'HALF_DAY') return 'Half day';
  return humanise(day.status);
};

export function CompanyDashboard() {
  const session = useAuthenticatedSession();
  const { has } = usePermissions();

  const canReadEmployees = has(PERMISSIONS.EMPLOYEE_READ);
  const canReadAttendance = has(PERMISSIONS.ATTENDANCE_READ);

  const [range, setRange] = React.useState<TrendRangeKey>('7d');

  const statsQuery = useQuery({
    queryKey: ['company', 'stats'],
    queryFn: () => api.get<CompanyStats>('/company/stats'),
    enabled: canReadEmployees,
  });

  const dayQuery = useAttendanceToday(canReadAttendance);
  const rangeQuery = useAttendanceRange(range, canReadAttendance);
  // Only to supply the team of a row whose API build did not send one - see
  // applyRoster. Skipped entirely when the caller cannot read the employee list.
  const rosterQuery = useEmployeeRoster(canReadAttendance && canReadEmployees);

  const roster = rosterQuery.data;
  const dayRows = React.useMemo(
    () => applyRoster(dayQuery.data?.rows ?? [], roster),
    [dayQuery.data, roster],
  );
  const rangeRows = React.useMemo(
    () => applyRoster(rangeQuery.data?.rows ?? [], roster),
    [rangeQuery.data, roster],
  );

  // Every attendance figure on the page comes from these four folds, so the
  // KPI row, the ring, the tables and the alerts can never disagree.
  const today = React.useMemo(() => tallyDays(dayRows.flatMap((row) => row.days)), [dayRows]);
  const exceptions = React.useMemo(() => todayExceptions(dayRows), [dayRows]);
  const departments = React.useMemo(() => groupByDepartment(dayRows), [dayRows]);
  const teams = React.useMemo(() => groupByTeam(dayRows), [dayRows]);
  const trend = React.useMemo(() => buildTrend(rangeRows), [rangeRows]);
  const punches = React.useMemo(() => recentPunches(rangeRows), [rangeRows]);

  const rate = attendanceRate(today);
  const dayLoading = dayQuery.isLoading;
  const workingDay = today.scored > 0;

  /**
   * The day every attendance figure on this page was counted for.
   *
   * The same value `useAttendanceToday` asked the API for, so a drill-down
   * lands on exactly the day the reader clicked rather than on whatever the
   * destination would have defaulted to. The trend card's range picker does
   * not touch it - that scopes the chart and the punch list, not these counts.
   */
  const date = todayIso();

  return (
    <div className="space-y-6">
      <Hero
        name={session.user.firstName}
        company={session.company.name}
        rate={rate}
        workingDay={workingDay}
        loading={dayLoading && canReadAttendance}
        showRate={canReadAttendance}
      />

      {dayQuery.isError ? (
        <Card>
          <ErrorState error={dayQuery.error} onRetry={() => void dayQuery.refetch()} />
        </Card>
      ) : null}

      <section aria-label="Key figures">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <Kpi
            label="Total employees"
            value={statsQuery.data?.employees}
            hint={statsQuery.data ? `${statsQuery.data.activeEmployees} active` : undefined}
            icon={Users}
            tone="primary"
            loading={statsQuery.isLoading}
            to="/people"
            permission={PERMISSIONS.EMPLOYEE_READ}
          />
          <Kpi
            label="Present today"
            value={canReadAttendance ? today.present + today.halfDay : undefined}
            hint={today.halfDay > 0 ? `${today.halfDay} on a half day` : 'Checked in today'}
            icon={UserRound}
            tone="present"
            loading={dayLoading}
            to={teamAttendancePath({ status: 'PRESENT', date })}
            permission={PERMISSIONS.ATTENDANCE_READ}
          />
          <Kpi
            label="Absent today"
            value={canReadAttendance ? today.absent : undefined}
            hint="Working days with no record"
            icon={UserMinus}
            tone="absent"
            loading={dayLoading}
            to={teamAttendancePath({ status: 'ABSENT', date })}
            permission={PERMISSIONS.ATTENDANCE_READ}
          />
          <Kpi
            label="Late today"
            value={canReadAttendance ? today.late : undefined}
            hint="Arrived after the shift start"
            icon={AlarmClock}
            tone="late"
            loading={dayLoading}
            to={teamAttendancePath({ status: 'LATE', date })}
            permission={PERMISSIONS.ATTENDANCE_READ}
          />
          <Kpi
            label="On leave"
            value={canReadAttendance ? today.onLeave : undefined}
            hint="Approved leave today"
            icon={CalendarClock}
            tone="leave"
            loading={dayLoading}
            // The figure is a count of attendance days classified ON_LEAVE, so
            // it drills into those days. The leave register answers a different
            // question - which requests exist - and disagreed with this tile
            // whenever a request spanned a weekend.
            to={teamAttendancePath({ status: 'ON_LEAVE', date })}
            permission={PERMISSIONS.ATTENDANCE_READ}
          />
          <Kpi
            label="Departments"
            value={statsQuery.data?.departments}
            hint="Active"
            icon={Building2}
            tone="half-day"
            loading={statsQuery.isLoading}
            to="/organisation/departments"
            permission={PERMISSIONS.DEPARTMENT_READ}
          />
          <Kpi
            label="Teams"
            value={statsQuery.data?.teams}
            hint="Active"
            icon={Layers}
            tone="neutral"
            loading={statsQuery.isLoading}
            to="/organisation/teams"
            permission={PERMISSIONS.TEAM_READ}
          />
          <Kpi
            label="Attendance"
            value={canReadAttendance ? (rate === null ? '--' : `${rate}%`) : undefined}
            hint={workingDay ? `of ${today.scored} scored days` : 'No working day today'}
            icon={Percent}
            tone={rate === null ? 'neutral' : rate >= 90 ? 'present' : rate >= 75 ? 'late' : 'absent'}
            loading={dayLoading}
            // A rate is not a status, so this one carries the day and no filter.
            to={teamAttendancePath({ date })}
            permission={PERMISSIONS.ATTENDANCE_READ}
          />
        </div>
      </section>

      <QuickActions />

      {/* Above the company's figures: the cases and issues waiting on the
          person reading this. Renders itself away without a desk grant. */}
      <MyAssignedWorkCard />
      {/* Case messages that tagged this person. Renders itself away until
          somebody has. */}
      <MentionsCard />

      {canReadAttendance ? (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <OverviewCard counts={today} rate={rate} loading={dayLoading} date={date} />
            <TrendCard
              trend={trend}
              range={range}
              onRangeChange={setRange}
              loading={rangeQuery.isLoading}
              fetching={rangeQuery.isFetching}
              error={rangeQuery.error}
              onRetry={() => void rangeQuery.refetch()}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <GroupCard
              title="Department attendance"
              heading="Department"
              icon={Building2}
              rows={departments}
              loading={dayLoading}
              emptyLabel="No departments with people in them yet."
            />
            <GroupCard
              title="Team attendance"
              heading="Team"
              icon={Layers}
              rows={teams}
              loading={dayLoading || rosterQuery.isLoading}
              emptyLabel="No teams with people in them yet."
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <RecentPunchesCard
              punches={punches}
              rangeLabel={TREND_RANGES.find((r) => r.key === range)?.label ?? ''}
              loading={rangeQuery.isLoading}
            />
            <AlertsCard exceptions={exceptions} loading={dayLoading} workingDay={workingDay} />
          </div>
        </>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <RecentActivity />
        <AdminLinks />
      </div>

      {dayQuery.data?.truncated || rangeQuery.data?.truncated ? (
        <p className="text-[12px] text-muted-foreground">
          Attendance figures cover the first 2,000 people in your scope. Use the attendance
          screens for the full roll-up.
        </p>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- header

function Hero({
  name,
  company,
  rate,
  workingDay,
  loading,
  showRate,
}: {
  name: string;
  company: string;
  rate: number | null;
  workingDay: boolean;
  loading: boolean;
  showRate: boolean;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
      {/* A tint rather than a photograph: it gives the page a top edge without
          competing with the figures directly underneath it. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.09]"
        style={{
          background:
            'linear-gradient(115deg, var(--primary) 0%, var(--chart-leave) 45%, var(--chart-half-day) 100%)',
        }}
        aria-hidden
      />
      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="hidden size-12 shrink-0 place-items-center rounded-full sm:grid"
            style={{
              backgroundColor: 'color-mix(in oklab, var(--chart-late) 16%, transparent)',
              color: 'var(--chart-late)',
            }}
            aria-hidden
          >
            <Sun className="size-7" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-[26px]">
              {greeting()}, {name}!
            </h1>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Overview of your organisation at {company} · {longDate(todayIso())}
            </p>
          </div>
        </div>

        {showRate ? (
          <div className="flex shrink-0 items-center gap-4 rounded-xl border border-border bg-surface/70 px-4 py-3 backdrop-blur-sm">
            <span
              className="grid size-10 shrink-0 place-items-center rounded-lg"
              style={{
                backgroundColor: 'color-mix(in oklab, var(--primary) 14%, transparent)',
                color: 'var(--primary)',
              }}
              aria-hidden
            >
              <TrendingUp className="size-5" />
            </span>
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">Attendance today</p>
              {loading ? (
                <Skeleton className="mt-1 h-7 w-20" />
              ) : (
                <p className="text-2xl font-semibold leading-tight tracking-tight">
                  {rate === null ? '--' : `${rate}%`}
                  {!workingDay ? (
                    <span className="ml-2 align-middle text-[12px] font-normal text-muted-foreground">
                      not a working day
                    </span>
                  ) : null}
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- kpi tiles

type KpiTone = 'primary' | 'present' | 'absent' | 'late' | 'leave' | 'half-day' | 'neutral';

/**
 * Tile accents.
 *
 * The colour is on the icon chip and the top rule only - never on the figure
 * itself, which stays in text ink so it is legible whatever the accent is.
 */
const TONE_COLOR: Record<KpiTone, string> = {
  primary: 'var(--primary)',
  present: 'var(--chart-present)',
  absent: 'var(--chart-absent)',
  late: 'var(--chart-late)',
  leave: 'var(--chart-leave)',
  'half-day': 'var(--chart-half-day)',
  neutral: 'var(--muted-foreground)',
};

function Kpi({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  loading,
  to,
  permission,
}: {
  label: string;
  value: number | string | undefined;
  hint?: string;
  icon: LucideIcon;
  tone: KpiTone;
  loading?: boolean;
  to: string;
  /** Omitted when the destination is open to anyone who can see the tile. */
  permission?: string;
}) {
  const color = TONE_COLOR[tone];
  const { has } = usePermissions();
  // A tile that links somewhere the reader is not allowed to go is worse than
  // one that does not link at all, so the figure stays and the navigation goes.
  const linked = !permission || has(permission as never);

  const body = (
    <div className="flex items-center gap-4 p-4 sm:p-5">
      <span
        className="grid size-11 shrink-0 place-items-center rounded-xl sm:size-12"
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
          color,
        }}
        aria-hidden
      >
        <Icon className="size-5 sm:size-6" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground">
          <span className="truncate">{label}</span>
          {/* The one mark that separates a tile you can open from a tile that
              only reports. Present from the start on touch, where there is no
              hover to reveal it with. */}
          {linked ? (
            <ChevronRight
              className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 sm:opacity-0"
              aria-hidden
            />
          ) : null}
        </p>
        {loading ? (
          <Skeleton className="h-8 w-14" />
        ) : (
          <p className="text-[26px] font-bold leading-none tracking-tight">{value ?? '--'}</p>
        )}
        {hint ? (
          <p className="truncate pt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </div>
  );

  // A wash of the accent rather than a stripe: the reference look. The figure
  // stays in text ink so it reads whatever the accent is.
  const tint = {
    backgroundColor: `color-mix(in oklab, ${color} 5%, var(--card))`,
    borderColor: `color-mix(in oklab, ${color} 22%, var(--border))`,
  };

  const shell = 'relative block overflow-hidden rounded-xl border bg-card shadow-xs';

  return linked ? (
    <Link
      to={to}
      style={tint}
      className={cn(
        shell,
        // Hover and focus both move the border to the focus hue and lift the
        // card, so the tile reads as a control on a pointer and on a keyboard.
        // Touch gets neither, which is why the chevron above is not hover-only
        // below the `sm` breakpoint.
        'group transition-all duration-150 hover:border-ring hover:shadow-md focus-visible:border-ring focus-visible:shadow-md',
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={shell} style={tint}>
      {body}
    </div>
  );
}

// ------------------------------------------------------------------ overview

function OverviewCard({
  counts,
  rate,
  loading,
  date,
}: {
  counts: ReturnType<typeof tallyDays>;
  rate: number | null;
  loading: boolean;
  /** The day these counts describe, carried into every drill-down. */
  date: string;
}) {
  // The ring order is the validated one - each neighbouring pair was checked
  // for colour-vision separation in this sequence, so it is not free to change.
  // Late days are taken out of present and half day so nobody is drawn twice.
  //
  // Each slice links to the same day on team attendance, filtered to what the
  // slice counts. The filter is the one the API already classifies by, so the
  // list is the same fact this ring is drawn from rather than a second reading
  // of it - see team-attendance-filter.
  const slices: Slice[] = [
    {
      key: 'present',
      label: 'Present, on time',
      value: counts.present - counts.latePresent,
      color: 'var(--chart-present)',
      to: teamAttendancePath({ status: 'PRESENT', date }),
    },
    {
      key: 'half-day',
      label: 'Half day',
      value: counts.halfDay - counts.lateHalfDay,
      color: 'var(--chart-half-day)',
      to: teamAttendancePath({ status: 'HALF_DAY', date }),
    },
    {
      key: 'late',
      label: 'Late',
      value: counts.late,
      color: 'var(--chart-late)',
      to: teamAttendancePath({ status: 'LATE', date }),
    },
    {
      key: 'leave',
      label: 'On leave',
      value: counts.onLeave,
      color: 'var(--chart-leave)',
      to: teamAttendancePath({ status: 'ON_LEAVE', date }),
    },
    {
      key: 'absent',
      label: 'Absent',
      value: counts.absent,
      color: 'var(--chart-absent)',
      to: teamAttendancePath({ status: 'ABSENT', date }),
    },
  ];

  return (
    <Card className="flex flex-col">
      <CardHeader bordered>
        <CardTitle>Attendance overview</CardTitle>
        <p className="text-[12.5px] text-muted-foreground">
          Today, every scored working day counted once.
        </p>
      </CardHeader>

      {loading ? (
        <div className="flex flex-1 items-center gap-5 p-5">
          <Skeleton className="size-[168px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-6 w-full" />
            ))}
          </div>
        </div>
      ) : counts.scored === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No working day today"
          description="A weekend or a company holiday - nothing is scored, so nothing is charted."
          className="flex-1 justify-center py-12"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center gap-5 p-5 sm:flex-row sm:items-center">
          <DonutChart
            slices={slices}
            centerValue={rate === null ? '--' : `${rate}%`}
            centerLabel="attendance"
          />
          <SliceLegend slices={slices} />
        </div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------- trend

function TrendCard({
  trend,
  range,
  onRangeChange,
  loading,
  fetching,
  error,
  onRetry,
}: {
  trend: ReturnType<typeof buildTrend>;
  range: TrendRangeKey;
  onRangeChange: (key: TrendRangeKey) => void;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const { from, to } = trendRange(range);
  const scored = trend.filter((point) => point.scored > 0);
  const average =
    scored.length > 0
      ? Math.round(scored.reduce((sum, point) => sum + (point.rate ?? 0), 0) / scored.length)
      : null;

  return (
    <Card className="flex flex-col xl:col-span-2">
      <CardHeader bordered className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <CardTitle>Attendance trend</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            {shortDate(from)} - {shortDate(to)}
            {average !== null ? ` · ${average}% average attendance` : ''}
          </p>
        </div>
        {/* Scopes this card and the punch list beneath it, and nothing else. */}
        <div
          className="flex shrink-0 rounded-lg border border-border bg-surface-muted/60 p-0.5"
          role="group"
          aria-label="Trend range"
        >
          {TREND_RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onRangeChange(option.key)}
              aria-pressed={range === option.key}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
                range === option.key
                  ? 'bg-surface text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.short}
            </button>
          ))}
        </div>
      </CardHeader>

      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading ? (
        <div className="flex-1 p-5">
          <Skeleton className="h-44 w-full" />
        </div>
      ) : trend.length === 0 ? (
        <EmptyState
          icon={TrendingUp}
          title="Nothing recorded in this range"
          description="Attendance appears here once days have been captured or finalised."
          className="flex-1 justify-center py-12"
        />
      ) : (
        <div
          className={cn(
            'flex flex-1 flex-col justify-between gap-4 p-5 transition-opacity',
            // Held at reduced opacity on a refetch rather than replaced by a
            // skeleton, so switching range does not make the page jump.
            fetching && 'opacity-60',
          )}
        >
          <TrendChart points={trend} />
          <TrendLegend />
        </div>
      )}
    </Card>
  );
}

// -------------------------------------------------------------- group tables

function GroupCard({
  title,
  heading,
  icon,
  rows,
  loading,
  emptyLabel,
}: {
  title: string;
  heading: string;
  icon: LucideIcon;
  rows: GroupCounts[];
  loading: boolean;
  emptyLabel: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader bordered className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/attendance/team">
            Open
            <ChevronRight />
          </Link>
        </Button>
      </CardHeader>

      <TableWrapper>
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>{heading}</TH>
              <TH className="w-20 text-right">People</TH>
              <TH className="w-20 text-right">Present</TH>
              <TH className="w-20 text-right">Absent</TH>
              <TH className="w-16 text-right">Late</TH>
              <TH className="w-32 text-right">Attendance</TH>
            </TR>
          </THead>
          <TBody>
            {loading ? (
              <TableSkeleton rows={4} columns={6} />
            ) : rows.length === 0 ? (
              <TR className="hover:bg-transparent">
                <TD colSpan={6} className="p-0">
                  <EmptyState icon={icon} title={emptyLabel} className="py-10" />
                </TD>
              </TR>
            ) : (
              rows.map((row) => (
                <TR key={row.key}>
                  <TD className="text-[13px] font-medium">
                    {row.unassigned ? (
                      <span className="italic text-muted-foreground">{row.label}</span>
                    ) : (
                      row.label
                    )}
                  </TD>
                  <TD className="tabular text-right text-[13px] text-muted-foreground">
                    {row.employees}
                  </TD>
                  <TD className="tabular text-right text-[13px]">{row.present + row.halfDay}</TD>
                  <TD className="tabular text-right text-[13px]">
                    {row.absent > 0 ? (
                      <span style={{ color: 'var(--chart-absent)' }}>{row.absent}</span>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TD>
                  <TD className="tabular text-right text-[13px]">
                    {row.late > 0 ? (
                      <span style={{ color: 'var(--chart-late)' }}>{row.late}</span>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TD>
                  <TD className="text-right">
                    <RateMeter value={attendanceRate(row)} />
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}

// ------------------------------------------------------------------ punches

function RecentPunchesCard({
  punches,
  rangeLabel,
  loading,
}: {
  punches: PersonDay[];
  rangeLabel: string;
  loading: boolean;
}) {
  const { has } = usePermissions();

  return (
    <Card className="overflow-hidden xl:col-span-2">
      <CardHeader bordered className="flex-row items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>Recent attendance</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            Latest captured check-ins · {rangeLabel.toLowerCase()}
          </p>
        </div>
        {has(PERMISSIONS.DEVICE_READ) ? (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/attendance/punches">
              Device punches
              <ChevronRight />
            </Link>
          </Button>
        ) : null}
      </CardHeader>

      <TableWrapper>
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Employee</TH>
              <TH className="w-28">Code</TH>
              <TH className="w-32">Punch</TH>
              <TH className="w-28">Status</TH>
              <TH className="w-36">Department</TH>
              <TH className="w-32">Team</TH>
            </TR>
          </THead>
          <TBody>
            {loading ? (
              <TableSkeleton rows={5} columns={6} />
            ) : punches.length === 0 ? (
              <TR className="hover:bg-transparent">
                <TD colSpan={6} className="p-0">
                  <EmptyState
                    icon={Fingerprint}
                    title="No check-ins captured yet"
                    description="Punches from a terminal, or a check-in from the app, appear here."
                    className="py-10"
                  />
                </TD>
              </TR>
            ) : (
              punches.map((punch) => (
                <TR key={`${punch.employeeId}-${punch.day.date}`}>
                  <TD className="text-[13px]">
                    <Link
                      to={`/attendance/team/${punch.employeeId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {punch.employeeName}
                    </Link>
                  </TD>
                  <TD className="tabular text-[12.5px] text-muted-foreground">
                    {punch.employeeNumber}
                  </TD>
                  <TD className="tabular whitespace-nowrap text-[13px]">
                    <span className="font-medium">{clockTime(punch.day.checkInAt)}</span>
                    <span className="ml-1.5 text-[11.5px] text-muted-foreground">
                      {shortDate(punch.day.date)}
                    </span>
                  </TD>
                  <TD>
                    <Badge variant={STATUS_TONE[punch.day.status]}>
                      {punchLabel(punch.day)}
                    </Badge>
                  </TD>
                  <TD className="truncate text-[13px] text-muted-foreground">
                    {punch.departmentName ?? '--'}
                  </TD>
                  <TD className="truncate text-[13px] text-muted-foreground">
                    {punch.teamName ?? (
                      <span className="italic text-muted-foreground/80">Unassigned</span>
                    )}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </TableWrapper>
    </Card>
  );
}

// ------------------------------------------------------------------- alerts

function AlertsCard({
  exceptions,
  loading,
  workingDay,
}: {
  exceptions: ReturnType<typeof todayExceptions>;
  loading: boolean;
  workingDay: boolean;
}) {
  const groups = [
    {
      key: 'late',
      title: 'Arrived late',
      icon: AlarmClock,
      color: 'var(--chart-late)',
      people: exceptions.late,
      detail: (person: PersonDay) => `${person.day.lateMinutes} min late`,
    },
    {
      key: 'absent',
      title: 'Absent today',
      icon: UserMinus,
      color: 'var(--chart-absent)',
      people: exceptions.absent,
      detail: (person: PersonDay) => person.departmentName ?? 'No department',
    },
    {
      key: 'incomplete',
      title: 'Missing check-out',
      icon: Clock,
      color: 'var(--chart-half-day)',
      people: exceptions.incomplete,
      detail: (person: PersonDay) => `in at ${clockTime(person.day.checkInAt)}`,
    },
  ].filter((group) => group.people.length > 0);

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader bordered>
        <CardTitle>Attendance alerts</CardTitle>
        <p className="text-[12.5px] text-muted-foreground">Today, from captured records only.</p>
      </CardHeader>

      {loading ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={workingDay ? 'Nothing needs attention' : 'No working day today'}
          description={
            workingDay
              ? 'Everyone scored today arrived on time and closed their day.'
              : 'Alerts return on the next working day.'
          }
          className="flex-1 justify-center py-10"
        />
      ) : (
        <ul className="divide-y divide-border">
          {groups.map((group) => (
            <li key={group.key} className="px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-lg"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${group.color} 16%, transparent)`,
                    color: group.color,
                  }}
                  aria-hidden
                >
                  <group.icon className="size-4" />
                </span>
                <span className="flex-1 text-[13.5px] font-medium">{group.title}</span>
                <span className="tabular text-[13px] font-semibold">{group.people.length}</span>
              </div>
              <ul className="mt-2 space-y-1 pl-9.5">
                {group.people.slice(0, 3).map((person) => (
                  <li
                    key={person.employeeId}
                    className="flex items-baseline justify-between gap-3 text-[12.5px]"
                  >
                    <Link
                      to={`/attendance/team/${person.employeeId}`}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {person.employeeName}
                    </Link>
                    <span className="tabular shrink-0 text-muted-foreground">
                      {group.detail(person)}
                    </span>
                  </li>
                ))}
                {group.people.length > 3 ? (
                  <li className="text-[12px] text-muted-foreground">
                    and {group.people.length - 3} more
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto border-t border-border px-5 py-3">
        <Button variant="outline" size="sm" className="w-full" asChild>
          <Link to="/attendance/team">Review team attendance</Link>
        </Button>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------- quick actions

interface Action {
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
  color: string;
  permission?: string | string[];
}

function QuickActions() {
  const { has } = usePermissions();

  /*
   * The jobs an administrator starts from here, each behind the grant its
   * destination needs - a reader without it simply is not offered the tile.
   */
  const actions: Action[] = [
    {
      label: 'Create employee',
      description: 'New joiner',
      to: '/people?new=1',
      icon: UserPlus,
      color: 'var(--primary)',
      permission: PERMISSIONS.EMPLOYEE_MANAGE,
    },
    {
      label: 'Process payroll',
      description: 'Runs and preview',
      to: '/payroll',
      icon: Banknote,
      color: 'var(--chart-present)',
      permission: PERMISSIONS.PAYROLL_MANAGE,
    },
    {
      label: 'Review approvals',
      description: 'Waiting on you',
      to: '/approvals',
      icon: ClipboardCheck,
      color: 'var(--chart-late)',
      permission: PERMISSIONS.APPROVAL_ACT,
    },
    {
      label: 'Open case queue',
      description: 'Helpdesk',
      to: '/case-queue',
      icon: Headset,
      color: 'var(--chart-absent)',
      permission: [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL],
    },
    {
      label: 'Manage assets',
      description: 'Register',
      to: '/assets',
      icon: Boxes,
      color: 'var(--chart-half-day)',
      permission: PERMISSIONS.ASSET_READ_ALL,
    },
    {
      label: 'View reports',
      description: 'Attendance',
      to: '/attendance/reports',
      icon: BarChart3,
      color: 'var(--chart-half-day)',
      permission: PERMISSIONS.EMPLOYEE_READ,
    },
    {
      label: 'Manage leave',
      description: 'Requests',
      to: '/leave/requests',
      icon: CalendarClock,
      color: 'var(--chart-leave)',
      permission: PERMISSIONS.LEAVE_MANAGE,
    },
    {
      label: 'Manage loans',
      description: 'Loans & advances',
      to: '/loans',
      icon: HandCoins,
      color: 'var(--chart-late)',
      permission: [PERMISSIONS.LOAN_MANAGE, PERMISSIONS.LOAN_APPROVE],
    },
  ].filter(
    (action) => !action.permission || [action.permission].flat().some((p) => has(p as never)),
  );

  if (actions.length === 0) return null;

  return (
    <section
      aria-label="Quick actions"
      className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-xs sm:p-5"
    >
      <h2 className="text-[16px] font-semibold tracking-tight">Quick actions</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
        {actions.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className="group flex flex-col items-center gap-2.5 rounded-xl border p-4 text-center transition-all hover:-translate-y-0.5 hover:shadow-sm"
            style={{
              backgroundColor: `color-mix(in oklab, ${action.color} 6%, var(--card))`,
              borderColor: `color-mix(in oklab, ${action.color} 20%, var(--border))`,
            }}
          >
            <span
              className="grid size-11 place-items-center rounded-xl"
              style={{
                backgroundColor: `color-mix(in oklab, ${action.color} 15%, transparent)`,
                color: action.color,
              }}
              aria-hidden
            >
              <action.icon className="size-6" />
            </span>
            <span className="min-w-0 max-w-full">
              <span className="block text-[13px] font-semibold leading-snug">{action.label}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">
                {action.description}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- activity

/** Unchanged in substance from the previous dashboard - the audit feed. */
function RecentActivity() {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.AUDIT_READ);

  const query = useQuery({
    queryKey: ['audit-logs', { page: 1, limit: 6 }],
    queryFn: () => api.getPage<AuditLogEntry>('/audit-logs', { query: { page: 1, limit: 6 } }),
    enabled: canRead,
  });

  if (!canRead) return null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader bordered className="flex-row items-center justify-between">
        <CardTitle>Recent activity</CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings/audit">
            View all
            <ChevronRight />
          </Link>
        </Button>
      </CardHeader>

      {query.isLoading ? (
        <div className="space-y-4 p-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data && query.data.data.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden">
          {query.data.data.map((entry) => (
            <li key={entry.id} className="flex min-w-0 items-start gap-3 px-5 py-3">
              <span
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                aria-hidden
              >
                <ScrollText className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">{entry.summary ?? humanise(entry.action)}</p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {entry.actor?.fullName ?? 'System'} - {formatRelative(entry.createdAt)}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0">
                {entry.entityType}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={ScrollText}
          title="Nothing recorded yet"
          description="Actions taken in the system will appear here."
        />
      )}
    </Card>
  );
}

/** The administration shortcuts the previous dashboard carried. */
function AdminLinks() {
  const { has } = usePermissions();

  const links = [
    {
      label: 'Company profile',
      description: 'Name, address and localisation.',
      to: '/settings/company',
      icon: Building2,
      visible: has(PERMISSIONS.COMPANY_READ),
    },
    {
      label: 'Roles and permissions',
      description: 'Decide who can see and change what.',
      to: '/settings/roles',
      icon: KeyRound,
      visible: has(PERMISSIONS.ROLE_READ),
    },
    {
      label: 'Attendance policy',
      description: 'Shift grace, half day and overtime rules.',
      to: '/settings/attendance',
      icon: CircleAlert,
      visible: has(PERMISSIONS.COMPANY_READ),
    },
    {
      label: 'Audit log',
      description: 'Review every change made in the system.',
      to: '/settings/audit',
      icon: ScrollText,
      visible: has(PERMISSIONS.AUDIT_READ),
    },
  ].filter((link) => link.visible);

  return (
    <Card className="overflow-hidden">
      <CardHeader bordered>
        <CardTitle>Administration</CardTitle>
      </CardHeader>
      {links.length > 0 ? (
        <ul className="divide-y divide-border">
          {links.map(({ label, description, to, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-accent/50"
              >
                <span
                  className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
                  aria-hidden
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{label}</span>
                  <span className="block text-[12.5px] text-muted-foreground">{description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Settings}
          title="Nothing to configure"
          description="Your role does not include administration access."
          className="py-10"
        />
      )}
    </Card>
  );
}
