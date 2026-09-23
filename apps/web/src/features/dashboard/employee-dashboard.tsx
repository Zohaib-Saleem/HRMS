import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CalendarOff,
  CircleAlert,
  Clock,
  Plane,
  UserRound,
} from 'lucide-react';
import { EMPLOYMENT_STATUS_LABELS, type LeaveBalanceRecord } from '@hrms/shared';
import { PageHeader } from '@/components/layout/page-header';
import { DashboardGrid, DashboardStack } from '@/components/layout/dashboard-grid';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { AttendanceToday } from '@/features/time/attendance-today';
import { MyCorrectionsCard } from '@/features/time/my-corrections-card';
import { MyLoansCard } from '@/features/loans/my-loans-card';
import { MyMedicalCard } from '@/features/medical/my-medical-card';
import { MyCasesCard } from '@/features/cases/my-cases-card';
import { MyAssetsCard } from '@/features/assets/my-assets-card';
import { AssetOperationsCard } from '@/features/assets/asset-operations-card';
import { LunchTodayCard } from '@/features/lunch/lunch-today-card';
import { useAuthenticatedSession } from '@/features/auth/session-context';
import { MyAttendanceBarsCard } from './my-attendance-bars-card';
import { CompanyMoments } from './company-moments';
import { useEmployeeDashboard, type LeaveRequestView } from './employee-dashboard-data';

/**
 * The dashboard an employee sees.
 *
 * Everything here is about the person looking at it. The company dashboard -
 * headcount, department counts, active accounts, hiring rate - is a management
 * view and lives in `CompanyDashboard`; showing it to an employee published
 * figures their data scope does not cover, and told them nothing they could act
 * on. What an employee needs on landing is narrow and practical: am I checked
 * in, how much leave do I have, what have I asked for, and what is coming up.
 */

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  APPROVED: 'success',
  PENDING: 'warning',
  REJECTED: 'destructive',
  CANCELLED: 'neutral',
};

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function rangeLabel(request: LeaveRequestView): string {
  return request.startDate === request.endDate
    ? dayLabel(request.startDate)
    : `${dayLabel(request.startDate)} - ${dayLabel(request.endDate)}`;
}

/**
 * Today, spelled out: `Thursday, 17 September 2026`.
 *
 * On the dashboard because the first thing somebody checks against a screen
 * about "today" is whether the screen agrees with them about which day that is.
 * Read in the browser's own locale and zone, like every other clock in this app.
 */
function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Leave, as one number.
 *
 * The detailed balance - every type, used, pending, entitlement - is further
 * down the page and stays there; this is the glance that answers "have I got
 * any left" without reading a table. The figure is the sum of what the server
 * already computed per type, not a second calculation: nothing here decides
 * what a day of leave is worth.
 *
 * Deliberately fed from the dashboard's own balances rather than fetching
 * again, so the tile and the card below it can never disagree.
 */
function TodayLeaveCard({
  balances,
  loading,
}: {
  balances: readonly LeaveBalanceRecord[];
  loading: boolean;
}) {
  const available = balances.reduce((sum, balance) => sum + balance.availableDays, 0);
  const pending = balances.reduce((sum, balance) => sum + balance.pendingDays, 0);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Leave</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13.5px] font-medium">
                {balances.length === 0 ? (
                  'No leave types'
                ) : (
                  <>
                    <span className="tabular">{available}</span> day
                    {available === 1 ? '' : 's'} remaining
                  </>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {balances.length === 0
                  ? 'An administrator has not set them up yet.'
                  : pending > 0
                    ? `${pending} day${pending === 1 ? '' : 's'} awaiting approval`
                    : 'Across every leave type'}
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link to="/leave/me">View leave</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function EmployeeDashboard() {
  /**
   * Composed from the endpoints the rest of the app uses - see
   * employee-dashboard-data. This screen used to depend on a single
   * `/me/dashboard` route, which is absent from some deployed API builds and
   * took the whole dashboard down with it when it 404'd.
   */
  const query = useEmployeeDashboard();
  // Named, not hardcoded: the heading over the celebration cards reads "Today
  // at <company>", and this product serves more than one company.
  const companyName = useAuthenticatedSession().company?.name ?? null;

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const data = query.data;

  /**
   * A login with no employee record behind it.
   *
   * Reported plainly instead of rendering the ordinary dashboard against empty
   * data, which would have read as "no leave, absent all month" - alarming and
   * wrong. There is nothing the person can do about it themselves, so the
   * message names who can.
   */
  if (data && !data.employeeLinked) {
    return (
      <>
        <PageHeader title="Your workspace" />
        <Card>
          <EmptyState
            icon={CircleAlert}
            title="Employee profile not configured"
            description={
              data.message ??
              'Your login is not linked to an employee record yet, so attendance and leave are unavailable.'
            }
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/help">Read the help centre</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  }

  const profile = data?.profile ?? null;
  const attendanceMonth = data?.attendanceMonth ?? null;
  const totals = attendanceMonth?.totals;
  const loading = query.isLoading;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${profile?.firstName ?? ''}`.trim()}
        description={
          /*
           * The date leads, then the employment line that was here before it.
           * Somebody landing on a page of today's actions wants to see today
           * named; their own job title is context, not news.
           */
          profile
            ? [
                todayLabel(),
                /*
                 * The employee's own employment status, shown beside the title
                 * and department they already see here. Read-only: nothing under
                 * /me writes an employee record, and changing it needs
                 * employee.manage on the People screen.
                 */
                [
                  profile.jobTitle,
                  profile.departmentName,
                  profile.employmentStatus
                    ? EMPLOYMENT_STATUS_LABELS[profile.employmentStatus]
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || `Employee ${profile.employeeNumber}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : todayLabel()
        }
      />

      <DashboardStack>
        {/*
          * TODAY, and it is the whole top of the screen now.
          *
          * The four things an employee comes here to settle before lunchtime -
          * am I checked in, have I ordered, is anything of mine open, how much
          * leave is left - used to be spread from the top of this page to the
          * bottom of it, with lunch and cases in the last row below the leave
          * balance and the holiday list. An employee who scrolled that far had
          * usually already missed lunch.
          *
          * Attendance leads as a full-width card rather than as a fourth tile,
          * because it is the only one of the four that is also a CONTROL: it
          * carries check-in, check-out and the work-location picker. A compact
          * tile repeating "Present 09:04" above it would be a second attendance
          * widget saying the same thing with no button on it.
          *
          * Its own bottom margin is dropped here: the spacing between the rows
          * of this page belongs to `DashboardStack` and is the same everywhere.
          * The attendance page, which has no such stack, keeps it.
          */}
        <AttendanceToday className="mb-0" />

        {/*
          * The day's three service cards - lunch, cases, equipment - as ONE
          * row: three across on a desktop, two on a tablet, stacked on a phone.
          *
          * They are a row and not four cards in a three-column grid, which is
          * what this was. The leave summary was the fourth, so at any width
          * where three fitted it wrapped onto a second line by itself and read
          * as a card that had come loose from the row above it. It has its own
          * full-width band below now, level with attendance.
          *
          * Heights come from `DashboardGrid`: the row stretches its children
          * and each card fills it, so the card with four case counts in it and
          * the card with "not ordered" in it end at the same line. The row that
          * was here asked for `items-start` precisely to avoid that, back when
          * the alternative was one tall card padding out two short ones; with
          * the cards themselves laying their content out in a column that
          * trade-off is gone.
          *
          * Each card renders itself away when the permission behind it is
          * absent, so a narrow role gets fewer cards rather than empty ones -
          * and the grid closes up behind it rather than leaving a hole.
          */}
        <DashboardGrid columns={3}>
          <LunchTodayCard />
          <MyCasesCard />
          {/* Renders itself away without `asset.read`. It carries the
              acknowledgement prompt from section 7, which is the one thing in
              this module an employee is asked to answer. */}
          <MyAssetsCard />
        </DashboardGrid>

        {/* Leave, as one number, full width beneath the service row - the same
            shape as the attendance band above it, and the same left and right
            edges. The detailed balance is further down and stays there. */}
        <TodayLeaveCard balances={data?.leave?.balances ?? []} loading={loading} />

        {/*
          * The asset register, for whoever runs it.
          *
          * Renders itself away without `asset.read.all`, so this is four tiles
          * on one person's dashboard and nothing at all on everybody else's. It
          * sits here - under the day's own cards, above the month - because for
          * the person who holds that grant the register is the job, and their
          * attendance is their attendance.
          *
          * It is the only company-wide figure on this page, and it is about
          * EQUIPMENT. See the card for why that is a different kind of number
          * from a company-wide attendance figure, which is about people and is
          * not on this page at any scope.
          */}
        <AssetOperationsCard />

        {/* My attendance: the month as bars, drawn by the same component the
            /attendance page uses and from the very request the figures below are
            counted from. Above the tiles because it is the shape of the month;
            the tiles are its totals. */}
        {attendanceMonth ? (
          <MyAttendanceBarsCard
            days={attendanceMonth.days}
            employeeName={profile?.fullName ?? 'You'}
            month={attendanceMonth.month}
            loading={loading}
          />
        ) : null}

        <DashboardGrid columns={4}>
          <StatCard
            label="Present this month"
            value={totals ? totals.present + totals.halfDay : undefined}
            icon={Clock}
            tone="success"
            hint={totals ? `${(totals.workedMinutes / 60).toFixed(1)} hours worked` : undefined}
            loading={loading}
          />
          <StatCard
            label="Absent"
            value={totals?.absent}
            icon={CalendarOff}
            tone={totals && totals.absent > 0 ? 'warning' : 'default'}
            hint="Past working days only"
            loading={loading}
          />
          <StatCard
            label="Late days"
            value={totals?.lateDays}
            icon={CircleAlert}
            tone={totals && totals.lateDays > 0 ? 'warning' : 'default'}
            loading={loading}
          />
          <StatCard
            label="On leave"
            value={totals?.onLeave}
            icon={Plane}
            hint={totals ? `${totals.upcoming} day(s) still to come` : undefined}
            loading={loading}
          />
        </DashboardGrid>

        {/*
          * Company moments: birthdays, work anniversaries and new joiners.
          *
          * Below the month and above the reference cards - upper-middle, which is
          * the compromise the two pressures on it want. At the very top it pushed
          * the employee's own actions down the page on any day somebody had a
          * birthday; at the foot, where it originally sat, people found out about
          * a colleague's birthday the day after it happened.
          *
          * Absent entirely on a quiet day, heading and all, so it costs the
          * dashboard no height when there is nothing to celebrate. See
          * company-moments.
          */}
        <CompanyMoments moments={data?.moments ?? null} companyName={companyName} />

        <DashboardGrid columns={2}>
          <Card className="flex h-full flex-col">
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>Leave balance</CardTitle>
              <Button variant="outline" size="sm" asChild>
                <Link to="/leave/me">Apply for leave</Link>
              </Button>
            </CardHeader>
            <CardContent className="flex-1">
              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : data?.leave?.balances.length ? (
                <ul className="divide-y">
                  {data.leave.balances.map((balance) => (
                    <li
                      key={balance.leaveTypeId}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{balance.leaveTypeName}</p>
                        <p className="text-muted-foreground text-xs">
                          {balance.usedDays} used · {balance.pendingDays} pending · of{' '}
                          {balance.annualEntitlementDays}/yr
                        </p>
                      </div>
                      <span className="text-lg font-semibold tabular-nums">
                        {balance.availableDays}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={Plane}
                  title="No leave types yet"
                  description="An administrator has not set up leave types for your company."
                />
              )}
            </CardContent>
          </Card>

          <Card className="flex h-full flex-col">
            <CardHeader>
              <CardTitle>Coming up</CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
              {loading ? (
                <Skeleton className="h-20 w-full" />
              ) : (data?.upcoming?.holidays.length ?? 0) +
                  (data?.upcoming?.approvedLeave.length ?? 0) >
                0 ? (
                <ul className="divide-y">
                  {data?.upcoming?.holidays.map((holiday) => (
                    <li key={holiday.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <CalendarDays className="text-muted-foreground size-4 shrink-0" />
                        <span className="truncate text-sm">{holiday.name}</span>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {dayLabel(holiday.date)}
                      </span>
                    </li>
                  ))}
                  {data?.upcoming?.approvedLeave.map((request) => (
                    <li key={request.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Plane className="text-muted-foreground size-4 shrink-0" />
                        <span className="truncate text-sm">{request.leaveTypeName} (approved)</span>
                      </div>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {rangeLabel(request)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={CalendarDays}
                  title="Nothing scheduled"
                  description="Upcoming company holidays and your approved leave will show here."
                />
              )}
            </CardContent>
          </Card>

          <Card className="flex h-full flex-col">
            <CardHeader>
              <CardTitle>Your leave requests</CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
              {loading ? (
                <Skeleton className="h-20 w-full" />
              ) : data?.leave?.recent.length ? (
                <ul className="divide-y">
                  {data.leave.recent.map((request) => (
                    <li key={request.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{request.leaveTypeName}</p>
                        <p className="text-muted-foreground text-xs">
                          {rangeLabel(request)} · {request.totalDays} day
                          {request.totalDays === 1 ? '' : 's'}
                        </p>
                      </div>
                      <Badge variant={STATUS_TONE[request.status] ?? 'neutral'}>
                        {request.status.toLowerCase()}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={Plane}
                  title="No requests yet"
                  description="Leave you request will appear here with its approval status."
                  action={
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/leave/me">Request leave</Link>
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>

          <Card className="flex h-full flex-col">
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>Your details</CardTitle>
              <Button variant="outline" size="sm" asChild>
                <Link to="/profile">Edit profile</Link>
              </Button>
            </CardHeader>
            <CardContent className="flex-1">
              {loading ? (
                <Skeleton className="h-20 w-full" />
              ) : profile ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Employee number</dt>
                    <dd className="truncate font-medium">{profile.employeeNumber}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Status</dt>
                    <dd>
                      <Badge variant={profile.status === 'ACTIVE' ? 'success' : 'neutral'}>
                        {profile.status.toLowerCase().replace('_', ' ')}
                      </Badge>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Designation</dt>
                    <dd className="truncate font-medium">{profile.designationName ?? '--'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Team</dt>
                    <dd className="truncate font-medium">{profile.teamName ?? '--'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Manager</dt>
                    <dd className="truncate font-medium">{profile.managerName ?? '--'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground text-xs">Joined</dt>
                    <dd className="truncate font-medium">
                      {profile.hireDate ? dayLabel(profile.hireDate) : '--'}
                    </dd>
                  </div>
                </dl>
              ) : (
                <EmptyState icon={UserRound} title="Profile unavailable" />
              )}
            </CardContent>
          </Card>
        </DashboardGrid>

        {/* Self-service, after the reference cards above: these are things an
            employee comes here to DO rather than to read, and they sit below the
            month, the leave balance and what is coming up because those answer
            the questions somebody lands on this page with. Each card renders
            itself away when the permission behind it is absent, so a narrow role
            gets a shorter dashboard rather than a broken one. */}
        <DashboardGrid columns={3}>
          <MyCorrectionsCard />
          <MyLoansCard />
          <MyMedicalCard />
        </DashboardGrid>
      </DashboardStack>
    </>
  );
}
