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
import { ProfilePage } from '@/features/profile/profile-page';
import { SettingsLayout } from '@/features/settings/settings-layout';
import { EmployeeListPage } from '@/features/people/employee-list-page';
import { EmployeeDetailPage } from '@/features/people/employee-detail-page';
import { OrgChartPage } from '@/features/people/org-chart-page';
import { OrganisationLayout } from '@/features/organisation/organisation-layout';
import { DepartmentsPage } from '@/features/organisation/departments-page';
import { TeamsPage } from '@/features/organisation/teams-page';
import { DesignationsPage } from '@/features/organisation/designations-page';
import { LocationsPage } from '@/features/organisation/locations-page';
import { StructurePage } from '@/features/organisation/structure-page';
import { ApprovalsListPage } from '@/features/approvals/approvals-list-page';
import { ApprovalDetailPage } from '@/features/approvals/approval-detail-page';
import { AttendancePage } from '@/features/time/attendance-page';
import { ShiftsPage } from '@/features/time/shifts-page';
import { TimesheetsPage } from '@/features/time/timesheets-page';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/password-reset-pages';
import { CompanySettingsPage } from '@/features/settings/company-page';
import { RolesPage } from '@/features/settings/roles-page';
import { AuditLogPage } from '@/features/settings/audit-log-page';

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

        <Route element={<RequirePermission permission={PERMISSIONS.EMPLOYEE_READ} />}>
          <Route path="people" element={<EmployeeListPage />} />
          <Route path="people/org-chart" element={<OrgChartPage />} />
          <Route path="people/:id" element={<EmployeeDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.APPROVAL_READ} />}>
          <Route path="approvals" element={<ApprovalsListPage />} />
          <Route path="approvals/:id" element={<ApprovalDetailPage />} />
        </Route>

        <Route element={<RequirePermission permission={PERMISSIONS.ATTENDANCE_READ} />}>
          <Route path="attendance" element={<AttendancePage />} />
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
