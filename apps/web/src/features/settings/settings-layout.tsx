import { NavLink, Outlet } from 'react-router-dom';
import { Building2, Clock, KeyRound, ScrollText } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { PageHeader } from '@/components/layout/page-header';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

const TABS: Array<{ to: string; label: string; icon: typeof Building2; permission: Permission }> = [
  { to: '/settings/company', label: 'Company', icon: Building2, permission: PERMISSIONS.COMPANY_READ },
  { to: '/settings/attendance', label: 'Attendance policy', icon: Clock, permission: PERMISSIONS.COMPANY_READ },
  { to: '/settings/roles', label: 'Roles and permissions', icon: KeyRound, permission: PERMISSIONS.ROLE_READ },
  { to: '/settings/audit', label: 'Audit log', icon: ScrollText, permission: PERMISSIONS.AUDIT_READ },
];

export function SettingsLayout() {
  const { has } = usePermissions();
  const tabs = TABS.filter((tab) => has(tab.permission));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Company profile, access control and the system audit trail."
      />

      <div className="mb-6 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Settings sections">
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
