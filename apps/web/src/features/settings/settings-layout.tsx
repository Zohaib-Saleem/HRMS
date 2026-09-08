import { NavLink, Outlet } from 'react-router-dom';
import {
  Building2,
  Clock,
  KeyRound,
  Layers3,
  ScrollText,
  SlidersHorizontal,
  UsersRound,
} from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';
import { PageHeader } from '@/components/layout/page-header';
import { usePermissions } from '@/features/auth/session-context';
import type { CapabilityState } from '@/lib/capability';
import { cn } from '@/lib/utils';
import { useAttendanceRules } from './use-attendance-rules';

export interface SettingsTab {
  to: string;
  label: string;
  icon: typeof Building2;
  permission: Permission;
  /**
   * Set when the tab also depends on an endpoint that may not be deployed yet.
   * Permission alone is not enough to know a screen will work.
   */
  capability?: 'attendanceRules';
}

export const TABS: SettingsTab[] = [
  { to: '/settings/company', label: 'Company', icon: Building2, permission: PERMISSIONS.COMPANY_READ },
  { to: '/settings/attendance', label: 'Attendance policy', icon: Clock, permission: PERMISSIONS.COMPANY_READ },
  {
    to: '/settings/attendance-rules',
    label: 'Attendance rules',
    icon: SlidersHorizontal,
    permission: PERMISSIONS.COMPANY_READ,
    // Ships ahead of its endpoint; hidden until the API answers.
    capability: 'attendanceRules',
  },
  { to: '/settings/attendance-policies', label: 'Policy overrides', icon: Layers3, permission: PERMISSIONS.COMPANY_READ },
  { to: '/settings/users', label: 'Users', icon: UsersRound, permission: PERMISSIONS.USER_READ },
  { to: '/settings/roles', label: 'Roles and permissions', icon: KeyRound, permission: PERMISSIONS.ROLE_READ },
  { to: '/settings/audit', label: 'Audit log', icon: ScrollText, permission: PERMISSIONS.AUDIT_READ },
];

/**
 * Which tabs to show.
 *
 * Two independent gates. Permission decides what this user may reach at all;
 * capability decides whether the screen behind it currently works. A tab needs
 * both, and while a capability is still being checked the tab stays hidden -
 * appearing and then vanishing reads as a glitch.
 *
 * Pure, so the rules can be asserted without rendering anything.
 */
export function visibleTabs(
  tabs: readonly SettingsTab[],
  input: {
    has: (permission: Permission) => boolean;
    capabilities: Record<'attendanceRules', CapabilityState>;
  },
): SettingsTab[] {
  return tabs.filter((tab) => {
    if (!input.has(tab.permission)) return false;
    if (!tab.capability) return true;
    return input.capabilities[tab.capability] === 'available';
  });
}

export function SettingsLayout() {
  const { has } = usePermissions();
  const attendanceRules = useAttendanceRules();
  const tabs = visibleTabs(TABS, {
    has,
    capabilities: { attendanceRules: attendanceRules.state },
  });

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
