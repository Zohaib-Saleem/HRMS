import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Building2,
  ClipboardCheck,
  FileClock,
  Timer,
  Plane,
  CalendarHeart,
  Layers3,
  CalendarDays,
  Clock,
  Cpu,
  FileText,
  Fingerprint,
  LayoutDashboard,
  Settings,
  TrendingUp,
  Users,
  UsersRound,
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
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Organisation',
        to: '/organisation',
        icon: Building2,
        permission: [
          PERMISSIONS.DEPARTMENT_READ,
          PERMISSIONS.TEAM_READ,
          PERMISSIONS.DESIGNATION_READ,
          PERMISSIONS.LOCATION_READ,
        ],
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
  {
    key: 'time',
    label: 'Time',
    items: [
      {
        label: 'Approvals',
        to: '/approvals',
        icon: ClipboardCheck,
        permission: PERMISSIONS.APPROVAL_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Attendance',
        to: '/attendance',
        icon: Clock,
        permission: PERMISSIONS.ATTENDANCE_READ,
        status: 'ready',
        // Exact match: /attendance/team is its own entry below.
        matchPrefix: false,
      },
      {
        label: 'Team attendance',
        to: '/attendance/team',
        icon: UsersRound,
        permission: PERMISSIONS.ATTENDANCE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Devices',
        to: '/attendance/devices',
        icon: Cpu,
        permission: PERMISSIONS.DEVICE_READ,
        status: 'ready',
        matchPrefix: false,
      },
      {
        label: 'Device punches',
        to: '/attendance/punches',
        icon: Fingerprint,
        permission: PERMISSIONS.DEVICE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Shifts',
        to: '/shifts',
        icon: Timer,
        permission: PERMISSIONS.SHIFT_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Timesheets',
        to: '/timesheets',
        icon: FileClock,
        permission: PERMISSIONS.TIMESHEET_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'My leave',
        to: '/leave/me',
        icon: CalendarDays,
        permission: PERMISSIONS.LEAVE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Leave requests',
        to: '/leave/requests',
        icon: Plane,
        permission: PERMISSIONS.LEAVE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Leave types',
        to: '/leave/types',
        icon: Layers3,
        permission: PERMISSIONS.LEAVE_MANAGE,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Holidays',
        to: '/holidays',
        icon: CalendarHeart,
        permission: PERMISSIONS.HOLIDAY_READ,
        status: 'ready',
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
  '/approvals': 'Approvals',
  '/attendance': 'Attendance',
  '/attendance/team': 'Team attendance',
  '/attendance/devices': 'Devices',
  '/attendance/punches': 'Device punches',
  '/shifts': 'Shifts',
  '/timesheets': 'Timesheets',
  '/leave/me': 'My leave',
  '/leave/requests': 'Leave requests',
  '/leave/types': 'Leave types',
  '/holidays': 'Holidays',
  '/people': 'People',
  '/people/org-chart': 'Org chart',
  '/organisation': 'Organisation',
  '/organisation/departments': 'Departments',
  '/organisation/teams': 'Teams',
  '/organisation/designations': 'Designations',
  '/organisation/locations': 'Locations',
  '/organisation/structure': 'Structure',
  '/profile': 'My profile',
  '/settings': 'Settings',
  '/settings/company': 'Company',
  '/settings/attendance': 'Attendance policy',
  '/settings/attendance-policies': 'Policy overrides',
  '/settings/roles': 'Roles and permissions',
  '/settings/audit': 'Audit log',
};
