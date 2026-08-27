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

  // --- People ---
  EMPLOYEE_READ: 'employee.read',
  EMPLOYEE_MANAGE: 'employee.manage',

  // --- Access control ---
  USER_READ: 'user.read',
  USER_MANAGE: 'user.manage',
  ROLE_READ: 'role.read',
  ROLE_MANAGE: 'role.manage',

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
    ],
  },
  {
    key: 'people',
    label: 'People',
    description: 'Employee records.',
    permissions: [
      { value: PERMISSIONS.EMPLOYEE_READ, label: 'View employees', description: 'See employee records.' },
      { value: PERMISSIONS.EMPLOYEE_MANAGE, label: 'Manage employees', description: 'Create, edit and deactivate employees.' },
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
    PERMISSIONS.EMPLOYEE_READ,
    PERMISSIONS.EMPLOYEE_MANAGE,
    PERMISSIONS.USER_READ,
    PERMISSIONS.ROLE_READ,
    PERMISSIONS.AUDIT_READ,
  ],
  MANAGER: [
    PERMISSIONS.COMPANY_READ,
    PERMISSIONS.DEPARTMENT_READ,
    PERMISSIONS.TEAM_READ,
    PERMISSIONS.EMPLOYEE_READ,
  ],
  EMPLOYEE: [PERMISSIONS.COMPANY_READ, PERMISSIONS.DEPARTMENT_READ, PERMISSIONS.TEAM_READ],
};
