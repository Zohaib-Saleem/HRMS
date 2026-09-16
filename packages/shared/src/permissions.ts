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
  /// Change the address an account signs in with. Deliberately separate from
  /// `user.manage`: every other account action is reversible by the next
  /// administrator, and this one hands somebody a different identity. Held by
  /// `SUPER_ADMIN` alone unless a company grants it on purpose.
  USER_EMAIL_MANAGE: 'user.email.manage',
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
  /// Change the company attendance rules. Super Admin holds it through
  /// settings.manage as well; this exists so HR Admin can be granted it on its
  /// own, explicitly, without being handed every other system setting.
  ATTENDANCE_RULES_MANAGE: 'attendance.rules.manage',
  SHIFT_READ: 'shift.read',
  SHIFT_MANAGE: 'shift.manage',
  TIMESHEET_READ: 'timesheet.read',
  TIMESHEET_MANAGE: 'timesheet.manage',
  /// See attendance terminals, their sync history and the raw punches they send.
  DEVICE_READ: 'device.read',
  /// Configure terminals, map device users and trigger a synchronisation.
  DEVICE_MANAGE: 'device.manage',

  // --- Leave & holidays ---
  /// See leave requests and balances within your data scope.
  LEAVE_READ: 'leave.read',
  /// Raise and cancel your own leave.
  LEAVE_REQUEST: 'leave.request',
  /// Configure leave types and adjust balances for others.
  LEAVE_MANAGE: 'leave.manage',
  HOLIDAY_READ: 'holiday.read',
  HOLIDAY_MANAGE: 'holiday.manage',

  // --- Payroll ---
  /// See payroll runs, lines and figures within your data scope. Salary is
  /// money about a named person, so this is deliberately separate from
  /// attendance and from employee.read.
  PAYROLL_READ: 'payroll.read',
  /// Configure payroll, set salaries and components, create and calculate runs.
  PAYROLL_MANAGE: 'payroll.manage',
  /// Approve and finalize a run. Held separately so a company that wants two
  /// pairs of eyes on payroll can revoke it from whoever prepares the run.
  PAYROLL_APPROVE: 'payroll.approve',
  /// See payslips within your data scope. Every member of staff holds this with
  /// an OWN scope, which is what lets them see their own and nothing else.
  PAYSLIP_READ: 'payslip.read',

  // --- Employment paperwork ---
  /// See employment contracts within your data scope.
  CONTRACT_READ: 'contract.read',
  /// Create, renew and terminate employment contracts.
  CONTRACT_MANAGE: 'contract.manage',
  /// See company policies and who has acknowledged them.
  POLICY_READ: 'policy.read',
  /// Publish policy versions and assign them to employees.
  POLICY_MANAGE: 'policy.manage',

  // --- Loans ---
  /// See loans and their repayment schedules within your data scope.
  LOAN_READ: 'loan.read',
  /// Apply for a loan for yourself.
  LOAN_REQUEST: 'loan.request',
  /// Create loans for others, edit them and cancel them.
  LOAN_MANAGE: 'loan.manage',
  /// Approve or reject a loan application. Held separately so the person who
  /// raises a loan need not be the person who agrees to it.
  LOAN_APPROVE: 'loan.approve',
  /// See the company-wide loan policy - the eligibility rules an application is
  /// measured against. Separate from LOAN_READ because the rules are company
  /// configuration, not somebody's loan.
  LOAN_POLICY_READ: 'loan.policy.read',
  /// Change the loan policy. Super Admin only by default: moving the maximum
  /// loan from one month's salary to two is a financial decision, not an
  /// administrative one.
  LOAN_POLICY_MANAGE: 'loan.policy.manage',

  // --- Medical ---
  /// See a medical benefit: the entitlement, what is left of it, and the
  /// dependents it covers. Held with an OWN data scope by every member of
  /// staff, which is what lets somebody see their own and nothing else.
  ///
  /// Reaching ANOTHER employee's medical information needs `medical.manage` as
  /// well as the data scope - see `assertMedicalSubjectAccess`. Medical data is
  /// the one place where a wide data scope is deliberately not enough on its
  /// own, because a manager's reporting line is not a reason to read somebody's
  /// dependents.
  MEDICAL_READ: 'medical.read',
  /// Maintain medical dependents for other employees, and read their benefit.
  /// HR's grant. It does not include changing the policy.
  MEDICAL_MANAGE: 'medical.manage',
  /// See the company-wide medical policy - the entitlement, category limits and
  /// claim rules a benefit is measured against. Separate from `medical.read`
  /// because the rules are company configuration, not somebody's benefit.
  MEDICAL_POLICY_READ: 'medical.policy.read',
  /// Change the medical policy. Super Admin only by default: moving the annual
  /// limit is a financial decision, not an administrative one.
  MEDICAL_POLICY_MANAGE: 'medical.policy.manage',
  /// Submit a medical claim for yourself, and withdraw one nobody has decided
  /// yet. Held by every member of staff; it reaches only their own claims.
  MEDICAL_CLAIM_REQUEST: 'medical.claim.request',
  /// Decide a medical claim: approve it in full, approve part of it, or refuse
  /// it. Held separately from `medical.manage` so the person who records a
  /// claim need not be the person who agrees to pay it.
  ///
  /// A medical claim is deliberately NOT routed through the ordinary approval
  /// chain. That chain runs through the employee's line manager, and a manager
  /// has no business seeing what treatment somebody had - so claims are decided
  /// by holders of this grant instead.
  MEDICAL_CLAIM_APPROVE: 'medical.claim.approve',

  // --- Cases (employee helpdesk) ---
  /// See your OWN cases and nothing else. Deliberately named `.own`: there is
  /// no data scope that widens it, because a wide scope is granted for
  /// line-management reasons and a case is not a line-management matter. The
  /// department-wide and company-wide grants an agent needs are a Phase 2
  /// addition with their own keys, so nobody can be handed somebody else's
  /// cases by accident in the meantime.
  CASE_READ_OWN: 'case.read.own',
  /// Raise a case for yourself. It carries no employee id at all, so this can
  /// only ever produce the holder's own case.
  CASE_CREATE: 'case.create',
  /// Reply on a case you raised. Separate from `case.create` so a company can
  /// stop new cases during a freeze without silencing the open ones.
  CASE_REPLY_OWN: 'case.reply.own',
  /// Reopen your own resolved or closed case. The one status change that
  /// belongs to the requester: they are the only person who can tell whether
  /// the thing is actually fixed.
  CASE_REOPEN_OWN: 'case.reopen.own',

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
      { value: PERMISSIONS.USER_EMAIL_MANAGE, label: 'Change sign-in addresses', description: 'Change the email address an account signs in with.' },
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
    key: 'payroll',
    label: 'Payroll',
    description: 'Salaries, payroll runs and payslips.',
    permissions: [
      { value: PERMISSIONS.PAYROLL_READ, label: 'View payroll', description: 'See payroll runs and figures within your data scope.' },
      { value: PERMISSIONS.PAYROLL_MANAGE, label: 'Manage payroll', description: 'Set salaries and components, create and calculate runs.' },
      { value: PERMISSIONS.PAYROLL_APPROVE, label: 'Approve payroll', description: 'Approve and finalize a run. Grant sparingly.' },
      { value: PERMISSIONS.PAYSLIP_READ, label: 'View payslips', description: 'See payslips within your data scope.' },
    ],
  },
  {
    key: 'time',
    label: 'Time',
    description: 'Attendance, shifts and timesheets.',
    permissions: [
      { value: PERMISSIONS.ATTENDANCE_READ, label: 'View attendance', description: 'See attendance records.' },
      { value: PERMISSIONS.ATTENDANCE_MANAGE, label: 'Manage attendance', description: 'Record and correct attendance.' },
      {
        value: PERMISSIONS.ATTENDANCE_RULES_MANAGE,
        label: 'Manage attendance rules',
        description: 'Change the company rules that decide what a day is worth. Super Admin only by default.',
      },
      { value: PERMISSIONS.SHIFT_READ, label: 'View shifts', description: 'See shifts and assignments.' },
      { value: PERMISSIONS.SHIFT_MANAGE, label: 'Manage shifts', description: 'Create shifts and assign employees.' },
      { value: PERMISSIONS.TIMESHEET_READ, label: 'View timesheets', description: 'See timesheets.' },
      { value: PERMISSIONS.TIMESHEET_MANAGE, label: 'Manage timesheets', description: 'Create and submit timesheets.' },
      { value: PERMISSIONS.DEVICE_READ, label: 'View attendance devices', description: 'See terminals, sync history and raw punches.' },
      { value: PERMISSIONS.DEVICE_MANAGE, label: 'Manage attendance devices', description: 'Configure terminals, map device users and run a sync.' },
    ],
  },
  {
    key: 'leave',
    label: 'Leave and holidays',
    description: 'Time off, balances and the holiday calendar.',
    permissions: [
      { value: PERMISSIONS.LEAVE_READ, label: 'View leave', description: 'See leave requests and balances within your scope.' },
      { value: PERMISSIONS.LEAVE_REQUEST, label: 'Request leave', description: 'Raise and cancel your own leave.' },
      { value: PERMISSIONS.LEAVE_MANAGE, label: 'Manage leave', description: 'Configure leave types and adjust balances.' },
      { value: PERMISSIONS.HOLIDAY_READ, label: 'View holidays', description: 'See the holiday calendar.' },
      { value: PERMISSIONS.HOLIDAY_MANAGE, label: 'Manage holidays', description: 'Create and edit holidays.' },
    ],
  },
  {
    key: 'paperwork',
    label: 'Contracts and policies',
    description: 'Employment contracts and the policies employees sign off.',
    permissions: [
      { value: PERMISSIONS.CONTRACT_READ, label: 'View contracts', description: 'See employment contracts within your scope.' },
      { value: PERMISSIONS.CONTRACT_MANAGE, label: 'Manage contracts', description: 'Create, renew and terminate contracts.' },
      { value: PERMISSIONS.POLICY_READ, label: 'View policies', description: 'See policies and acknowledgement status.' },
      { value: PERMISSIONS.POLICY_MANAGE, label: 'Manage policies', description: 'Publish versions and assign them to employees.' },
    ],
  },
  {
    key: 'loans',
    label: 'Loans',
    description: 'Employee loans and salary advances.',
    permissions: [
      { value: PERMISSIONS.LOAN_READ, label: 'View loans', description: 'See loans and repayment schedules within your scope.' },
      { value: PERMISSIONS.LOAN_REQUEST, label: 'Apply for a loan', description: 'Raise and withdraw your own loan application.' },
      { value: PERMISSIONS.LOAN_MANAGE, label: 'Manage loans', description: 'Create loans for others, edit and cancel them.' },
      { value: PERMISSIONS.LOAN_APPROVE, label: 'Approve loans', description: 'Approve or reject an application. Grant sparingly.' },
      { value: PERMISSIONS.LOAN_POLICY_READ, label: 'View loan policy', description: 'See the eligibility rules applications are measured against.' },
      { value: PERMISSIONS.LOAN_POLICY_MANAGE, label: 'Manage loan policy', description: 'Change the company loan rules. Grant to Super Admin only.' },
    ],
  },
  {
    key: 'medical',
    label: 'Medical',
    description: 'Medical benefits, dependents and the company medical policy.',
    permissions: [
      {
        value: PERMISSIONS.MEDICAL_READ,
        label: 'View medical benefit',
        description: 'See your own medical entitlement, balance and dependents.',
      },
      {
        value: PERMISSIONS.MEDICAL_MANAGE,
        label: 'Manage medical records',
        description: "Read other employees' medical benefit and maintain their dependents. Grant sparingly.",
      },
      {
        value: PERMISSIONS.MEDICAL_POLICY_READ,
        label: 'View medical policy',
        description: 'See the entitlement, category limits and claim rules.',
      },
      {
        value: PERMISSIONS.MEDICAL_POLICY_MANAGE,
        label: 'Manage medical policy',
        description: 'Change the company medical rules. Grant to Super Admin only.',
      },
      {
        value: PERMISSIONS.MEDICAL_CLAIM_REQUEST,
        label: 'Submit medical claims',
        description: 'Raise and withdraw your own medical claims.',
      },
      {
        value: PERMISSIONS.MEDICAL_CLAIM_APPROVE,
        label: 'Decide medical claims',
        description: 'Approve, part-approve or refuse a claim. Grant sparingly.',
      },
    ],
  },
  {
    key: 'cases',
    label: 'Cases',
    description: 'The employee helpdesk: raising a case, and following it.',
    permissions: [
      {
        value: PERMISSIONS.CASE_READ_OWN,
        label: 'View own cases',
        description: 'See the cases you raised, and only those.',
      },
      { value: PERMISSIONS.CASE_CREATE, label: 'Raise a case', description: 'Open a case for yourself.' },
      {
        value: PERMISSIONS.CASE_REPLY_OWN,
        label: 'Reply to own cases',
        description: 'Add a reply and attach a file to a case you raised.',
      },
      {
        value: PERMISSIONS.CASE_REOPEN_OWN,
        label: 'Reopen own cases',
        description: 'Reopen your own case when it was not actually fixed.',
      },
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
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_MANAGE,
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_REQUEST,
    PERMISSIONS.LEAVE_MANAGE,
    PERMISSIONS.HOLIDAY_READ,
    PERMISSIONS.HOLIDAY_MANAGE,
    PERMISSIONS.PAYROLL_READ,
    PERMISSIONS.PAYROLL_MANAGE,
    PERMISSIONS.PAYROLL_APPROVE,
    PERMISSIONS.PAYSLIP_READ,
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.CONTRACT_MANAGE,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.POLICY_MANAGE,
    PERMISSIONS.LOAN_READ,
    PERMISSIONS.LOAN_REQUEST,
    PERMISSIONS.LOAN_MANAGE,
    PERMISSIONS.LOAN_APPROVE,
    // Read, not manage. HR decides loan applications and has to be able to
    // explain a refusal, which means seeing the rule that caused it. Changing
    // the rule is Super Admin's.
    PERMISSIONS.LOAN_POLICY_READ,
    // HR maintains dependents and answers "why was this refused?", so it needs
    // to read the medical rules. Changing them is Super Admin's, for the same
    // reason the loan policy is: the annual limit is money.
    PERMISSIONS.MEDICAL_READ,
    PERMISSIONS.MEDICAL_MANAGE,
    PERMISSIONS.MEDICAL_POLICY_READ,
    PERMISSIONS.MEDICAL_CLAIM_REQUEST,
    // HR decides claims, because the ordinary approval chain runs through a
    // line manager and a manager must not see somebody's treatment.
    PERMISSIONS.MEDICAL_CLAIM_APPROVE,
    // The helpdesk, from the employee's side. Everyone who works here raises
    // cases, so every system role holds these four and nothing wider: there is
    // no department-wide or company-wide case grant in phase 1, deliberately,
    // so no role can be handed somebody else's cases before the agent side
    // exists to justify it.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
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
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_REQUEST,
    PERMISSIONS.HOLIDAY_READ,
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.LOAN_READ,
    PERMISSIONS.LOAN_REQUEST,
    // Their own benefit, and only their own. A manager holds no
    // `medical.manage`, and the medical routes require that on top of the data
    // scope before they will show anybody else's record - so a REPORTS_AND_OWN
    // scope reaches this manager's own dependents and stops there. No medical
    // POLICY permission at all: the rules are not a line-management concern.
    PERMISSIONS.MEDICAL_READ,
    // Their own claims, and only their own. Managers hold no claim.approve:
    // deciding a report's medical claim would mean reading their treatment.
    PERMISSIONS.MEDICAL_CLAIM_REQUEST,
    // The helpdesk, from the employee's side. Everyone who works here raises
    // cases, so every system role holds these four and nothing wider: there is
    // no department-wide or company-wide case grant in phase 1, deliberately,
    // so no role can be handed somebody else's cases before the agent side
    // exists to justify it.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
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
    PERMISSIONS.LEAVE_READ,
    PERMISSIONS.LEAVE_REQUEST,
    PERMISSIONS.HOLIDAY_READ,
    PERMISSIONS.PAYSLIP_READ,
    // An OWN data scope narrows all four to the employee's own record: their
    // contract, the policies they were asked to sign, and their own loans.
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.POLICY_READ,
    PERMISSIONS.LOAN_READ,
    PERMISSIONS.LOAN_REQUEST,
    // Narrowed to their own record by the OWN scope, and narrowed again by the
    // medical routes, which will not show another employee's benefit without
    // `medical.manage`. No policy permission: an employee cannot see, let alone
    // change, the rules that decide their entitlement.
    PERMISSIONS.MEDICAL_READ,
    PERMISSIONS.MEDICAL_CLAIM_REQUEST,
    // The helpdesk, from the employee's side. Everyone who works here raises
    // cases, so every system role holds these four and nothing wider: there is
    // no department-wide or company-wide case grant in phase 1, deliberately,
    // so no role can be handed somebody else's cases before the agent side
    // exists to justify it.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
  ],
};

/** Default data scope per system role, applied when Phase 2 seeds roles. */
export const DEFAULT_ROLE_SCOPES: Record<SystemRoleKey, DataScope> = {
  SUPER_ADMIN: DATA_SCOPES.ALL,
  HR_ADMIN: DATA_SCOPES.ALL,
  MANAGER: DATA_SCOPES.REPORTS_AND_OWN,
  EMPLOYEE: DATA_SCOPES.OWN,
};
