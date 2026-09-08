import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CalendarOff,
  CircleAlert,
  Clock,
  Plane,
  UserRound,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { AttendanceToday } from '@/features/time/attendance-today';
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
  const totals = data?.attendanceMonth?.totals;
  const loading = query.isLoading;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${profile?.firstName ?? ''}`.trim()}
        description={
          profile
            ? [profile.jobTitle, profile.departmentName].filter(Boolean).join(' · ') ||
              `Employee ${profile.employeeNumber}`
            : undefined
        }
      />

      {/* Today: the reusable card, so check-in behaves identically here and on
          the attendance screen rather than being reimplemented. */}
      <AttendanceToday />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Leave balance</CardTitle>
            <Button variant="outline" size="sm" asChild>
              <Link to="/leave/me">Apply for leave</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : data?.leave?.balances.length ? (
              <ul className="divide-y">
                {data.leave.balances.map((balance) => (
                  <li key={balance.leaveTypeId} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm font-medium">{balance.leaveTypeName}</p>
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

        <Card>
          <CardHeader>
            <CardTitle>Your leave requests</CardTitle>
          </CardHeader>
          <CardContent>
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

        <Card>
          <CardHeader>
            <CardTitle>Coming up</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : (data?.upcoming?.holidays.length ?? 0) +
                (data?.upcoming?.approvedLeave.length ?? 0) >
              0 ? (
              <ul className="divide-y">
                {data?.upcoming?.holidays.map((holiday) => (
                  <li key={holiday.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="text-muted-foreground size-4" />
                      <span className="text-sm">{holiday.name}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">{dayLabel(holiday.date)}</span>
                  </li>
                ))}
                {data?.upcoming?.approvedLeave.map((request) => (
                  <li key={request.id} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <Plane className="text-muted-foreground size-4" />
                      <span className="text-sm">{request.leaveTypeName} (approved)</span>
                    </div>
                    <span className="text-muted-foreground text-xs">{rangeLabel(request)}</span>
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

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle>Your details</CardTitle>
            <Button variant="outline" size="sm" asChild>
              <Link to="/profile">Edit profile</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : profile ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground text-xs">Employee number</dt>
                  <dd className="font-medium">{profile.employeeNumber}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Status</dt>
                  <dd>
                    <Badge variant={profile.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {profile.status.toLowerCase().replace('_', ' ')}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Designation</dt>
                  <dd className="font-medium">{profile.designationName ?? '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Team</dt>
                  <dd className="font-medium">{profile.teamName ?? '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Manager</dt>
                  <dd className="font-medium">{profile.managerName ?? '--'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Joined</dt>
                  <dd className="font-medium">
                    {profile.hireDate ? dayLabel(profile.hireDate) : '--'}
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState icon={UserRound} title="Profile unavailable" />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
