import { NavLink, Outlet } from 'react-router-dom';
import { Building2, GitBranch, IdCard, MapPin, Users2 } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { PageHeader } from '@/components/layout/page-header';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

const TABS: Array<{ to: string; label: string; icon: typeof Building2; permission: Permission }> = [
  { to: '/organisation/departments', label: 'Departments', icon: Building2, permission: PERMISSIONS.DEPARTMENT_READ },
  { to: '/organisation/teams', label: 'Teams', icon: Users2, permission: PERMISSIONS.TEAM_READ },
  { to: '/organisation/designations', label: 'Designations', icon: IdCard, permission: PERMISSIONS.DESIGNATION_READ },
  { to: '/organisation/locations', label: 'Locations', icon: MapPin, permission: PERMISSIONS.LOCATION_READ },
  { to: '/organisation/structure', label: 'Structure', icon: GitBranch, permission: PERMISSIONS.DEPARTMENT_READ },
];

export function OrganisationLayout() {
  const { has } = usePermissions();
  const tabs = TABS.filter((tab) => has(tab.permission));

  return (
    <>
      <PageHeader
        title="Organisation"
        description="Departments, teams, job titles and work locations."
      />

      <div className="mb-6 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Organisation sections">
          {tabs.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </>
  );
}
