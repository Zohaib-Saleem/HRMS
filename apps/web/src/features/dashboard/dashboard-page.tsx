import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type DataScope } from '@hrms/shared';
import { api } from '@/lib/api';
import { FullPageLoader } from '@/components/feedback/states';
import { useAuthenticatedSession, usePermissions } from '@/features/auth/session-context';
import { CompanyDashboard } from './company-dashboard';
import { EmployeeDashboard } from './employee-dashboard';

/**
 * Which dashboard, decided by data scope rather than by permission.
 *
 * `company.read` is held by everyone - it is what lets the shell render the
 * company name - so it never distinguished a manager from an employee. Scope
 * does: only a caller who can see the whole company has any business being
 * shown the whole company's figures.
 */
export function DashboardPage() {
  const session = useAuthenticatedSession();

  /**
   * `dataScope` is published with the session by newer API builds. Where the
   * deployed API predates it the field is simply absent, and the old check -
   * `dataScope !== 'ALL'` - read `undefined !== 'ALL'` and sent *everyone* to
   * the employee dashboard, administrators included. So its absence falls
   * through to a probe rather than to a guess.
   */
  const scope = session.dataScope as DataScope | undefined;
  if (scope) return scope === 'ALL' ? <CompanyDashboard /> : <EmployeeDashboard />;

  return <ScopedDashboard />;
}

/**
 * Asks the server which dashboard the caller is entitled to.
 *
 * `/company/stats` is the one endpoint that already enforces exactly this
 * distinction - it refuses anyone whose scope is narrower than the whole
 * company - so the answer comes from the same authority that would enforce it,
 * rather than from a permission the client re-interprets. The result is cached
 * under the key the company dashboard reads, so the probe costs no extra
 * request once it lands.
 */
function ScopedDashboard() {
  const { has } = usePermissions();
  const canReadEmployees = has(PERMISSIONS.EMPLOYEE_READ);

  const probe = useQuery({
    queryKey: ['company', 'stats'],
    queryFn: () => api.get<{ employees: number }>('/company/stats'),
    enabled: canReadEmployees,
    // A 403 here is the answer, not a failure.
    retry: false,
    staleTime: 60_000,
  });

  if (!canReadEmployees) return <EmployeeDashboard />;
  if (probe.isLoading) return <FullPageLoader label="Loading your dashboard" />;

  // A 403 means "narrower than company-wide", which is the employee view. Any
  // other failure lands there too: it is the dashboard that asks least of the
  // server, so it is the safer side to fail towards.
  if (probe.isError) return <EmployeeDashboard />;

  return <CompanyDashboard />;
}
