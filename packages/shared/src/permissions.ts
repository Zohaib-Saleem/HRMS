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

  // --- Cases (the desk that answers them) ---
  /// Work the queue for your OWN department: every case routed to the
  /// department on your employee record, whoever raised it.
  ///
  /// The department comes from the agent's employee record rather than from a
  /// list somebody maintains, because a case is already routed to a real
  /// department row and an IT case is worked by the IT department. It is also
  /// the reason this is not a DataScope: `DEPARTMENT` scope is granted so a
  /// department head can read their people's RECORDS, and reading somebody's
  /// employee record is not a reason to read what they asked HR about. The two
  /// answer different questions and must be able to disagree.
  CASE_READ_DEPARTMENT: 'case.read.department',
  /// Every case in the company, whichever queue it was filed in. For the person
  /// who runs the helpdesk rather than one desk of it.
  CASE_READ_ALL: 'case.read.all',
  /// Assign a case, to yourself or to somebody else, and unassign one. Split
  /// from `case.update` because taking ownership and doing the work are
  /// different acts: a triager sorts the queue without touching a case's state.
  CASE_ASSIGN: 'case.assign',
  /// Move a case on: its status, its priority, and the queue it sits in when it
  /// was filed in the wrong one. Every status change is checked against the
  /// shared transition map, so this grant buys the workflow, not a free hand.
  CASE_UPDATE: 'case.update',
  /// Reply to the requester on a case you are working, and attach a file to
  /// that reply. Separate from `case.update` so somebody can answer a question
  /// without being able to close the case it was asked on.
  CASE_RESPOND: 'case.respond',
  /// Write a staff-only note: visible to the desk, never to the requester and
  /// never sent to them. Its own grant because it is the one thing written on a
  /// case that its subject can never see, and that deserves to be handed out
  /// deliberately rather than to arrive with the ability to reply.
  CASE_NOTE_INTERNAL: 'case.note.internal',
  /// Configure the routing catalogue: which departments have queues, what the
  /// categories under them are called, and which are retired. Administration of
  /// the helpdesk rather than work on a case, so it is held by the person who
  /// shapes the desk and not by everybody who staffs it.
  CASE_CATEGORY_MANAGE: 'case.category.manage',

  // --- Lunch (the daily order, and the money the office boy collects) ---
  /// Order lunch for yourself. The request carries no employee id, so it can
  /// only ever produce the holder's own order.
  LUNCH_ORDER_CREATE: 'lunch.order.create',
  /// See your OWN lunch orders and what you still owe for them. Deliberately
  /// named `.own`: no data scope widens it, because what a colleague ate is
  /// not a line-management matter.
  LUNCH_ORDER_READ_OWN: 'lunch.order.read.own',
  /// Call off your own order while nobody has paid for it. Separate from
  /// placing one so a company can keep the ordering open and still stop
  /// cancellations after the food has been bought.
  LUNCH_ORDER_CANCEL_OWN: 'lunch.order.cancel.own',

  /// Move somebody's order along the lunch round - ordered, preparing, ready,
  /// delivered. Its own grant because it is the kitchen's job rather than the
  /// cash box's: a company may well have one person cooking and another
  /// collecting, and neither needs the other's buttons.
  LUNCH_ORDER_FULFIL: 'lunch.order.fulfil',
  /// Cancel ANYBODY's lunch order, with a compulsory reason. The operator's
  /// own cancel, and deliberately not the same grant as the employee's:
  /// `lunch.order.cancel.own` can only ever reach the holder's own unpaid
  /// order, and this reaches everybody's.
  ///
  /// It carries the refund decision with it. Cancelling an order somebody has
  /// already paid for forces a choice between refunding and retaining the
  /// money, and both are recorded - so this grant is the ability to decide
  /// where cash that has already changed hands ends up, and is worth handing
  /// out as deliberately as that sounds.
  ///
  /// It does NOT reach a delivered order. Once the food has been handed over,
  /// putting something right is a payment correction, which says what it is.
  LUNCH_ORDER_CANCEL_ANY: 'lunch.order.cancel.any',
  /// See the day's orders and what they add up to: the office boy's own
  /// screen, and the only read in this module that reaches other people's
  /// orders. Held by whoever runs the lunch round, and by an administrator who
  /// wants the day's figures - reading the collection is oversight.
  LUNCH_COLLECTION_READ: 'lunch.collection.read',
  /// Mark an order paid. Separate from reading the collection because taking
  /// money is not the same act as counting it: a manager may want the day's
  /// figures without being able to write off what somebody owes.
  ///
  /// Nobody marks their own order paid through this. The endpoint refuses an
  /// order belonging to the caller, whatever grants they hold.
  LUNCH_PAYMENT_MARK: 'lunch.payment.mark',
  /// Put right a payment recorded wrongly - unmark a paid order, or correct
  /// the method it was taken by. Its own grant because it is the one action
  /// that rewrites money already counted, and it is never handed out with
  /// `lunch.payment.mark`: the person who can take money and the person who
  /// can undo having taken it are worth being able to keep apart. Every
  /// correction carries a written reason and is audited.
  LUNCH_PAYMENT_CORRECT: 'lunch.payment.correct',
  /// Maintain the menu and its prices. Company configuration rather than a
  /// day's work, so it sits with whoever sets prices and not with everybody
  /// who collects the money for them.
  LUNCH_MENU_MANAGE: 'lunch.menu.manage',

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
      {
        value: PERMISSIONS.CASE_READ_DEPARTMENT,
        label: 'Work your department queue',
        description: 'See every case filed to your own department, whoever raised it.',
      },
      {
        value: PERMISSIONS.CASE_READ_ALL,
        label: 'Work every queue',
        description: 'See every case in the company, in every department.',
      },
      {
        value: PERMISSIONS.CASE_ASSIGN,
        label: 'Assign cases',
        description: 'Take a case, hand it to somebody else, or put it back.',
      },
      {
        value: PERMISSIONS.CASE_UPDATE,
        label: 'Move cases on',
        description: 'Change a case\u2019s status and priority, and re-route a misfiled one.',
      },
      {
        value: PERMISSIONS.CASE_RESPOND,
        label: 'Reply to requesters',
        description: 'Answer the person who raised a case you are working.',
      },
      {
        value: PERMISSIONS.CASE_NOTE_INTERNAL,
        label: 'Write internal notes',
        description: 'Add a note the desk can see and the requester never can.',
      },
      {
        value: PERMISSIONS.CASE_CATEGORY_MANAGE,
        label: 'Configure the catalogue',
        description: 'Add, rename and retire the queues cases are filed under.',
      },
    ],
  },
  {
    key: 'lunch',
    label: 'Lunch',
    description:
      'The daily lunch order, and the cash the office boy collects for it. Not a finance module: no deduction, no approval, no gateway.',
    permissions: [
      {
        value: PERMISSIONS.LUNCH_ORDER_CREATE,
        label: 'Order lunch',
        description: 'Place a lunch order for yourself.',
      },
      {
        value: PERMISSIONS.LUNCH_ORDER_READ_OWN,
        label: 'View own lunch orders',
        description: 'See your own orders and whether you have paid for them.',
      },
      {
        value: PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
        label: 'Cancel own lunch order',
        description: 'Call off your own order while nobody has paid for it.',
      },
      {
        value: PERMISSIONS.LUNCH_ORDER_FULFIL,
        label: 'Move orders along',
        description: 'Mark an order preparing, ready or delivered.',
      },
      {
        value: PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
        label: "Cancel anybody's order",
        description:
          'Cancel an order with a written reason, and decide whether money already paid is refunded or retained. Not available once an order is delivered.',
      },
      {
        value: PERMISSIONS.LUNCH_COLLECTION_READ,
        label: "View the day's collection",
        description: "See every order for a day, and what is paid and still owed.",
      },
      {
        value: PERMISSIONS.LUNCH_PAYMENT_MARK,
        label: 'Mark orders paid',
        description: 'Record that somebody handed over the money for their lunch.',
      },
      {
        value: PERMISSIONS.LUNCH_PAYMENT_CORRECT,
        label: 'Correct a lunch payment',
        description: 'Undo or amend a payment recorded wrongly. Needs a reason, and is audited.',
      },
      {
        value: PERMISSIONS.LUNCH_MENU_MANAGE,
        label: 'Manage the lunch menu',
        description: 'Add, re-price and retire the items people can order.',
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
  /*
   * The office boy. A job rather than a rank, which is why it is the one system
   * role that grants nothing about employment: it reaches the lunch round and
   * the money collected for it, and no HR, payroll, attendance or
   * employee-record screen at all.
   *
   * A system role rather than something each company assembles by hand because
   * there is no way to assemble one - roles are seeded, and nothing in the API
   * creates them. A company that hires somebody to run lunch should find the
   * role already there.
   */
  LUNCH_OPERATOR: 'LUNCH_OPERATOR',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

/**
 * How each system role is written into the `roles` table.
 *
 * One definition, two consumers: the seeder that provisions a new company and
 * the catalogue sync that adds a role a later release introduced. They used to
 * carry a copy each, which is survivable right up until the day the two copies
 * disagree about what a role is called - and the sync matches system roles BY
 * NAME, so a disagreement there would silently stop granting.
 */
export const SYSTEM_ROLE_META: Record<
  SystemRoleKey,
  { name: string; description: string; isProtected: boolean }
> = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    description: 'Unrestricted access. Always holds every permission.',
    isProtected: true,
  },
  HR_ADMIN: {
    name: 'HR Admin',
    description: 'Manages people, organisation structure and company settings.',
    isProtected: false,
  },
  MANAGER: {
    name: 'Manager',
    description: 'Views their department and team information.',
    isProtected: false,
  },
  EMPLOYEE: {
    name: 'Employee',
    description: 'Baseline access for every member of staff.',
    isProtected: false,
  },
  LUNCH_OPERATOR: {
    name: 'Office Boy',
    description:
      'Runs the daily lunch round: takes the orders out, records who paid and reads what the day collected. Holds no HR, payroll or employee-record access.',
    isProtected: false,
  },
};

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
    // cases, so every system role holds these four - and only these four. The
    // grants that let somebody read a case they did not raise are the agent
    // ones below, and they are handed out by name rather than arriving with a
    // role, because working a queue is a job somebody is given.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
    // And the desk, for the queue HR itself staffs. Department-wide rather than
    // company-wide: an HR administrator answers the cases filed to HR, and a
    // case somebody raised with IT about their laptop is not HR's to read.
    // `case.read.all` is deliberately left to the Super Admin and to whichever
    // role a company builds for the person who runs the whole helpdesk.
    PERMISSIONS.CASE_READ_DEPARTMENT,
    PERMISSIONS.CASE_ASSIGN,
    PERMISSIONS.CASE_UPDATE,
    PERMISSIONS.CASE_RESPOND,
    PERMISSIONS.CASE_NOTE_INTERNAL,
    // The catalogue is company configuration, and HR is who configures it.
    PERMISSIONS.CASE_CATEGORY_MANAGE,
    // Lunch, from the eater's side. Everybody who works here eats, so every
    // system role holds these three - and only these three. The grants that
    // reach somebody else's order, or the money for it, belong to whoever runs
    // the lunch round and are handed out by name.
    PERMISSIONS.LUNCH_ORDER_CREATE,
    PERMISSIONS.LUNCH_ORDER_READ_OWN,
    PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
    // The menu and its prices are company configuration, and HR is who
    // configures it. The day's collection comes with it as a read, because
    // somebody has to be able to answer "what did lunch cost us on Tuesday"
    // without being handed the ability to write off what people owe - marking
    // an order paid and correcting a payment are the operator's own grants,
    // and neither arrives with this role.
    PERMISSIONS.LUNCH_MENU_MANAGE,
    PERMISSIONS.LUNCH_COLLECTION_READ,
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
    // cases, so every system role holds these four - and only these four. The
    // grants that let somebody read a case they did not raise are the agent
    // ones below, and they are handed out by name rather than arriving with a
    // role, because working a queue is a job somebody is given.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
    // Lunch, from the eater's side. Everybody who works here eats, so every
    // system role holds these three - and only these three. The grants that
    // reach somebody else's order, or the money for it, belong to whoever runs
    // the lunch round and are handed out by name.
    PERMISSIONS.LUNCH_ORDER_CREATE,
    PERMISSIONS.LUNCH_ORDER_READ_OWN,
    PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
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
    // cases, so every system role holds these four - and only these four. The
    // grants that let somebody read a case they did not raise are the agent
    // ones below, and they are handed out by name rather than arriving with a
    // role, because working a queue is a job somebody is given.
    PERMISSIONS.CASE_READ_OWN,
    PERMISSIONS.CASE_CREATE,
    PERMISSIONS.CASE_REPLY_OWN,
    PERMISSIONS.CASE_REOPEN_OWN,
    // Lunch, from the eater's side. Everybody who works here eats, so every
    // system role holds these three - and only these three. The grants that
    // reach somebody else's order, or the money for it, belong to whoever runs
    // the lunch round and are handed out by name.
    PERMISSIONS.LUNCH_ORDER_CREATE,
    PERMISSIONS.LUNCH_ORDER_READ_OWN,
    PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
  ],
  /*
   * The office boy, and the list is short on purpose: this role is handed to
   * somebody whose job is lunch, so it grants lunch and nothing else. No
   * employee read, no attendance, no payslip, no leave, no company settings -
   * not narrowed by a data scope, absent. A role that reached the roster
   * because its holder needed to know who ordered biryani would be the wrong
   * shape of answer to that question; the desk already names the employee on
   * each order it returns.
   */
  LUNCH_OPERATOR: [
    // He eats here too, and orders the same way everybody else does.
    PERMISSIONS.LUNCH_ORDER_CREATE,
    PERMISSIONS.LUNCH_ORDER_READ_OWN,
    PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
    // And he runs the round: the day's orders and its figures, the money as it
    // arrives, the plates as they go out, and calling off an order somebody is
    // not going to eat.
    PERMISSIONS.LUNCH_COLLECTION_READ,
    PERMISSIONS.LUNCH_PAYMENT_MARK,
    PERMISSIONS.LUNCH_ORDER_FULFIL,
    PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
    /*
     * Two lunch grants are deliberately NOT here.
     *
     * `lunch.payment.correct` undoes a payment already recorded, and it is
     * kept away from the person who records them - the one who can take money
     * and the one who can undo having taken it are worth being able to keep
     * apart. It goes to whoever supervises the round.
     *
     * `lunch.menu.manage` sets prices, which is what an employee will be
     * charged. That stays with HR Admin.
     */
  ],
};

/** Default data scope per system role, applied when Phase 2 seeds roles. */
export const DEFAULT_ROLE_SCOPES: Record<SystemRoleKey, DataScope> = {
  SUPER_ADMIN: DATA_SCOPES.ALL,
  HR_ADMIN: DATA_SCOPES.ALL,
  MANAGER: DATA_SCOPES.REPORTS_AND_OWN,
  EMPLOYEE: DATA_SCOPES.OWN,
  /*
   * OWN, and it costs the role nothing: the lunch desk scopes its queries to a
   * company and a day rather than through the data scope, so the office boy
   * sees every order on today's round either way. What OWN does buy is that if
   * this role is ever handed a permission that DOES consult the scope, it
   * reaches his own record and stops.
   */
  LUNCH_OPERATOR: DATA_SCOPES.OWN,
};
