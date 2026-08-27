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

      <Route element={<ProtectedRoutes />}>
        <Route index element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />

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
