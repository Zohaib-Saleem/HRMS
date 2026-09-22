import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type DataScope } from '@hrms/shared';
import { api } from '@/lib/api';
import { FullPageLoader } from '@/components/feedback/states';
import { useAuthenticatedSession, usePermissions } from '@/features/auth/session-context';
import { CompanyDashboard } from './company-dashboard';
import { EmployeeDashboard } from './employee-dashboard';

/**
 * Which dashboard, decided by data scope AND by the one permission the company
 * dashboard is actually built on.
 *
 * `company.read` is held by everyone - it is what lets the shell render the
 * company name - so it never distinguished a manager from an employee, and
 * scope was brought in to do that job instead: only a caller who can see the
 * whole company has any business being shown the whole company's figures.
 *
 * Scope alone turned out not to be enough either, and the failure is worth
 * recording because it is the reason for the second half of the test below. A
 * company built a role for the person who looks after the laptops and gave it
 * an ALL data scope, because the asset register IS company-wide. That role
 * holds no HR permission of any kind - and it landed here, on a page of
 * headcount, present/absent/late and department attendance, because scope was
 * the only question being asked. Half the page then 403'd (`/company/stats`
 * needs `employee.read`, which the role has not got) while the attendance half
 * rendered the whole company.
 *
 * So the test is both: `employee.read` is what every figure on that page needs -
 * the headcount tiles directly, the attendance aggregate because it is a
 * statement about other people - and the scope says how much of it. Super
 * Admin, HR Admin and Manager all hold the grant, so nothing changes for them.
 *
 * The SERVER enforces the same thing independently: `/company/stats` refuses a
 * caller without the grant, and `attendancePeopleFilter` narrows attendance to
 * the caller's own record without it. This decides which page to draw; it is
 * not what keeps the data in.
 */
export function DashboardPage() {
  const session = useAuthenticatedSession();
  const { has } = usePermissions();

  /*
   * Without the directory grant there is no company dashboard to show, at any
   * scope - so the probe below is skipped as well, rather than asking the
   * server a question whose answer cannot change the outcome.
   */
  if (!has(PERMISSIONS.EMPLOYEE_READ)) return <EmployeeDashboard />;

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
  const probe = useQuery({
    queryKey: ['company', 'stats'],
    queryFn: () => api.get<{ employees: number }>('/company/stats'),
    // A 403 here is the answer, not a failure.
    retry: false,
    staleTime: 60_000,
  });

  if (probe.isLoading) return <FullPageLoader label="Loading your dashboard" />;

  // A 403 means "narrower than company-wide", which is the employee view. Any
  // other failure lands there too: it is the dashboard that asks least of the
  // server, so it is the safer side to fail towards.
  if (probe.isError) return <EmployeeDashboard />;

  return <CompanyDashboard />;
}
