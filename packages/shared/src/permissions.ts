/**
 * The single source of truth for permissions.
 *
 * The API seeds this list into the `Permission` table and guards routes with it;
 * the web app uses it to gate navigation and controls. Because both sides import
 * the same constant, a typo becomes a compile error rather than a silent 403.
 *
 * Naming: `<resource>.<action>`. Add new entries as modules land - never invent
 * a permission string inline at a call site.
 */
export const PERMISSIONS = {
  // --- Company & organisation ---
  COMPANY_READ: 'company.read',
  COMPANY_MANAGE: 'company.manage',
  DEPARTMENT_READ: 'department.read',
  DEPARTMENT_MANAGE: 'department.manage',
  TEAM_READ: 'team.read',
  TEAM_MANAGE: 'team.manage',
  DESIGNATION_READ: 'designation.read',
  DESIGNATION_MANAGE: 'designation.manage',
  LOCATION_READ: 'location.read',
  LOCATION_MANAGE: 'location.manage',

  // --- People ---
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_MANAGE: 'employee.manage',
  /// Restricted identity and financial fields: national ID, passport, visa,
  /// bank account. Stripped from responses without this grant.
  EMPLOYEE_SENSITIVE_READ: 'employee.sensitive.read',
  EMPLOYEE_IMPORT: 'employee.import',
  EMPLOYEE_EXPORT: 'employee.export',

  // --- Access control ---
  USER_READ: 'user.read',
  USER_MANAGE: 'user.manage',
  ROLE_READ: 'role.read',
  ROLE_MANAGE: 'role.manage',

  // --- Approvals ---
  /// See approval requests within your data scope.
  APPROVAL_READ: 'approval.read',
  /// Act on requests where you are the assigned approver.
  APPROVAL_ACT: 'approval.act',
  /// Administrative override: see and act on any request in the company.
  APPROVAL_MANAGE: 'approval.manage',

  // --- Time ---
  ATTENDANCE_READ: 'attendance.read',
  ATTENDANCE_MANAGE: 'attendance.manage',
  SHIFT_READ: 'shift.read',
  SHIFT_MANAGE: 'shift.manage',
  TIMESHEET_READ: 'timesheet.read',
  TIMESHEET_MANAGE: 'timesheet.manage',

  // --- Governance ---
  AUDIT_READ: 'audit.read',
  SETTINGS_MANAGE: 'settings.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Grouped for the Roles & Permissions settings screen. */
export const PERMISSION_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  permissions: ReadonlyArray<{ value: Permission; label: string; description: string }>;
}> = [
  {
    key: 'organisation',
    label: 'Organisation',
    description: 'Company profile, departments and teams.',
    permissions: [
      { value: PERMISSIONS.COMPANY_READ, label: 'View company', description: 'See company profile and settings.' },
      { value: PERMISSIONS.COMPANY_MANAGE, label: 'Manage company', description: 'Edit company profile and settings.' },
      { value: PERMISSIONS.DEPARTMENT_READ, label: 'View departments', description: 'See the department list.' },
      { value: PERMISSIONS.DEPARTMENT_MANAGE, label: 'Manage departments', description: 'Create, edit and remove departments.' },
      { value: PERMISSIONS.TEAM_READ, label: 'View teams', description: 'See the team list.' },
      { value: PERMISSIONS.TEAM_MANAGE, label: 'Manage teams', description: 'Create, edit and remove teams.' },
      { value: PERMISSIONS.DESIGNATION_READ, label: 'View designations', description: 'See the job title list.' },
      { value: PERMISSIONS.DESIGNATION_MANAGE, label: 'Manage designations', description: 'Create, edit and remove job titles.' },
      { value: PERMISSIONS.LOCATION_READ, label: 'View locations', description: 'See the work location list.' },
      { value: PERMISSIONS.LOCATION_MANAGE, label: 'Manage locations', description: 'Create, edit and remove work locations.' },
    ],
  },
  {
    key: 'people',
    label: 'People',
    description: 'Employee records.',
    permissions: [
      { value: PERMISSIONS.EMPLOYEE_READ, label: 'View employees', description: 'See employee records.' },
      { value: PERMISSIONS.EMPLOYEE_MANAGE, label: 'Manage employees', description: 'Create, edit and deactivate employees.' },
      {
        value: PERMISSIONS.EMPLOYEE_SENSITIVE_READ,
        label: 'View restricted fields',
        description: 'See national ID, passport, visa and bank details. Grant sparingly.',
      },
      { value: PERMISSIONS.EMPLOYEE_IMPORT, label: 'Import employees', description: 'Bulk-create employees from a file.' },
      { value: PERMISSIONS.EMPLOYEE_EXPORT, label: 'Export employees', description: 'Download employee data as a file.' },
    ],
  },
  {
    key: 'access',
    label: 'Access control',
    description: 'Login accounts, roles and permissions.',
    permissions: [
      { value: PERMISSIONS.USER_READ, label: 'View users', description: 'See login accounts.' },
      { value: PERMISSIONS.USER_MANAGE, label: 'Manage users', description: 'Invite, edit and disable login accounts.' },
      { value: PERMISSIONS.ROLE_READ, label: 'View roles', description: 'See roles and their permissions.' },
      { value: PERMISSIONS.ROLE_MANAGE, label: 'Manage roles', description: 'Create roles and change permissions.' },
    ],
  },
  {
    key: 'approvals',
    label: 'Approvals',
    description: 'Requests that need a decision.',
    permissions: [
      { value: PERMISSIONS.APPROVAL_READ, label: 'View approvals', description: 'See requests within your data scope.' },
      { value: PERMISSIONS.APPROVAL_ACT, label: 'Decide approvals', description: 'Approve or reject requests assigned to you.' },
      { value: PERMISSIONS.APPROVAL_MANAGE, label: 'Administer approvals', description: 'See and decide any request in the company.' },
    ],
  },
  {
    key: 'time',
    label: 'Time',
    description: 'Attendance, shifts and timesheets.',
    permissions: [
      { value: PERMISSIONS.ATTENDANCE_READ, label: 'View attendance', description: 'See attendance records.' },
      { value: PERMISSIONS.ATTENDANCE_MANAGE, label: 'Manage attendance', description: 'Record and correct attendance.' },
      { value: PERMISSIONS.SHIFT_READ, label: 'View shifts', description: 'See shifts and assignments.' },
      { value: PERMISSIONS.SHIFT_MANAGE, label: 'Manage shifts', description: 'Create shifts and assign employees.' },
      { value: PERMISSIONS.TIMESHEET_READ, label: 'View timesheets', description: 'See timesheets.' },
      { value: PERMISSIONS.TIMESHEET_MANAGE, label: 'Manage timesheets', description: 'Create and submit timesheets.' },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    description: 'Audit trail and system settings.',
    permissions: [
      { value: PERMISSIONS.AUDIT_READ, label: 'View audit log', description: 'Read the system audit trail.' },
      { value: PERMISSIONS.SETTINGS_MANAGE, label: 'Manage settings', description: 'Change system-wide settings.' },
    ],
  },
];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * How much data a grant reaches, independent of which operation it allows.
 *
 * Permissions answer "may you read employees?"; scope answers "which ones?".
 * The two are orthogonal - a manager and an HR admin both hold `employee.read`,
 * but only one of them should see the whole company.
 */
export const DATA_SCOPES = {
  NONE: 'NONE',
  OWN: 'OWN',
  REPORTS: 'REPORTS',
  REPORTS_AND_OWN: 'REPORTS_AND_OWN',
  DEPARTMENT: 'DEPARTMENT',
  ALL: 'ALL',
} as const;

export type DataScope = (typeof DATA_SCOPES)[keyof typeof DATA_SCOPES];

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  NONE: 'No data',
  OWN: 'Own record only',
  REPORTS: 'Direct reports',
  REPORTS_AND_OWN: 'Direct reports and own record',
  DEPARTMENT: 'Whole department',
  ALL: 'Entire organisation',
};

/** Role keys seeded in every company. `SUPER_ADMIN` is protected from edits. */
export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/** Default grants applied by the seeder. Runtime grants live in the database. */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  HR_ADMIN: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.COMPANY_MANAGE,
    PERMISSIONS.DEPARTMENT_READ,
    PERMISSIONS.DEPARTMENT_MANAGE,
    PERMISSIONS.TEAM_READ,
    PERMISSIONS.TEAM_MANAGE,
    PERMISSIONS.DESIGNATION_READ,
    PERMISSIONS.DESIGNATION_MANAGE,
    PERMISSIONS.LOCATION_READ,
    PERMISSIONS.LOCATION_MANAGE,
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.EMPLOYEE_MANAGE,
    PERMISSIONS.EMPLOYEE_SENSITIVE_READ,
    PERMISSIONS.EMPLOYEE_IMPORT,
    PERMISSIONS.EMPLOYEE_EXPORT,
    PERMISSIONS.USER_READ,
    PERMISSIONS.ROLE_READ,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_ACT,
    PERMISSIONS.APPROVAL_MANAGE,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.ATTENDANCE_MANAGE,
    PERMISSIONS.SHIFT_READ,
    PERMISSIONS.SHIFT_MANAGE,
    PERMISSIONS.TIMESHEET_READ,
    PERMISSIONS.TIMESHEET_MANAGE,
  ],
  // Managers hold employee.read, but their DataScope narrows it to their own
  // reporting line - the permission says what, the scope says which.
  MANAGER: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.DEPARTMENT_READ,
    PERMISSIONS.TEAM_READ,
    PERMISSIONS.DESIGNATION_READ,
    PERMISSIONS.LOCATION_READ,
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_ACT,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.SHIFT_READ,
    PERMISSIONS.TIMESHEET_READ,
  ],
  EMPLOYEE: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.DEPARTMENT_READ,
    PERMISSIONS.TEAM_READ,
    PERMISSIONS.DESIGNATION_READ,
    PERMISSIONS.LOCATION_READ,
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.ATTENDANCE_READ,
    PERMISSIONS.SHIFT_READ,
    PERMISSIONS.TIMESHEET_READ,
    PERMISSIONS.TIMESHEET_MANAGE,
  ],
};

/** Default data scope per system role, applied when Phase 2 seeds roles. */
export const DEFAULT_ROLE_SCOPES: Record<SystemRoleKey, DataScope> = {
  SUPER_ADMIN: DATA_SCOPES.ALL,
  HR_ADMIN: DATA_SCOPES.ALL,
  MANAGER: DATA_SCOPES.REPORTS_AND_OWN,
  EMPLOYEE: DATA_SCOPES.OWN,
};
