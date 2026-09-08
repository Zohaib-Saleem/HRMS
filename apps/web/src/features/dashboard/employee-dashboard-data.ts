import { useQuery } from '@tanstack/react-query';
import {
  PERMISSIONS,
  type EmployeeDetail,
  type HolidayRecord,
  type LeaveBalanceRecord,
  type LeaveRequestRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useAuthenticatedSession, usePermissions } from '@/features/auth/session-context';
import { isLateArrival } from './dashboard-data';
import type { AttendanceDay, AttendanceTotals } from '@hrms/shared';

/**
 * The employee dashboard's data, composed from the endpoints that serve the
 * rest of the app.
 *
 * It used to come from a single `/me/dashboard` call. That route exists in the
 * API source but not in every deployed build, and a dashboard that dies with
 * "No route for GET /api/v1/me/dashboard" is worse than one assembled from
 * five requests that have been stable for far longer. So the payload is built
 * here from:
 *
 *   profile      <- the session, enriched by /employees/:id when readable
 *   attendance   <- /attendance/summary  (the caller's own month)
 *   balances     <- /leave/balances/me
 *   requests     <- /leave/requests      (scope-filtered to the caller)
 *   holidays     <- /holidays
 *
 * Every one of those is scoped to the caller by the server, so this composes
 * nothing the reader was not already entitled to see. Each part is optional:
 * a role without leave or holiday access simply renders those cards empty
 * rather than failing the whole screen.
 */

export interface LeaveRequestView {
  id: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  status: string;
  dayPart: string;
}

export interface EmployeeDashboardData {
  employeeLinked: boolean;
  message: string | null;
  profile: {
    employeeNumber: string;
    fullName: string;
    firstName: string;
    jobTitle: string | null;
    departmentName: string | null;
    teamName: string | null;
    designationName: string | null;
    managerName: string | null;
    status: string;
    employmentType: string | null;
    hireDate: string | null;
  } | null;
  leave: {
    balances: LeaveBalanceRecord[];
    pending: LeaveRequestView[];
    recent: LeaveRequestView[];
  } | null;
  upcoming: {
    holidays: { id: string; name: string; date: string }[];
    approvedLeave: LeaveRequestView[];
  } | null;
  attendanceMonth: {
    month: string;
    totals: {
      present: number;
      halfDay: number;
      absent: number;
      onLeave: number;
      holiday: number;
      weekend: number;
      upcoming: number;
      lateDays: number;
      workedMinutes: number;
    };
  } | null;
}

interface SummaryResponse {
  days: AttendanceDay[];
  totals: AttendanceTotals;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The calendar month the dashboard reports, in the same UTC day convention. */
function monthRange(): { from: string; to: string; month: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: isoDay(first), to: isoDay(last), month: isoDay(first).slice(0, 7) };
}

const toView = (request: LeaveRequestRecord): LeaveRequestView => ({
  id: request.id,
  leaveTypeName: request.leaveTypeName,
  startDate: request.startDate,
  endDate: request.endDate,
  totalDays: request.totalDays,
  status: request.status,
  dayPart: request.dayPart,
});

export function useEmployeeDashboard() {
  const session = useAuthenticatedSession();
  const { has } = usePermissions();

  const employee = session.user.employee ?? null;
  const employeeId = employee?.id ?? null;
  /**
   * `employeeLinked` is published by newer API builds; where it is absent the
   * session's own employee block answers the same question, since the server
   * only fills it in for a login that has a record behind it.
   */
  const employeeLinked = session.employeeLinked ?? employee !== null;

  const { from, to, month } = monthRange();

  const detailQuery = useQuery({
    queryKey: ['employees', employeeId],
    queryFn: () => api.get<EmployeeDetail>(`/employees/${employeeId}`),
    enabled: Boolean(employeeId) && has(PERMISSIONS.EMPLOYEE_READ),
    staleTime: 5 * 60_000,
    // A narrow role may not read employee records at all. That costs the
    // detail fields, not the dashboard, so the failure is never retried.
    retry: false,
  });

  const attendanceQuery = useQuery({
    queryKey: ['attendance', 'summary', 'me', from, to],
    queryFn: () => api.get<SummaryResponse>('/attendance/summary', { query: { from, to } }),
    enabled: employeeLinked && has(PERMISSIONS.ATTENDANCE_READ),
    staleTime: 60_000,
  });

  const balancesQuery = useQuery({
    queryKey: ['leave', 'balances', 'me'],
    queryFn: () => api.get<LeaveBalanceRecord[]>('/leave/balances/me'),
    enabled: employeeLinked && has(PERMISSIONS.LEAVE_READ),
    staleTime: 60_000,
    retry: false,
  });

  /**
   * The caller's own requests.
   *
   * `/leave/requests` applies the employee data scope, so an employee sees
   * exactly their own; the explicit employeeId keeps that true for a manager,
   * whose scope is wider, without relying on the scope to narrow it.
   */
  const requestsQuery = useQuery({
    queryKey: ['leave', 'requests', 'me', employeeId],
    queryFn: () =>
      api.getPage<LeaveRequestRecord>('/leave/requests', {
        query: { page: 1, limit: 20, employeeId: employeeId ?? undefined },
      }),
    enabled: Boolean(employeeId) && has(PERMISSIONS.LEAVE_READ),
    staleTime: 60_000,
    retry: false,
  });

  const holidaysQuery = useQuery({
    queryKey: ['holidays', 'upcoming', new Date().getUTCFullYear()],
    queryFn: () =>
      api.getPage<HolidayRecord>('/holidays', {
        query: { page: 1, limit: 100, year: new Date().getUTCFullYear(), isActive: 'true' },
      }),
    enabled: has(PERMISSIONS.HOLIDAY_READ),
    staleTime: 10 * 60_000,
    retry: false,
  });

  const today = isoDay(new Date());
  const detail = detailQuery.data;
  const requests = requestsQuery.data?.data ?? [];
  const summary = attendanceQuery.data;

  const data: EmployeeDashboardData = {
    employeeLinked,
    message: employeeLinked
      ? null
      : 'Your login is not linked to an employee record yet, so attendance and leave are unavailable.',
    profile: employee
      ? {
          employeeNumber: employee.employeeNumber,
          fullName: detail?.fullName ?? session.user.fullName,
          firstName: detail?.firstName ?? session.user.firstName,
          jobTitle: detail?.jobTitle ?? employee.jobTitle ?? null,
          departmentName: detail?.department?.name ?? employee.departmentName ?? null,
          teamName: detail?.team?.name ?? employee.teamName ?? null,
          designationName: detail?.designation?.name ?? null,
          managerName: detail?.manager?.fullName ?? null,
          status: detail?.status ?? 'ACTIVE',
          employmentType: detail?.employmentType ?? null,
          hireDate: detail?.hireDate ?? null,
        }
      : null,
    leave: {
      balances: balancesQuery.data ?? [],
      pending: requests.filter((r) => r.status === 'PENDING').map(toView),
      recent: requests.slice(0, 5).map(toView),
    },
    upcoming: {
      holidays: (holidaysQuery.data?.data ?? [])
        .filter((holiday) => holiday.date >= today)
        .slice(0, 4)
        .map((holiday) => ({ id: holiday.id, name: holiday.name, date: holiday.date })),
      approvedLeave: requests
        .filter((r) => r.status === 'APPROVED' && r.endDate >= today)
        .slice(0, 4)
        .map(toView),
    },
    attendanceMonth: summary
      ? {
          month,
          totals: {
            present: summary.totals.present,
            halfDay: summary.totals.halfDay,
            absent: summary.totals.absent,
            onLeave: summary.totals.onLeave,
            holiday: summary.totals.holiday,
            weekend: summary.totals.weekend,
            upcoming: summary.totals.upcoming,
            // The summary reports minutes late, not days. One late day is one
            // late day however many minutes it ran, so it is counted here - by
            // the same rule the company dashboard uses, so the two screens
            // cannot report different late counts for the same person.
            lateDays: summary.days.filter(isLateArrival).length,
            workedMinutes: summary.totals.workedMinutes,
          },
        }
      : null,
  };

  /**
   * Only attendance can fail the screen.
   *
   * Leave, holidays and the employee record are each optional decoration on a
   * dashboard whose subject is the caller's own month; losing one of them to a
   * permission should empty a card, not replace the page with an error.
   */
  return {
    data,
    isLoading: attendanceQuery.isLoading,
    isError: attendanceQuery.isError,
    error: attendanceQuery.error,
    refetch: () => {
      void attendanceQuery.refetch();
      void balancesQuery.refetch();
      void requestsQuery.refetch();
    },
  };
}
