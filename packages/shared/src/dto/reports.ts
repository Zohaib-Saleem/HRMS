import { z } from 'zod';

/**
 * The Employee Master Report: one row per employee, every module's figure for
 * that person in one place.
 *
 * A presentation layer and nothing else. Every number in a row is produced by
 * the module that owns it - attendance by the attendance engine, leave by the
 * leave service, loans by the loan schedule, salary by the salary records - so
 * a figure here and the same figure on the Employee 360 profile are the same
 * calculation reached by two routes, not two calculations that happen to agree
 * today.
 *
 * The column registry below is shared by the API and the browser on purpose.
 * The table, the column picker and the export all read one list, so a column
 * cannot be exportable but invisible, or visible but missing from the CSV.
 */

// ------------------------------------------------------------------- period

export const REPORT_PERIOD_PRESETS = ['this-month', 'last-month', 'this-year', 'custom'] as const;
export type ReportPeriodPreset = (typeof REPORT_PERIOD_PRESETS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriodPreset, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-year': 'This year',
  custom: 'Custom range',
};

const isoDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd.');

/**
 * Resolve a preset to the range it means, against a reference day.
 *
 * Pure and shared so the header ("1 Sep - 30 Sep") and the query the API runs
 * cannot disagree about what "this month" was.
 */
export function resolveReportPeriod(
  preset: ReportPeriodPreset,
  reference: Date,
  custom?: { from?: string | null; to?: string | null },
): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  switch (preset) {
    case 'this-month':
      return {
        from: day(new Date(Date.UTC(year, month, 1))),
        to: day(new Date(Date.UTC(year, month + 1, 0))),
      };
    case 'last-month':
      return {
        from: day(new Date(Date.UTC(year, month - 1, 1))),
        to: day(new Date(Date.UTC(year, month, 0))),
      };
    case 'this-year':
      return { from: day(new Date(Date.UTC(year, 0, 1))), to: day(new Date(Date.UTC(year, 11, 31))) };
    case 'custom':
    default: {
      const fallback = resolveReportPeriod('this-month', reference);
      return { from: custom?.from || fallback.from, to: custom?.to || fallback.to };
    }
  }
}

// -------------------------------------------------------------------- query

export const LOAN_FILTER_STATUSES = [
  'any',
  'active',
  'pending',
  'completed',
  'none',
] as const;
export type LoanFilterStatus = (typeof LOAN_FILTER_STATUSES)[number];

export const employeeMasterQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(64).default('fullName'),
  order: z.enum(['asc', 'desc']).default('asc'),

  period: z.enum(REPORT_PERIOD_PRESETS).default('this-month'),
  from: isoDay.optional(),
  to: isoDay.optional(),

  // Narrowed in SQL.
  status: z.string().trim().max(32).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  designationId: z.string().trim().max(64).optional(),
  locationId: z.string().trim().max(64).optional(),
  employmentType: z.string().trim().max(32).optional(),
  /** PROBATION / PERMANENT / INTERNEE. Omitted means every status. */
  employmentStatus: z.string().trim().max(32).optional(),
  hiredFrom: isoDay.optional(),
  hiredTo: isoDay.optional(),
  incrementDueFrom: isoDay.optional(),
  incrementDueTo: isoDay.optional(),

  /**
   * Narrowed after enrichment, because none of these exist as a column: they
   * are what the leave, loan, salary and attendance services return.
   */
  salaryMin: z.coerce.number().optional(),
  salaryMax: z.coerce.number().optional(),
  leaveTypeId: z.string().trim().max(64).optional(),
  leaveRemainingMin: z.coerce.number().optional(),
  leaveRemainingMax: z.coerce.number().optional(),
  loanStatus: z.enum(LOAN_FILTER_STATUSES).default('any'),
  hasActiveLoan: z.enum(['yes', 'no']).optional(),
  loanOutstandingMin: z.coerce.number().optional(),
  loanOutstandingMax: z.coerce.number().optional(),
  attendanceMin: z.coerce.number().min(0).max(100).optional(),
  attendanceMax: z.coerce.number().min(0).max(100).optional(),
  overtimeMinHours: z.coerce.number().optional(),

  /** Restricts the export to what the operator actually has on screen. */
  columns: z.string().trim().max(4000).optional(),
});

export type EmployeeMasterQuery = z.infer<typeof employeeMasterQuerySchema>;

// --------------------------------------------------------------------- rows

/**
 * One employee.
 *
 * Every block is optional because a block the caller may not read is OMITTED
 * rather than zeroed - a zero outstanding balance and "loans are not yours to
 * see" are different statements, and a report that renders them identically is
 * lying to somebody.
 */
export interface EmployeeMasterRow {
  employeeId: string;
  employeeNumber: string;
  /** Device PINs, from the mapping table. NOT the employee number. */
  punchCodes?: string[];

  firstName: string;
  lastName: string;
  fullName: string;
  workEmail: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  presentAddress: string | null;
  /** Requires employee.sensitive.read. */
  nationalId?: string | null;

  status: string;
  hireDate: string | null;
  confirmationDate: string | null;
  departmentName: string | null;
  teamName: string | null;
  designationName: string | null;
  jobTitle: string | null;
  locationName: string | null;
  managerName: string | null;
  employmentType: string;
  /** The canonical employment stage. Null when nobody has classified the row. */
  employmentStatus: string | null;
  terminationDate: string | null;
  resignationDate: string | null;

  education?: string | null;
  priorExperienceMonths: number | null;
  contract?: { type: string | null; startDate: string | null; endDate: string | null; status: string | null } | null;

  salary?: {
    amount: number;
    currency: string;
    effectiveFrom: string | null;
    revisionCount: number;
    nextIncrementDueDate: string | null;
    lastRevisionDate: string | null;
    lastRevisionAmount: number | null;
  };

  leave?: {
    year: number;
    entitlementDays: number;
    usedDays: number;
    adjustedDays: number;
    consumedDays: number;
    pendingDays: number;
    availableDays: number;
    byType: Array<{ leaveTypeId: string; code: string | null; name: string; entitlementDays: number; usedDays: number; availableDays: number }>;
    requestCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
  };

  loans?: {
    count: number;
    hasActiveLoan: boolean;
    statuses: string[];
    principalTotal: number;
    paidTotal: number;
    outstandingTotal: number;
    monthlyDeduction: number;
    remainingInstallments: number;
    nextDueMonth: string | null;
    currency: string;
  };

  attendance?: {
    from: string;
    to: string;
    present: number;
    absent: number;
    late: number;
    halfDay: number;
    onLeave: number;
    holiday: number;
    weekend: number;
    workedHours: number;
    overtimeHours: number;
    attendancePercentage: number | null;
  };
}

export interface EmployeeMasterTotals {
  employees: number;
  active: number;
  totalSalary?: number;
  currency: string;
  totalLeaveRemaining?: number;
  activeLoans?: number;
  outstandingLoans?: number;
  totalOvertimeHours?: number;
}

export interface EmployeeMasterReport {
  from: string;
  to: string;
  rows: EmployeeMasterRow[];
  totals: EmployeeMasterTotals;
  meta: { page: number; limit: number; total: number; totalPages: number };
  /** Column keys the caller's permissions allow. The picker offers only these. */
  availableColumns: string[];
}

// ---------------------------------------------------------------- columns

export const COLUMN_GROUPS = [
  'Personal',
  'Employment',
  'Salary',
  'Leave',
  'Loans',
  'Attendance',
  'Other',
] as const;
export type ColumnGroup = (typeof COLUMN_GROUPS)[number];

export interface MasterColumn {
  key: string;
  label: string;
  group: ColumnGroup;
  /** Absent means every reader gets it. */
  permission?: string;
  /** In the table before anyone touches the picker. */
  default?: boolean;
  align?: 'right';
}

/**
 * Every column, once.
 *
 * `permission` is enforced server-side when the row is built, and used here
 * only to keep a column the caller could never fill out of their picker.
 */
export const EMPLOYEE_MASTER_COLUMNS: readonly MasterColumn[] = [
  { key: 'employeeNumber', label: 'Employee Code', group: 'Personal', default: true },
  { key: 'fullName', label: 'Employee', group: 'Personal', default: true },
  { key: 'firstName', label: 'First Name', group: 'Personal' },
  { key: 'lastName', label: 'Last Name', group: 'Personal' },
  { key: 'punchCodes', label: 'PunchCode', group: 'Personal', permission: 'device.read' },
  { key: 'workEmail', label: 'Email', group: 'Personal' },
  { key: 'phone', label: 'Phone', group: 'Personal' },
  { key: 'nationalId', label: 'CNIC', group: 'Personal', permission: 'employee.sensitive.read' },
  { key: 'dateOfBirth', label: 'Date of Birth', group: 'Personal' },
  { key: 'gender', label: 'Gender', group: 'Personal' },
  { key: 'presentAddress', label: 'Address', group: 'Personal' },

  { key: 'status', label: 'Status', group: 'Employment', default: true },
  { key: 'hireDate', label: 'Joining Date', group: 'Employment', default: true },
  { key: 'confirmationDate', label: 'Confirmation Date', group: 'Employment' },
  { key: 'departmentName', label: 'Department', group: 'Employment', default: true },
  { key: 'teamName', label: 'Team', group: 'Employment', default: true },
  { key: 'designationName', label: 'Designation', group: 'Employment', default: true },
  { key: 'jobTitle', label: 'Job Title', group: 'Employment' },
  { key: 'locationName', label: 'Location', group: 'Employment' },
  { key: 'managerName', label: 'Reports To', group: 'Employment' },
  { key: 'employmentType', label: 'Employment Type', group: 'Employment' },
  { key: 'employmentStatus', label: 'Employment Status', group: 'Employment', default: true },
  { key: 'terminationDate', label: 'Termination Date', group: 'Employment' },
  { key: 'resignationDate', label: 'Resignation Date', group: 'Employment' },
  { key: 'contract', label: 'Contract', group: 'Employment', permission: 'contract.read' },

  { key: 'salaryAmount', label: 'Current Salary', group: 'Salary', permission: 'payroll.read', default: true, align: 'right' },
  { key: 'salaryEffectiveFrom', label: 'Salary Effective', group: 'Salary', permission: 'payroll.read' },
  { key: 'salaryRevisionCount', label: 'Revisions', group: 'Salary', permission: 'payroll.read', align: 'right' },
  { key: 'lastRevisionDate', label: 'Last Revision', group: 'Salary', permission: 'payroll.read' },
  { key: 'lastRevisionAmount', label: 'Last Revision Amount', group: 'Salary', permission: 'payroll.read', align: 'right' },
  { key: 'nextIncrementDueDate', label: 'Next Increment Due', group: 'Salary', permission: 'payroll.read' },

  { key: 'leaveEntitlement', label: 'Leave Entitlement', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveUsed', label: 'Leave Used', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveConsumed', label: 'Days Consumed', group: 'Leave', permission: 'leave.read', default: true, align: 'right' },
  { key: 'leaveAdjusted', label: 'Adjusted Days', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveRemaining', label: 'Leave Remaining', group: 'Leave', permission: 'leave.read', default: true, align: 'right' },
  { key: 'leavePending', label: 'Leave Pending', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveByType', label: 'Leave by Type', group: 'Leave', permission: 'leave.read' },
  { key: 'leaveRequestCount', label: 'Leave Requests', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leavePendingCount', label: 'Pending Requests', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveApprovedCount', label: 'Approved Requests', group: 'Leave', permission: 'leave.read', align: 'right' },
  { key: 'leaveRejectedCount', label: 'Rejected/Cancelled', group: 'Leave', permission: 'leave.read', align: 'right' },

  { key: 'hasActiveLoan', label: 'Active Loan', group: 'Loans', permission: 'loan.read', default: true },
  { key: 'loanStatuses', label: 'Loan Status', group: 'Loans', permission: 'loan.read' },
  { key: 'loanCount', label: 'Loans', group: 'Loans', permission: 'loan.read', align: 'right' },
  { key: 'loanPrincipal', label: 'Loan Amount', group: 'Loans', permission: 'loan.read', align: 'right' },
  { key: 'loanPaid', label: 'Loan Paid', group: 'Loans', permission: 'loan.read', align: 'right' },
  { key: 'loanOutstanding', label: 'Outstanding', group: 'Loans', permission: 'loan.read', default: true, align: 'right' },
  { key: 'loanMonthly', label: 'Monthly Deduction', group: 'Loans', permission: 'loan.read', align: 'right' },
  { key: 'loanRemainingInstallments', label: 'Installments Left', group: 'Loans', permission: 'loan.read', align: 'right' },
  { key: 'loanNextDueMonth', label: 'Next Due', group: 'Loans', permission: 'loan.read' },

  { key: 'attPresent', label: 'Present', group: 'Attendance', permission: 'attendance.read', default: true, align: 'right' },
  { key: 'attAbsent', label: 'Absent', group: 'Attendance', permission: 'attendance.read', default: true, align: 'right' },
  { key: 'attLate', label: 'Late', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attHalfDay', label: 'Half Days', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attOnLeave', label: 'Leave Days', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attHoliday', label: 'Holidays', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attWeekend', label: 'Weekend/Off', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attWorkedHours', label: 'Hours Worked', group: 'Attendance', permission: 'attendance.read', align: 'right' },
  { key: 'attOvertimeHours', label: 'Overtime Hours', group: 'Attendance', permission: 'attendance.read', default: true, align: 'right' },
  { key: 'attPercentage', label: 'Attendance %', group: 'Attendance', permission: 'attendance.read', default: true, align: 'right' },

  { key: 'education', label: 'Education', group: 'Other' },
  { key: 'priorExperienceMonths', label: 'Prior Experience', group: 'Other', align: 'right' },
];

export const DEFAULT_MASTER_COLUMNS = EMPLOYEE_MASTER_COLUMNS.filter((c) => c.default).map((c) => c.key);

/** Sortable keys. Anything not here falls back to the employee's name. */
export const EMPLOYEE_MASTER_SORT_KEYS = EMPLOYEE_MASTER_COLUMNS.map((c) => c.key);
