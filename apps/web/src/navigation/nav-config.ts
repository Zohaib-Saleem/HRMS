import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  CalendarDays,
  Clock,
  FileText,
  LayoutDashboard,
  Settings,
  TrendingUp,
  Users,
} from 'lucide-react';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Navigation registry.
 *
 * The sidebar is generated from this list, so adding a module means adding one
 * entry - no JSX edits. Items the user lacks permission for are hidden, and
 * `status: 'planned'` renders a disabled row so the roadmap stays visible
 * without pretending the screen exists.
 */

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Required to see the item at all. Omit for always-visible entries. */
  permission?: Permission | Permission[];
  status?: 'ready' | 'planned';
  /** Matches nested routes, e.g. /settings/roles under /settings. */
  matchPrefix?: boolean;
  badge?: string;
}

export interface NavSection {
  key: string;
  label?: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard, status: 'ready' },
    ],
  },
  {
    key: 'workforce',
    label: 'Workforce',
    items: [
      {
        label: 'People',
        to: '/people',
        icon: Users,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        badge: 'Phase 2',
        matchPrefix: true,
      },
      {
        label: 'Attendance',
        to: '/attendance',
        icon: Clock,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        matchPrefix: true,
      },
      {
        label: 'Leave',
        to: '/leave',
        icon: CalendarDays,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        matchPrefix: true,
      },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    items: [
      {
        label: 'Payroll',
        to: '/payroll',
        icon: Banknote,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        matchPrefix: true,
      },
      {
        label: 'Performance',
        to: '/performance',
        icon: TrendingUp,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        matchPrefix: true,
      },
      {
        label: 'Documents',
        to: '/documents',
        icon: FileText,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'planned',
        matchPrefix: true,
      },
    ],
  },
  {
    key: 'administration',
    label: 'Administration',
    items: [
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        permission: [PERMISSIONS.COMPANY_READ, PERMISSIONS.ROLE_READ, PERMISSIONS.AUDIT_READ],
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
];

/** Breadcrumb labels for routes that are not in the sidebar. */
export const ROUTE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/profile': 'My profile',
  '/settings': 'Settings',
  '/settings/company': 'Company',
  '/settings/roles': 'Roles and permissions',
  '/settings/audit': 'Audit log',
};
