import { NavLink, Outlet } from 'react-router-dom';
import { BarChart3, LayoutDashboard, Layers3, Receipt, Settings2, Wallet } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

/**
 * The payroll section, with its own tabs.
 *
 * Matches the settings and organisation layouts rather than inventing a shape:
 * payroll is another part of this HRMS, not a separate application bolted onto
 * the side of it.
 */

const TABS: Array<{
  to: string;
  label: string;
  icon: typeof Wallet;
  permission: Permission;
  end?: boolean;
}> = [
  {
    to: '/payroll',
    label: 'Overview',
    icon: LayoutDashboard,
    permission: PERMISSIONS.PAYROLL_READ,
    end: true,
  },
  { to: '/payroll/runs', label: 'Pay runs', icon: Receipt, permission: PERMISSIONS.PAYROLL_READ },
  {
    to: '/payroll/profiles',
    label: 'Profiles and salaries',
    icon: Wallet,
    permission: PERMISSIONS.PAYROLL_READ,
  },
  {
    to: '/payroll/components',
    label: 'Salary components',
    icon: Layers3,
    permission: PERMISSIONS.PAYROLL_READ,
  },
  {
    to: '/payroll/reports',
    label: 'Reports',
    icon: BarChart3,
    permission: PERMISSIONS.PAYROLL_READ,
  },
  {
    to: '/payroll/settings',
    label: 'Settings',
    icon: Settings2,
    permission: PERMISSIONS.PAYROLL_MANAGE,
  },
];

export function PayrollLayout() {
  const { has } = usePermissions();
  const tabs = TABS.filter((tab) => has(tab.permission));

  return (
    <>
      <div className="mb-6 overflow-x-auto border-b border-border">
        <nav className="flex min-w-max gap-1" aria-label="Payroll sections">
          {tabs.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
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
