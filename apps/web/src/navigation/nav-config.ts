import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  BarChart3,
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
  FileSpreadsheet,
  Fingerprint,
  HandCoins,
  HeartPulse,
  Headset,
  LayoutDashboard,
  LifeBuoy,
  ClipboardPen,
  PencilLine,
  Receipt,
  Sandwich,
  UtensilsCrossed,
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
        // Self-service, and separate from the correction CENTRE below on
        // purpose: this one answers "my Tuesday is wrong", that one answers
        // "somebody's Tuesday is wrong". Everything behind this entry is bound
        // to the caller's own employee record by the server.
        label: 'My corrections',
        to: '/attendance/my-corrections',
        icon: PencilLine,
        permission: PERMISSIONS.ATTENDANCE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The HR side of the same module, and named so it is tellable apart
        // from the self-service entry above. Readable by anyone who may read
        // attendance; the correction form inside needs attendance.manage, and
        // the endpoint is the real gate.
        label: 'Correction centre',
        to: '/attendance/corrections',
        icon: ClipboardPen,
        permission: PERMISSIONS.ATTENDANCE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Attendance reports',
        to: '/attendance/reports',
        icon: BarChart3,
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
        permission: PERMISSIONS.PAYROLL_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Separate from Payroll because almost everyone can reach it and almost
        // nobody can reach Payroll: a member of staff holds payslip.read with an
        // OWN scope and sees exactly their own.
        label: 'Payslips',
        to: '/payslips',
        icon: Receipt,
        permission: PERMISSIONS.PAYSLIP_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Alongside Payslips rather than inside Payroll, and for the same
        // reason: a member of staff holds loan.read with an OWN scope and
        // opens this to find their own loans, without going near Payroll.
        label: 'Loans',
        to: '/loans',
        icon: HandCoins,
        permission: PERMISSIONS.LOAN_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Alongside Payslips and Loans, and for the same reason: every member
        // of staff holds medical.read and opens this to find their OWN benefit.
        // The endpoint refuses to show anybody else's without medical.manage,
        // so a manager finds their own here too and nothing of their team's.
        label: 'Medical',
        to: '/medical',
        icon: HeartPulse,
        permission: PERMISSIONS.MEDICAL_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The helpdesk, alongside Payslips, Loans and Medical, and for the same
        // reason: every member of staff holds case.read.own and opens this to
        // find their OWN cases. The endpoint behind it shows nobody else's,
        // whatever data scope the caller has, so a manager finds their own here
        // too and nothing of their team's.
        label: 'Cases',
        to: '/cases',
        icon: Headset,
        permission: PERMISSIONS.CASE_READ_OWN,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The other side of the same module, and a separate entry rather than a
        // switch inside "Cases": one screen is somebody's own list and the
        // other is a work queue, and only the people who staff a desk hold
        // either grant that opens it.
        label: 'Case queue',
        to: '/case-queue',
        icon: Headset,
        permission: [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL],
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Alongside Payslips, Loans and Medical, and for the same reason: every
        // member of staff holds the lunch grants and opens this to find their
        // OWN order. The endpoint behind it shows nobody else's.
        //
        // Deliberately not under Payroll. Lunch is cash handed to the office
        // boy at one o'clock; filing it beside salary would be the first step
        // towards somebody expecting it to be deducted from one.
        label: 'Lunch',
        to: '/lunch',
        icon: Sandwich,
        permission: PERMISSIONS.LUNCH_ORDER_READ_OWN,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The other side of the same module, and a separate entry rather than a
        // switch inside "Lunch": one screen is somebody's own order and the
        // other is a day's cash collection, and only the people who run the
        // lunch round hold the grant that opens it.
        label: 'Lunch collection',
        to: '/lunch-collection',
        icon: UtensilsCrossed,
        permission: PERMISSIONS.LUNCH_COLLECTION_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The consolidated HR view: one row per employee, every module's figure
        // for that person. Gated on employee.read; the columns a reader may
        // fill are decided per block by the module that owns them.
        label: 'Employee Master Report',
        to: '/reports/employee-master',
        icon: FileSpreadsheet,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'ready',
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
      {
        // No permission: every signed-in user can open the help centre. What
        // they find inside is narrowed per document by the server.
        label: 'Help & Documentation',
        to: '/help',
        icon: LifeBuoy,
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
  '/attendance/corrections': 'Attendance correction centre',
  '/attendance/my-corrections': 'My attendance corrections',
  '/attendance/reports': 'Attendance reports',
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
  '/settings/attendance-rules': 'Attendance rules',
  '/settings/device-mapping': 'Device user mapping',
  '/payroll/preview': 'Payroll preview',
  '/payroll/salaries': 'Salary management',
  '/loans': 'Loans',
  '/medical': 'Medical',
  '/medical/claims': 'Medical claims',
  '/cases': 'My cases',
  '/case-queue': 'Case queue',
  '/settings/case-categories': 'Case categories',
  '/lunch': 'Lunch',
  '/lunch-collection': 'Lunch collection',
  '/settings/lunch-menu': 'Lunch menu',
  '/reports/employee-master': 'Employee Master Report',
  '/settings/attendance-policies': 'Policy overrides',
  '/settings/loan-policy': 'Loan policy',
  '/settings/medical-policy': 'Medical policy',
  '/settings/roles': 'Roles and permissions',
  '/settings/audit': 'Audit log',
};
