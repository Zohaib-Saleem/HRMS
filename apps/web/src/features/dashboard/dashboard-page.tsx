import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Building2,
  CalendarClock,
  KeyRound,
  Layers,
  ScrollText,
  Settings,
  UserPlus,
  Users,
} from 'lucide-react';
import { PERMISSIONS, type AuditLogEntry } from '@hrms/shared';
import { api } from '@/lib/api';
import { formatRelative, humanise } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Can, useAuthenticatedSession, usePermissions } from '@/features/auth/session-context';

interface CompanyStats {
  employees: number;
  activeEmployees: number;
  onLeave: number;
  departments: number;
  teams: number;
  activeUsers: number;
  newThisMonth: number;
}

export function DashboardPage() {
  const session = useAuthenticatedSession();
  const { has } = usePermissions();
  const firstName = session.user.firstName;

  const statsQuery = useQuery({
    queryKey: ['company', 'stats'],
    queryFn: () => api.get<CompanyStats>('/company/stats'),
    enabled: has(PERMISSIONS.COMPANY_READ),
  });

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        description={`Here is what is happening at ${session.company.name} today.`}
      />

      <Can permission={PERMISSIONS.COMPANY_READ}>
        {statsQuery.isError ? (
          <Card>
            <ErrorState error={statsQuery.error} onRetry={() => void statsQuery.refetch()} />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Total employees"
              value={statsQuery.data?.employees}
              icon={Users}
              tone="primary"
              hint={
                statsQuery.data
                  ? `${statsQuery.data.activeEmployees} active`
                  : undefined
              }
              loading={statsQuery.isLoading}
            />
            <StatCard
              label="Departments"
              value={statsQuery.data?.departments}
              icon={Building2}
              hint={statsQuery.data ? `${statsQuery.data.teams} teams` : undefined}
              loading={statsQuery.isLoading}
            />
            <StatCard
              label="On leave"
              value={statsQuery.data?.onLeave}
              icon={CalendarClock}
              tone="warning"
              hint="Tracked from phase 4"
              loading={statsQuery.isLoading}
            />
            <StatCard
              label="Active accounts"
              value={statsQuery.data?.activeUsers}
              icon={KeyRound}
              tone="success"
              hint={
                statsQuery.data ? `${statsQuery.data.newThisMonth} hired this month` : undefined
              }
              loading={statsQuery.isLoading}
            />
          </div>
        )}
      </Can>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <RecentActivity />
        <SetupChecklist />
      </div>
    </>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

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
        <div>
          <CardTitle>Recent activity</CardTitle>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings/audit">View all</Link>
        </Button>
      </CardHeader>

      {query.isLoading ? (
        <CardContent className="space-y-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </CardContent>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data && query.data.data.length > 0 ? (
        <ul className="divide-y divide-border">
          {query.data.data.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-5 py-3">
              <span
                className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"
                aria-hidden
              >
                <ScrollText className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px]">
                  {entry.summary ?? humanise(entry.action)}
                </p>
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

/** Orients a fresh install rather than showing an empty column. */
function SetupChecklist() {
  const { has } = usePermissions();

  const links = [
    {
      label: 'Company profile',
      description: 'Name, address and localisation defaults.',
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
      label: 'Audit log',
      description: 'Review every change made in the system.',
      to: '/settings/audit',
      icon: ScrollText,
      visible: has(PERMISSIONS.AUDIT_READ),
    },
  ].filter((link) => link.visible);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader bordered>
          <CardTitle>Get set up</CardTitle>
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

      <Card className="border-dashed bg-surface-muted/40 shadow-none">
        <CardContent className="space-y-2.5">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" aria-hidden />
            <p className="text-[13px] font-medium">Coming next</p>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Employee management, attendance, leave and payroll build on the foundation you are
            looking at now.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {['People', 'Attendance', 'Leave', 'Payroll'].map((label) => (
              <Badge key={label} variant="neutral">
                <UserPlus className="size-3" aria-hidden />
                {label}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
