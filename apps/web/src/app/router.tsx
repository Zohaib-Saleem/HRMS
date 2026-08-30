import * as React from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, FullPageLoader } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { LoginPage } from '@/features/auth/login-page';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/password-reset-pages';

/**
 * Route-level code splitting.
 *
 * Login and the dashboard stay in the entry bundle - they are what the first
 * paint needs. Everything else is a separate chunk fetched when its route is
 * first opened, so signing in no longer downloads the audit log, the org chart
 * and every settings screen along the way.
 *
 * `lazy` needs a default export, so each named page is adapted inline rather
 * than adding a default export to files that are also imported by name
 * elsewhere.
 */
const lazyPage = <K extends string>(
  load: () => Promise<Record<K, React.ComponentType>>,
  name: K,
) => React.lazy(async () => ({ default: (await load())[name] }));

const ProfilePage = lazyPage(() => import('@/features/profile/profile-page'), 'ProfilePage');
const SettingsLayout = lazyPage(
  () => import('@/features/settings/settings-layout'),
  'SettingsLayout',
);
const EmployeeListPage = lazyPage(
  () => import('@/features/people/employee-list-page'),
  'EmployeeListPage',
);
const EmployeeDetailPage = lazyPage(
  () => import('@/features/people/employee-detail-page'),
  'EmployeeDetailPage',
);
const OrgChartPage = lazyPage(() => import('@/features/people/org-chart-page'), 'OrgChartPage');
const OrganisationLayout = lazyPage(
  () => import('@/features/organisation/organisation-layout'),
  'OrganisationLayout',
);
const DepartmentsPage = lazyPage(
  () => import('@/features/organisation/departments-page'),
  'DepartmentsPage',
);
const TeamsPage = lazyPage(() => import('@/features/organisation/teams-page'), 'TeamsPage');
const DesignationsPage = lazyPage(
  () => import('@/features/organisation/designations-page'),
  'DesignationsPage',
);
const LocationsPage = lazyPage(
  () => import('@/features/organisation/locations-page'),
  'LocationsPage',
);
const StructurePage = lazyPage(
  () => import('@/features/organisation/structure-page'),
  'StructurePage',
);
const PayrollLayout = lazyPage(() => import('@/features/payroll/payroll-layout'), 'PayrollLayout');
const PayrollDashboardPage = lazyPage(
  () => import('@/features/payroll/payroll-dashboard-page'),
  'PayrollDashboardPage',
);
const PayrollRunsPage = lazyPage(
  () => import('@/features/payroll/payroll-runs-page'),
  'PayrollRunsPage',
);
const PayrollRunDetailPage = lazyPage(
  () => import('@/features/payroll/payroll-run-detail-page'),
  'PayrollRunDetailPage',
);
const PayrollProfilesPage = lazyPage(
  () => import('@/features/payroll/payroll-profiles-page'),
  'PayrollProfilesPage',
);
const SalaryComponentsPage = lazyPage(
  () => import('@/features/payroll/salary-components-page'),
  'SalaryComponentsPage',
);
const PayrollReportsPage = lazyPage(
  () => import('@/features/payroll/payroll-reports-page'),
  'PayrollReportsPage',
);
const PayrollSettingsPage = lazyPage(
  () => import('@/features/payroll/payroll-settings-page'),
  'PayrollSettingsPage',
);
const PayslipsPage = lazyPage(() => import('@/features/payroll/payslips-page'), 'PayslipsPage');
const PayslipPage = lazyPage(() => import('@/features/payroll/payslip-page'), 'PayslipPage');
const HelpHomePage = lazyPage(() => import('@/features/help/help-home-page'), 'HelpHomePage');
const HelpDocPage = lazyPage(() => import('@/features/help/help-doc-page'), 'HelpDocPage');
const UsersPage = lazyPage(() => import('@/features/settings/users-page'), 'UsersPage');
const ApprovalsListPage = lazyPage(
  () => import('@/features/approvals/approvals-list-page'),
  'ApprovalsListPage',
);
const ApprovalDetailPage = lazyPage(
  () => import('@/features/approvals/approval-detail-page'),
  'ApprovalDetailPage',
);
const AttendancePage = lazyPage(() => import('@/features/time/attendance-page'), 'AttendancePage');
const TeamAttendancePage = lazyPage(
  () => import('@/features/time/team-attendance-page'),
  'TeamAttendancePage',
);
const TeamAttendanceDetailPage = lazyPage(
  () => import('@/features/time/team-attendance-detail-page'),
  'TeamAttendanceDetailPage',
);
const ShiftsPage = lazyPage(() => import('@/features/time/shifts-page'), 'ShiftsPage');
const DevicesPage = lazyPage(() => import('@/features/devices/devices-page'), 'DevicesPage');
const PunchesPage = lazyPage(() => import('@/features/devices/punches-page'), 'PunchesPage');
const TimesheetsPage = lazyPage(() => import('@/features/time/timesheets-page'), 'TimesheetsPage');
const MyLeavePage = lazyPage(() => import('@/features/leave/my-leave-page'), 'MyLeavePage');
const LeaveRequestsPage = lazyPage(
  () => import('@/features/leave/leave-requests-page'),
  'LeaveRequestsPage',
);
const LeaveTypesPage = lazyPage(() => import('@/features/leave/leave-types-page'), 'LeaveTypesPage');
const HolidaysPage = lazyPage(() => import('@/features/leave/holidays-page'), 'HolidaysPage');
const CompanySettingsPage = lazyPage(
  () => import('@/features/settings/company-page'),
  'CompanySettingsPage',
);
const AttendancePolicyPage = lazyPage(
  () => import('@/features/settings/attendance-policy-page'),
  'AttendancePolicyPage',
);
const AttendancePoliciesPage = lazyPage(
  () => import('@/features/settings/attendance-policies-page'),
  'AttendancePoliciesPage',
);
const RolesPage = lazyPage(() => import('@/features/settings/roles-page'), 'RolesPage');
const AuditLogPage = lazyPage(() => import('@/features/settings/audit-log-page'), 'AuditLogPage');

/** Blocks the whole authenticated area until the session resolves. */
function ProtectedRoutes() {
  const { session, isLoading, isError, error, refetch } = useSession();
  const location = useLocation();

  if (isLoading) return <FullPageLoader label="Loading your workspace" />;

  if (isError) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <Card className="w-full max-w-md">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Card>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <AppShell />;
}

/** Route-level permission gate. Renders a clear message instead of a redirect. */
function RequirePermission({
  permission,
  mode = 'all',
}: {
  permission: Permission | Permission[];
  mode?: 'all' | 'any';
}) {
  const { permissions } = useSession();
  const list = Array.isArray(permission) ? permission : [permission];
  const allowed =
    mode === 'any' ? list.some((p) => permissions.has(p)) : list.every((p) => permissions.has(p));

  if (!allowed) {
    return (
      <Card>
        <EmptyState
          title="You do not have access to this page"
          description="Ask an administrator if you think you should be able to see it."
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/">Back to dashboard</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return <Outlet />;
}

/** Sends /organisation to the first section the user can actually open. */
function OrganisationIndexRedirect() {
  const { permissions } = useSession();
  if (permissions.has(PERMISSIONS.DEPARTMENT_READ)) {
    return <Navigate to="/organisation/departments" replace />;
  }
  if (permissions.has(PERMISSIONS.TEAM_READ)) return <Navigate to="/organisation/teams" replace />;
  if (permissions.has(PERMISSIONS.DESIGNATION_READ)) {
    return <Navigate to="/organisation/designations" replace />;
  }
  if (permissions.has(PERMISSIONS.LOCATION_READ)) {
    return <Navigate to="/organisation/locations" replace />;
  }
  return <Navigate to="/" replace />;
}

/** Sends /settings to the first section the user can actually open. */
function SettingsIndexRedirect() {
  const { permissions } = useSession();
  if (permissions.has(PERMISSIONS.COMPANY_READ)) return <Navigate to="/settings/company" replace />;
  if (permissions.has(PERMISSIONS.ROLE_READ)) return <Navigate to="/settings/roles" replace />;
  if (permissions.has(PERMISSIONS.AUDIT_READ)) return <Navigate to="/settings/audit" replace />;
  return <Navigate to="/" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoutes />}>
        <Route index element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />

        {/* Any signed-in user; the server decides which documents they get. */}
        <Route path="help" element={<HelpHomePage />} />
        <Route path="help/:slug" element={<HelpDocPage />} />

        <Route element={<RequirePermission permission={PERMISSIONS.EMPLOYEE_READ} />}>
          <Route path="people" element={<EmployeeListPage />} />
          <Route path="people/org-chart" element={<OrgChartPage />} />
          <Route path="people/:id" element={<EmployeeDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.APPROVAL_READ} />}>
          <Route path="approvals" element={<ApprovalsListPage />} />
          <Route path="approvals/:id" element={<ApprovalDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.LEAVE_READ} />}>
          <Route path="leave" element={<Navigate to="/leave/me" replace />} />
          <Route path="leave/me" element={<MyLeavePage />} />
          <Route path="leave/requests" element={<LeaveRequestsPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.LEAVE_MANAGE} />}>
          <Route path="leave/types" element={<LeaveTypesPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.HOLIDAY_READ} />}>
          <Route path="holidays" element={<HolidaysPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.ATTENDANCE_READ} />}>
          <Route path="attendance" element={<AttendancePage />} />
          {/* Scope, not a separate permission, decides who appears here. */}
          <Route path="attendance/team" element={<TeamAttendancePage />} />
          {/* Scope is enforced server-side, so a guessed id reveals nothing. */}
          <Route path="attendance/team/:employeeId" element={<TeamAttendanceDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.DEVICE_READ} />}>
          <Route path="attendance/devices" element={<DevicesPage />} />
          <Route path="attendance/punches" element={<PunchesPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.PAYROLL_READ} />}>
          <Route path="payroll" element={<PayrollLayout />}>
            <Route index element={<PayrollDashboardPage />} />
            <Route path="runs" element={<PayrollRunsPage />} />
            <Route path="profiles" element={<PayrollProfilesPage />} />
            <Route path="components" element={<SalaryComponentsPage />} />
            <Route path="reports" element={<PayrollReportsPage />} />
            <Route element={<RequirePermission permission={PERMISSIONS.PAYROLL_MANAGE} />}>
              <Route path="settings" element={<PayrollSettingsPage />} />
            </Route>
          </Route>
          {/* Outside the layout: a single run fills the page on its own. */}
          <Route path="payroll/runs/:id" element={<PayrollRunDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.PAYSLIP_READ} />}>
          <Route path="payslips" element={<PayslipsPage />} />
          <Route path="payslips/:id" element={<PayslipPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.SHIFT_READ} />}>
          <Route path="shifts" element={<ShiftsPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.TIMESHEET_READ} />}>
          <Route path="timesheets" element={<TimesheetsPage />} />
        </Route>

        <Route
          path="organisation"
          element={
            <RequirePermission
              mode="any"
              permission={[
                PERMISSIONS.DEPARTMENT_READ,
                PERMISSIONS.TEAM_READ,
                PERMISSIONS.DESIGNATION_READ,
                PERMISSIONS.LOCATION_READ,
              ]}
            />
          }
        >
          <Route element={<OrganisationLayout />}>
            <Route index element={<OrganisationIndexRedirect />} />
            <Route element={<RequirePermission permission={PERMISSIONS.DEPARTMENT_READ} />}>
              <Route path="departments" element={<DepartmentsPage />} />
              <Route path="structure" element={<StructurePage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.TEAM_READ} />}>
              <Route path="teams" element={<TeamsPage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.DESIGNATION_READ} />}>
              <Route path="designations" element={<DesignationsPage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.LOCATION_READ} />}>
              <Route path="locations" element={<LocationsPage />} />
            </Route>
          </Route>
        </Route>

        <Route
          path="settings"
          element={
            <RequirePermission
              mode="any"
              permission={[PERMISSIONS.COMPANY_READ, PERMISSIONS.ROLE_READ, PERMISSIONS.AUDIT_READ]}
            />
          }
        >
          <Route element={<SettingsLayout />}>
            <Route index element={<SettingsIndexRedirect />} />
            <Route element={<RequirePermission permission={PERMISSIONS.COMPANY_READ} />}>
              <Route path="company" element={<CompanySettingsPage />} />
              <Route path="attendance" element={<AttendancePolicyPage />} />
              <Route path="attendance-policies" element={<AttendancePoliciesPage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.USER_READ} />}>
              <Route path="users" element={<UsersPage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.ROLE_READ} />}>
              <Route path="roles" element={<RolesPage />} />
            </Route>
            <Route element={<RequirePermission permission={PERMISSIONS.AUDIT_READ} />}>
              <Route path="audit" element={<AuditLogPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function NotFoundPage() {
  return (
    <Card>
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="That screen either does not exist yet or has moved."
        action={
          <Button variant="outline" size="sm" asChild>
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </Card>
  );
}
