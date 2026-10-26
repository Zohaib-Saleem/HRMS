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
  Boxes,
  TriangleAlert,
  Briefcase,
  PackagePlus,
  CalendarSearch,
  ContactRound,
  Sandwich,
  UtensilsCrossed,
  Settings,
  TrendingUp,
  Users,
  UsersRound,
  ShieldCheck,
  UserCog,
  ScrollText,
  SlidersHorizontal,
  Workflow,
  Tags,
  Stethoscope,
  Wallet,
  Link2,
  ChefHat,
  Package,
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
  /*
   * The order below is the employee's, not the org chart's.
   *
   * This list used to be grouped by MODULE - Workforce, Time, Operations - which
   * is how the product is built and not how anybody uses it. An ordinary member
   * of staff holds attendance.read, leave.read, timesheet.read and the rest, so
   * that arrangement handed them eighteen entries with their own attendance
   * sitting below Approvals and their own leave below Device punches. The
   * grouping is now by WHOSE it is: my work, my services, the company's, and -
   * last, because the people who need them are the few who have a reason to
   * scroll - the screens that are somebody's job rather than everybody's day.
   *
   * Nothing here changes who may see what. Every `permission` is the one the
   * entry already carried, with one deliberate exception noted on Correction
   * centre, and the server remains the only gate that matters: hiding a row
   * removes a signpost, never a right.
   */
  {
    key: 'workspace',
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, status: 'ready' }],
  },
  {
    /*
     * The five things an employee opens most, in the order they open them.
     * Attendance first because it is the reason most people log in at all.
     */
    key: 'my-work',
    label: 'My work',
    items: [
      {
        label: 'Attendance',
        to: '/attendance',
        icon: Clock,
        permission: PERMISSIONS.ATTENDANCE_READ,
        status: 'ready',
        // Exact match: /attendance/team and the rest are their own entries.
        matchPrefix: false,
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
        label: 'Timesheets',
        to: '/timesheets',
        icon: FileClock,
        permission: PERMISSIONS.TIMESHEET_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        /*
         * Asking the company for kit, and following what happened to the ask.
         *
         * In "My work" rather than under Operations because every member of
         * staff holds `asset.request.read` for their own requests, and the
         * screen's first tab is theirs. The asset manager's fulfilment queue
         * is the same screen with an extra tab, which appears for whoever
         * holds `asset.request.read.all` - one row rather than two, because it
         * is one list of requests seen from two ends.
         */
        label: 'Equipment requests',
        to: '/assets/requests',
        icon: PackagePlus,
        permission: PERMISSIONS.ASSET_REQUEST_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Everybody holds approval.read - an employee's own requests travel
        // through this queue - so it belongs with their work rather than with
        // the administrative screens, where it would be invisible to most of
        // the people who can open it.
        label: 'Approvals',
        to: '/approvals',
        icon: ClipboardCheck,
        permission: PERMISSIONS.APPROVAL_READ,
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Things the company provides and an employee consumes. Each of these
     * endpoints is pinned to the caller's own record on the server, whatever
     * data scope the reader has - a manager finds their own lunch and their own
     * loans here, and nothing of their team's.
     */
    key: 'my-services',
    label: 'My services',
    items: [
      {
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
        // "My cases", not "Cases". The old label read as the helpdesk itself,
        // which is the queue next door; this screen is the employee's own list
        // and says so before they click it.
        label: 'My cases',
        to: '/cases',
        icon: Headset,
        permission: PERMISSIONS.CASE_READ_OWN,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Loans',
        to: '/loans',
        icon: HandCoins,
        permission: PERMISSIONS.LOAN_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Medical',
        to: '/medical',
        icon: HeartPulse,
        permission: PERMISSIONS.MEDICAL_READ,
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
  {
    key: 'documents',
    label: 'Documents',
    items: [
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
    key: 'company',
    label: 'Company',
    items: [
      {
        label: 'Holidays',
        to: '/holidays',
        icon: CalendarHeart,
        permission: PERMISSIONS.HOLIDAY_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // Reference data rather than a team screen: shift.read is held by
        // everybody, and what is behind it is the company's shift definitions.
        label: 'Shifts',
        to: '/shifts',
        icon: Timer,
        permission: PERMISSIONS.SHIFT_READ,
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
    /*
     * Other people's attendance.
     *
     * Both rows move from attendance.read to employee.READ, and the reasoning
     * is the same for each: these screens are about a group of colleagues, and
     * every member of staff holds attendance.read for their own record - so
     * that grant could never tell an employee from a manager, and the rows sat
     * in front of all eighty people. Managers and HR hold employee.read;
     * employees do not. An employee opening /attendance/team was shown a team
     * of one - themselves - which is the attendance page they already have.
     *
     * The endpoints are untouched and remain the real gate, narrowed by each
     * reader's own data scope exactly as before.
     */
    key: 'team',
    label: 'Team & reports',
    items: [
      {
        label: 'Team attendance',
        to: '/attendance/team',
        icon: UsersRound,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Attendance reports',
        to: '/attendance/reports',
        icon: BarChart3,
        permission: PERMISSIONS.EMPLOYEE_READ,
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Somebody's job rather than everybody's day. An ordinary employee holds
     * none of these grants and the whole section is absent for them.
     */
    key: 'management',
    label: 'Management',
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
        label: 'Payroll',
        to: '/payroll',
        icon: Banknote,
        permission: PERMISSIONS.PAYROLL_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The other side of the helpdesk, and a separate entry rather than a
        // switch inside "My cases": one screen is somebody's own list and the
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
        // The office boy's own screen. An employee never sees this: it needs
        // lunch.collection.read, which the Office Boy role carries and the
        // Employee role does not.
        label: 'Lunch collection',
        to: '/lunch-collection',
        icon: UtensilsCrossed,
        permission: PERMISSIONS.LUNCH_COLLECTION_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        // The HR side of attendance corrections. Re-gated from attendance.read
        // to attendance.MANAGE, which is the grant the correction form inside
        // has always required - so this row was being shown to every member of
        // staff, above their own attendance, for a screen none of them could
        // act on. The endpoint is unchanged and remains the real gate.
        label: 'Correction centre',
        to: '/attendance/corrections',
        icon: ClipboardPen,
        permission: PERMISSIONS.ATTENDANCE_MANAGE,
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
        // The consolidated HR view: one row per employee, every module's figure
        // for that person. Gated on its own grant, which the server requires
        // beside employee.read; the columns a reader may fill are decided per
        // block by the module that owns them.
        label: 'Employee Master Report',
        to: '/reports/employee-master',
        icon: FileSpreadsheet,
        permission: PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ,
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
    ],
  },
  {
    /*
     * Operations: the company's own things rather than its people.
     *
     * One row today and the section exists for the ones behind it - the
     * assignments, repairs and reports that arrive in the steps after this one
     * and that all belong beside the register rather than under Management,
     * where they would sit between Leave types and Devices.
     *
     * Gated on `asset.read.ALL`, which is deliberately not the grant the screen
     * behind it requires. The register is the operations view - the whole
     * company's equipment, and four tiles that count it - and that is what this
     * signpost points at. An ordinary employee holds `asset.read` and would be
     * shown a page with their own laptop on it and a "Total assets: 1" tile,
     * which is a worse answer to "what have I been issued" than the screen that
     * arrives with the assignments. Their own view is that screen, not this one.
     *
     * Hiding a row removes a signpost, never a right: the route and every
     * endpoint behind it re-check `asset.read` and narrow the rows server-side,
     * so an employee who reaches /assets directly is still served their own.
     */
    key: 'operations',
    label: 'Operations',
    items: [
      {
        /*
         * The dashboard first, because it is where somebody lands when the
         * question is "is anything wrong" rather than "where is that laptop".
         *
         * `asset.read.ALL`, and the endpoint behind it needs the same. It is
         * the one asset screen with no narrow version: "total assets: 1, no
         * warranties expiring" is not a smaller dashboard, it is a misleading
         * one, and an employee's own view of their kit is the card on their
         * home page.
         */
        label: 'Asset dashboard',
        to: '/assets/dashboard',
        icon: LayoutDashboard,
        permission: PERMISSIONS.ASSET_READ_ALL,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Assets',
        to: '/assets',
        icon: Boxes,
        permission: PERMISSIONS.ASSET_READ_ALL,
        status: 'ready',
        /*
         * EXACT, for the reason Recruitment's own row is: the two rows around
         * this one are nested under `/assets` and a prefix match would light
         * this one up as well. The cost is that the asset DETAIL page lights no
         * row, which is the better of the two wrongs - a sidebar with two rows
         * highlighted at once tells the reader nothing about where they are.
         */
        matchPrefix: false,
      },
      {
        /*
         * What employees have reported about the kit they hold. The same
         * grant as the register: an issue is a fact about an asset.
         */
        label: 'Asset issues',
        to: '/assets/issues',
        icon: TriangleAlert,
        permission: PERMISSIONS.ASSET_READ_ALL,
        status: 'ready',
        matchPrefix: true,
      },
      {
        /*
         * Its own grant, and deliberately not `asset.read.all`. Reading the
         * register on screen and taking it away as a file are different
         * decisions - a company may well want the second to be rarer - so the
         * row appears for whoever holds `asset.report`, and the endpoints
         * behind it check that AND narrow the rows by the caller's data scope.
         * A reporting grant is permission to export what you can see.
         */
        label: 'Asset reports',
        to: '/assets/reports',
        icon: FileSpreadsheet,
        permission: PERMISSIONS.ASSET_REPORT,
        status: 'ready',
        matchPrefix: true,
      },
    ],
  },
  {
    /*
     * Recruitment, as its own section rather than four more rows under
     * Management.
     *
     * It is a module somebody works IN for an afternoon - the dashboard, then
     * the openings, then a candidate, then the calendar - and the four screens
     * are read as a set. Filed under Management they would have sat between
     * Leave types and Devices, which is how a hiring process ends up being run
     * out of a spreadsheet instead.
     *
     * Each row carries the grant its own ENDPOINT needs, which is why they are
     * four different permissions rather than one module-wide one:
     *
     *   - the dashboard and the openings need `recruitment.read`, and a holder
     *     without `recruitment.manage` is served only the openings they are
     *     named on. So a hiring manager sees these two rows and finds their
     *     own vacancies behind them;
     *   - Candidates needs `candidate.read`, which a manager does NOT hold.
     *     That absence is the design: somebody interviewing a person is shown
     *     that person through the interview, and has no business browsing what
     *     everybody who ever applied is earning;
     *   - Interviews needs `interview.read`, which the Interviewer role holds
     *     on its own. It is the only row that role sees, and behind it the
     *     server returns the seats they are on - so the whole section for them
     *     is one entry leading to their own calendar.
     *
     * Hiding a row removes a signpost, never a right: every endpoint re-checks
     * the same grant, and the narrow reads are WHERE clauses on the server.
     */
    key: 'recruitment',
    label: 'Recruitment',
    items: [
      {
        label: 'Recruitment',
        to: '/recruitment',
        icon: TrendingUp,
        permission: PERMISSIONS.RECRUITMENT_READ,
        status: 'ready',
        // Exact: the three rows below are all nested under /recruitment and
        // would light this one up as well.
        matchPrefix: false,
      },
      {
        label: 'Job openings',
        to: '/recruitment/job-openings',
        icon: Briefcase,
        permission: PERMISSIONS.RECRUITMENT_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Candidates',
        to: '/recruitment/candidates',
        icon: ContactRound,
        permission: PERMISSIONS.CANDIDATE_READ,
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Interviews',
        to: '/recruitment/interviews',
        icon: CalendarSearch,
        permission: PERMISSIONS.INTERVIEW_READ,
        status: 'ready',
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

// ------------------------------------------------- company administration

/**
 * Which sidebar a signed-in user is drawn.
 *
 * `employee` is NAV_SECTIONS above - grouped by whose screen it is, personal
 * first - and it is what everybody gets, managers and HR included: they are
 * members of staff with a job on top, and their own leave sits beside the
 * screens of their job.
 *
 * `administration` is for the account that runs the company. It is decided by
 * GRANTS, never by a role name: whoever holds every one of
 * ADMINISTRATION_NAV_GRANTS - the right to decide who has an account and what
 * each role may do - is the company's administrator, whatever their role is
 * called. In the seeded roles that is Super Admin alone. A company that hands
 * both grants to another role has, by doing so, made its holders administrators
 * too, and they get the same sidebar.
 *
 * The layout is a presentation choice and nothing else. Every row is still
 * filtered by the grant its own screen needs, hiding a personal shortcut
 * removes a signpost rather than a right, and the server remains the only gate
 * that matters.
 */
export type NavMode = 'employee' | 'administration';

export const ADMINISTRATION_NAV_GRANTS: readonly Permission[] = [
  PERMISSIONS.ROLE_MANAGE,
  PERMISSIONS.USER_MANAGE,
];

export function navModeFor(permissions: ReadonlySet<Permission>): NavMode {
  return ADMINISTRATION_NAV_GRANTS.every((p) => permissions.has(p))
    ? 'administration'
    : 'employee';
}

/**
 * The administrator's sidebar: running the company, then configuring it, then
 * the system itself.
 *
 * Personal shortcuts are not here - see SELF_SERVICE_ITEMS. Where a screen is
 * both somebody's own list and the company's queue (loans, medical), the row
 * is gated on the MANAGING grant, because that is the screen this row is a
 * signpost to; an administrator without it finds their own record through the
 * self-service menu instead, where the same route is offered under its
 * personal name.
 */
export const ADMIN_NAV_SECTIONS: NavSection[] = [
  {
    key: 'workspace',
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, status: 'ready' }],
  },
  {
    key: 'company-management',
    label: 'Company management',
    items: [
      { label: 'People', to: '/people', icon: Users, permission: PERMISSIONS.EMPLOYEE_READ, status: 'ready', matchPrefix: true },
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
      { label: 'Attendance', to: '/attendance', icon: Clock, permission: PERMISSIONS.ATTENDANCE_READ, status: 'ready', matchPrefix: false },
      { label: 'Team attendance', to: '/attendance/team', icon: UsersRound, permission: PERMISSIONS.EMPLOYEE_READ, status: 'ready', matchPrefix: true },
      { label: 'Attendance reports', to: '/attendance/reports', icon: BarChart3, permission: PERMISSIONS.EMPLOYEE_READ, status: 'ready', matchPrefix: true },
      { label: 'Timesheets', to: '/timesheets', icon: FileClock, permission: PERMISSIONS.TIMESHEET_READ, status: 'ready', matchPrefix: true },
      { label: 'Approvals', to: '/approvals', icon: ClipboardCheck, permission: PERMISSIONS.APPROVAL_READ, status: 'ready', matchPrefix: true },
      { label: 'Correction centre', to: '/attendance/corrections', icon: ClipboardPen, permission: PERMISSIONS.ATTENDANCE_MANAGE, status: 'ready', matchPrefix: true },
      // The company's leave requests, narrowed by the reader's scope on the
      // server. The administrator's own balance is /leave/me, in self-service.
      { label: 'Leave management', to: '/leave/requests', icon: Plane, permission: PERMISSIONS.LEAVE_READ, status: 'ready', matchPrefix: true },
      { label: 'Leave types', to: '/leave/types', icon: Layers3, permission: PERMISSIONS.LEAVE_MANAGE, status: 'ready', matchPrefix: true },
      { label: 'Payroll', to: '/payroll', icon: Banknote, permission: PERMISSIONS.PAYROLL_READ, status: 'ready', matchPrefix: true },
      { label: 'Payslips', to: '/payslips', icon: Receipt, permission: PERMISSIONS.PAYSLIP_READ, status: 'ready', matchPrefix: true },
      {
        label: 'Loans & salary advances',
        to: '/loans',
        icon: HandCoins,
        permission: [PERMISSIONS.LOAN_MANAGE, PERMISSIONS.LOAN_APPROVE],
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Medical management',
        to: '/medical',
        icon: HeartPulse,
        permission: [PERMISSIONS.MEDICAL_MANAGE, PERMISSIONS.MEDICAL_CLAIM_APPROVE],
        status: 'ready',
        matchPrefix: true,
      },
      {
        label: 'Case queue',
        to: '/case-queue',
        icon: Headset,
        permission: [PERMISSIONS.CASE_READ_DEPARTMENT, PERMISSIONS.CASE_READ_ALL],
        status: 'ready',
        matchPrefix: true,
      },
      { label: 'Asset dashboard', to: '/assets/dashboard', icon: LayoutDashboard, permission: PERMISSIONS.ASSET_READ_ALL, status: 'ready', matchPrefix: true },
      { label: 'Assets', to: '/assets', icon: Boxes, permission: PERMISSIONS.ASSET_READ_ALL, status: 'ready', matchPrefix: false },
      { label: 'Asset issues', to: '/assets/issues', icon: TriangleAlert, permission: PERMISSIONS.ASSET_READ_ALL, status: 'ready', matchPrefix: true },
      { label: 'Asset reports', to: '/assets/reports', icon: FileSpreadsheet, permission: PERMISSIONS.ASSET_REPORT, status: 'ready', matchPrefix: true },
      // The fulfilment queue - the company's requests, not the reader's own.
      { label: 'Equipment requests', to: '/assets/requests', icon: PackagePlus, permission: PERMISSIONS.ASSET_REQUEST_READ_ALL, status: 'ready', matchPrefix: true },
      { label: 'Lunch collection', to: '/lunch-collection', icon: UtensilsCrossed, permission: PERMISSIONS.LUNCH_COLLECTION_READ, status: 'ready', matchPrefix: true },
      { label: 'Recruitment', to: '/recruitment', icon: TrendingUp, permission: PERMISSIONS.RECRUITMENT_READ, status: 'ready', matchPrefix: false },
      { label: 'Job openings', to: '/recruitment/job-openings', icon: Briefcase, permission: PERMISSIONS.RECRUITMENT_READ, status: 'ready', matchPrefix: true },
      { label: 'Candidates', to: '/recruitment/candidates', icon: ContactRound, permission: PERMISSIONS.CANDIDATE_READ, status: 'ready', matchPrefix: true },
      { label: 'Interviews', to: '/recruitment/interviews', icon: CalendarSearch, permission: PERMISSIONS.INTERVIEW_READ, status: 'ready', matchPrefix: true },
      { label: 'Employee Master Report', to: '/reports/employee-master', icon: FileSpreadsheet, permission: PERMISSIONS.EMPLOYEE_MASTER_REPORT_READ, status: 'ready', matchPrefix: true },
      { label: 'Performance', to: '/performance', icon: TrendingUp, permission: PERMISSIONS.EMPLOYEE_READ, status: 'planned', matchPrefix: true },
    ],
  },
  {
    /*
     * Reference data and rules the company is configured with. The rows that
     * live under /settings are shortcuts into the same Settings screens - the
     * route gates there are unchanged, and each row carries the grant its own
     * route requires.
     */
    key: 'company-configuration',
    label: 'Company configuration',
    items: [
      { label: 'Shifts', to: '/shifts', icon: Timer, permission: PERMISSIONS.SHIFT_READ, status: 'ready', matchPrefix: true },
      { label: 'Holidays', to: '/holidays', icon: CalendarHeart, permission: PERMISSIONS.HOLIDAY_READ, status: 'ready', matchPrefix: true },
      { label: 'Devices', to: '/attendance/devices', icon: Cpu, permission: PERMISSIONS.DEVICE_READ, status: 'ready', matchPrefix: false },
      { label: 'Device punches', to: '/attendance/punches', icon: Fingerprint, permission: PERMISSIONS.DEVICE_READ, status: 'ready', matchPrefix: true },
      { label: 'Device user mapping', to: '/settings/device-mapping', icon: Link2, permission: PERMISSIONS.DEVICE_READ, status: 'ready', matchPrefix: true },
      { label: 'Attendance policy', to: '/settings/attendance', icon: SlidersHorizontal, permission: PERMISSIONS.COMPANY_READ, status: 'ready', matchPrefix: true },
      { label: 'Approval hierarchy', to: '/settings/approval-hierarchy', icon: Workflow, permission: PERMISSIONS.APPROVAL_WORKFLOW_READ, status: 'ready', matchPrefix: true },
      { label: 'Case categories', to: '/settings/case-categories', icon: Tags, permission: PERMISSIONS.CASE_CATEGORY_MANAGE, status: 'ready', matchPrefix: true },
      { label: 'Loan policy', to: '/settings/loan-policy', icon: Wallet, permission: PERMISSIONS.LOAN_POLICY_READ, status: 'ready', matchPrefix: true },
      { label: 'Medical policy', to: '/settings/medical-policy', icon: Stethoscope, permission: PERMISSIONS.MEDICAL_POLICY_READ, status: 'ready', matchPrefix: true },
      { label: 'Asset categories', to: '/settings/asset-categories', icon: Package, permission: PERMISSIONS.ASSET_CATEGORY_MANAGE, status: 'ready', matchPrefix: true },
      { label: 'Lunch menu', to: '/settings/lunch-menu', icon: ChefHat, permission: PERMISSIONS.LUNCH_MENU_MANAGE, status: 'ready', matchPrefix: true },
    ],
  },
  {
    key: 'system-administration',
    label: 'System administration',
    items: [
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        permission: [PERMISSIONS.COMPANY_READ, PERMISSIONS.ROLE_READ, PERMISSIONS.AUDIT_READ],
        status: 'ready',
        matchPrefix: true,
      },
      { label: 'Users', to: '/settings/users', icon: UserCog, permission: PERMISSIONS.USER_READ, status: 'ready', matchPrefix: true },
      { label: 'Roles & permissions', to: '/settings/roles', icon: ShieldCheck, permission: PERMISSIONS.ROLE_READ, status: 'ready', matchPrefix: true },
      { label: 'Audit log', to: '/settings/audit', icon: ScrollText, permission: PERMISSIONS.AUDIT_READ, status: 'ready', matchPrefix: true },
      { label: 'Help & Documentation', to: '/help', icon: LifeBuoy, status: 'ready', matchPrefix: true },
    ],
  },
];

/**
 * The administrator's own employee services.
 *
 * Kept out of the administration sidebar and offered instead under "My
 * self-service" in the account menu - or, when the administrator turns it on,
 * as a section at the foot of the sidebar. Every row carries the same grant it
 * carries in the employee sidebar, and the endpoints behind each one are
 * pinned to the caller's own record exactly as before.
 *
 * A row whose route is already in the administrator's sidebar is dropped (see
 * selfServiceFor): where the managing row is shown, the same screen is already
 * one click away, and two rows for one route light up together.
 */
export const SELF_SERVICE_ITEMS: NavItem[] = [
  { label: 'My leave', to: '/leave/me', icon: CalendarDays, permission: PERMISSIONS.LEAVE_READ, status: 'ready', matchPrefix: true },
  { label: 'My corrections', to: '/attendance/my-corrections', icon: PencilLine, permission: PERMISSIONS.ATTENDANCE_READ, status: 'ready', matchPrefix: true },
  { label: 'My cases', to: '/cases', icon: Headset, permission: PERMISSIONS.CASE_READ_OWN, status: 'ready', matchPrefix: true },
  { label: 'My loans', to: '/loans', icon: HandCoins, permission: PERMISSIONS.LOAN_READ, status: 'ready', matchPrefix: true },
  { label: 'My medical', to: '/medical', icon: HeartPulse, permission: PERMISSIONS.MEDICAL_READ, status: 'ready', matchPrefix: true },
  { label: 'My equipment requests', to: '/assets/requests', icon: PackagePlus, permission: PERMISSIONS.ASSET_REQUEST_READ, status: 'ready', matchPrefix: true },
  { label: 'Lunch', to: '/lunch', icon: Sandwich, permission: PERMISSIONS.LUNCH_ORDER_READ_OWN, status: 'ready', matchPrefix: true },
];

export function isNavItemVisible(item: NavItem, permissions: ReadonlySet<Permission>): boolean {
  if (!item.permission) return true;
  const list = Array.isArray(item.permission) ? item.permission : [item.permission];
  return list.some((p) => permissions.has(p));
}

function filterSections(
  sections: NavSection[],
  permissions: ReadonlySet<Permission>,
  hidden: (item: NavItem) => boolean,
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isNavItemVisible(item, permissions) && !hidden(item)),
    }))
    .filter((section) => section.items.length > 0);
}

export interface NavigationOptions {
  /** Administrator only: also list their own services in the sidebar. */
  showSelfService?: boolean;
  /** Leaves an item out for reasons other than a grant (medical eligibility). */
  hide?: (item: NavItem) => boolean;
}

/** The administrator's self-service rows, minus routes their sidebar already has. */
export function selfServiceFor(
  permissions: ReadonlySet<Permission>,
  hide: (item: NavItem) => boolean = () => false,
): NavItem[] {
  const managed = new Set(
    filterSections(ADMIN_NAV_SECTIONS, permissions, () => false).flatMap((s) =>
      s.items.map((i) => i.to),
    ),
  );
  return SELF_SERVICE_ITEMS.filter(
    (item) => isNavItemVisible(item, permissions) && !managed.has(item.to) && !hide(item),
  );
}

/** The sections a user with these grants is shown, in order. */
export function navigationFor(
  permissions: ReadonlySet<Permission>,
  { showSelfService = false, hide = () => false }: NavigationOptions = {},
): NavSection[] {
  if (navModeFor(permissions) === 'employee') {
    return filterSections(NAV_SECTIONS, permissions, hide);
  }
  const sections = filterSections(ADMIN_NAV_SECTIONS, permissions, () => false);
  if (!showSelfService) return sections;
  const mine = selfServiceFor(permissions, hide);
  if (mine.length === 0) return sections;
  // Before System administration, so Help stays the last row.
  const at = sections.findIndex((s) => s.key === 'system-administration');
  const own: NavSection = { key: 'my-self-service', label: 'My self-service', items: mine };
  return at === -1 ? [...sections, own] : [...sections.slice(0, at), own, ...sections.slice(at)];
}

/**
 * The row a path belongs to: the most specific visible row that matches it.
 *
 * Longest match rather than first match, so /settings/roles lights "Roles &
 * permissions" and not Settings as well - one highlighted row, always.
 */
export function activeNavPath(sections: NavSection[], pathname: string): string | null {
  let best: string | null = null;
  for (const item of sections.flatMap((s) => s.items)) {
    if (item.status === 'planned') continue;
    const hit = item.matchPrefix
      ? pathname === item.to || pathname.startsWith(`${item.to}/`)
      : pathname === item.to;
    if (hit && (best === null || item.to.length > best.length)) best = item.to;
  }
  return best;
}

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
  '/organisation/hierarchy': 'Org hierarchy',
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
  '/assets': 'Assets',
  '/assets/dashboard': 'Asset dashboard',
  '/assets/issues': 'Asset issues',
  '/assets/reports': 'Asset reports',
  '/assets/requests': 'Equipment requests',
  '/assets/:id': 'Asset',
  '/settings/asset-categories': 'Asset management',
  '/recruitment': 'Recruitment',
  '/recruitment/job-openings': 'Job openings',
  '/recruitment/candidates': 'Candidates',
  '/recruitment/interviews': 'Interviews',
  '/settings/approval-hierarchy': 'Approval hierarchy',
  '/settings/users': 'Users',
  '/settings/roles': 'Roles and permissions',
  '/settings/audit': 'Audit log',
};
