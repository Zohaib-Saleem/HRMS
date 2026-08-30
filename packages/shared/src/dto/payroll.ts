import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/** Payroll: configuration, salaries, runs and payslips. */

export const PAYROLL_SALARY_TYPES = ['MONTHLY', 'DAILY', 'HOURLY'] as const;
export type PayrollSalaryType = (typeof PAYROLL_SALARY_TYPES)[number];

export const PAYROLL_SALARY_TYPE_LABELS: Record<PayrollSalaryType, string> = {
  MONTHLY: 'Monthly salary',
  DAILY: 'Daily rate',
  HOURLY: 'Hourly rate',
};

export const PAYROLL_FREQUENCIES = ['MONTHLY', 'BIWEEKLY', 'WEEKLY'] as const;
export type PayrollFrequency = (typeof PAYROLL_FREQUENCIES)[number];

export const PAYROLL_FREQUENCY_LABELS: Record<PayrollFrequency, string> = {
  MONTHLY: 'Monthly',
  BIWEEKLY: 'Every two weeks',
  WEEKLY: 'Weekly',
};

export const PAYROLL_BASES = ['CALENDAR_DAYS', 'FIXED_DAYS', 'WORKING_DAYS'] as const;
export type PayrollBasis = (typeof PAYROLL_BASES)[number];

export const PAYROLL_BASIS_LABELS: Record<PayrollBasis, string> = {
  CALENDAR_DAYS: 'Calendar days in the period',
  FIXED_DAYS: 'A fixed number of days',
  WORKING_DAYS: 'Scheduled working days',
};

export const PAYROLL_OVERTIME_MODES = ['NONE', 'MULTIPLIER', 'FIXED_RATE'] as const;
export type PayrollOvertimeMode = (typeof PAYROLL_OVERTIME_MODES)[number];

export const PAYROLL_OVERTIME_MODE_LABELS: Record<PayrollOvertimeMode, string> = {
  NONE: 'Not paid',
  MULTIPLIER: 'Hourly rate x multiplier',
  FIXED_RATE: 'A flat rate per hour',
};

export const PAYROLL_TIME_DEDUCTION_MODES = ['NONE', 'PER_MINUTE', 'PER_OCCURRENCE'] as const;
export type PayrollTimeDeductionMode = (typeof PAYROLL_TIME_DEDUCTION_MODES)[number];

export const PAYROLL_TIME_DEDUCTION_LABELS: Record<PayrollTimeDeductionMode, string> = {
  NONE: 'No deduction',
  PER_MINUTE: 'A rate for every minute',
  PER_OCCURRENCE: 'A flat amount each time',
};

export const PAYROLL_COMPONENT_KINDS = ['EARNING', 'DEDUCTION'] as const;
export type PayrollComponentKind = (typeof PAYROLL_COMPONENT_KINDS)[number];

export const PAYROLL_COMPONENT_CALCS = [
  'FIXED',
  'PERCENT_OF_BASIC',
  'PERCENT_OF_GROSS',
] as const;
export type PayrollComponentCalc = (typeof PAYROLL_COMPONENT_CALCS)[number];

export const PAYROLL_COMPONENT_CALC_LABELS: Record<PayrollComponentCalc, string> = {
  FIXED: 'A fixed amount',
  PERCENT_OF_BASIC: 'A percentage of basic pay',
  PERCENT_OF_GROSS: 'A percentage of gross pay',
};

export const PAYROLL_COMPONENT_FREQUENCIES = ['RECURRING', 'ONE_TIME'] as const;
export type PayrollComponentFrequency = (typeof PAYROLL_COMPONENT_FREQUENCIES)[number];

export const PAYROLL_RUN_STATUSES = [
  'DRAFT',
  'CALCULATING',
  'REVIEW',
  'APPROVED',
  'FINALIZED',
  'CANCELLED',
] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const PAYROLL_RUN_STATUS_LABELS: Record<PayrollRunStatus, string> = {
  DRAFT: 'Draft',
  CALCULATING: 'Calculating',
  REVIEW: 'In review',
  APPROVED: 'Approved',
  FINALIZED: 'Finalized',
  CANCELLED: 'Cancelled',
};

export const PAYROLL_EXCEPTION_CODES = [
  'MISSING_SALARY',
  'MISSING_PROFILE',
  'OVERLAPPING_SALARY',
  'INVALID_ATTENDANCE',
  'MISSING_SHIFT',
  'UNAPPROVED_OVERTIME',
  'NON_POSITIVE_NET',
  'INCOMPLETE_EMPLOYEE',
] as const;
export type PayrollExceptionCode = (typeof PAYROLL_EXCEPTION_CODES)[number];

export const PAYROLL_EXCEPTION_LABELS: Record<PayrollExceptionCode, string> = {
  MISSING_SALARY: 'No salary on record',
  MISSING_PROFILE: 'No payroll profile',
  OVERLAPPING_SALARY: 'Salary records overlap',
  INVALID_ATTENDANCE: 'Attendance cannot be read',
  MISSING_SHIFT: 'No shift assigned',
  UNAPPROVED_OVERTIME: 'Overtime not approved',
  NON_POSITIVE_NET: 'Net pay is zero or negative',
  INCOMPLETE_EMPLOYEE: 'Employee record incomplete',
};

/** A calendar day, `YYYY-MM-DD`. */
const DAY = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.');

const money = (max = 99_999_999) =>
  z.coerce.number().min(-max, 'That figure is out of range.').max(max, 'That figure is out of range.');

// ------------------------------------------------------------------- settings

export const payrollSettingsSchema = z.object({
  frequency: z.enum(PAYROLL_FREQUENCIES).default('MONTHLY'),
  /**
   * Whether a tax module is in play. Nothing computes tax today; the flag lets
   * components be marked taxable now so a tax module has something to read
   * later. No rate is stored, because a rate wrong for a jurisdiction is worse
   * than no rate at all.
   */
  taxEnabled: z.boolean().default(false),
  basis: z.enum(PAYROLL_BASES).default('FIXED_DAYS'),
  fixedBasisDays: z.coerce
    .number()
    .int()
    .min(1, 'A month cannot be divided by fewer than one day.')
    .max(31, 'A month has at most 31 days.')
    .default(30),
  standardHoursPerDay: z.coerce.number().min(0.5).max(24).default(8),

  overtimeMode: z.enum(PAYROLL_OVERTIME_MODES).default('MULTIPLIER'),
  overtimeMultiplier: z.coerce.number().min(0).max(10).default(1.5),
  overtimeFixedRate: money().default(0),
  requireApprovedOvertime: z.boolean().default(true),

  deductUnpaidAbsence: z.boolean().default(true),
  deductUnpaidLeave: z.boolean().default(true),

  lateDeductionMode: z.enum(PAYROLL_TIME_DEDUCTION_MODES).default('NONE'),
  lateDeductionRate: money().default(0),
  lateGraceMinutes: z.coerce.number().int().min(0).max(600).default(0),

  earlyLeaveDeductionMode: z.enum(PAYROLL_TIME_DEDUCTION_MODES).default('NONE'),
  earlyLeaveDeductionRate: money().default(0),
  earlyLeaveGraceMinutes: z.coerce.number().int().min(0).max(600).default(0),

  roundingDecimals: z.coerce.number().int().min(0).max(4).default(2),
  payslipPrefix: z.string().trim().min(1).max(12).default('PS-'),
});

export type PayrollSettingsInput = z.infer<typeof payrollSettingsSchema>;

export interface PayrollSettingsRecord extends PayrollSettingsInput {
  companyId: string;
  currency: string;
}

// ------------------------------------------------------------------- profiles

/**
 * Every override is nullable, and null means "inherit the company setting".
 * That is the whole reason the profile exists.
 */
export const payrollProfileSchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  isActive: z.boolean().default(true),
  basis: z.enum(PAYROLL_BASES).nullable().optional(),
  fixedBasisDays: z.coerce.number().int().min(1).max(31).nullable().optional(),
  standardHoursPerDay: z.coerce.number().min(0.5).max(24).nullable().optional(),
  overtimeMode: z.enum(PAYROLL_OVERTIME_MODES).nullable().optional(),
  overtimeMultiplier: z.coerce.number().min(0).max(10).nullable().optional(),
  overtimeFixedRate: money().nullable().optional(),
  hourlyRateOverride: money().nullable().optional(),
  deductUnpaidAbsence: z.boolean().nullable().optional(),
  deductUnpaidLeave: z.boolean().nullable().optional(),
  paymentMethod: z.string().trim().max(64).nullable().optional(),
});

export type PayrollProfileInput = z.infer<typeof payrollProfileSchema>;

export interface PayrollProfileRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  isActive: boolean;
  basis: PayrollBasis | null;
  fixedBasisDays: number | null;
  standardHoursPerDay: number | null;
  overtimeMode: PayrollOvertimeMode | null;
  overtimeMultiplier: number | null;
  overtimeFixedRate: number | null;
  hourlyRateOverride: number | null;
  deductUnpaidAbsence: boolean | null;
  deductUnpaidLeave: boolean | null;
  paymentMethod: string | null;
  /** The salary in force today, when one exists. */
  currentSalary: { amount: number; salaryType: PayrollSalaryType; currency: string } | null;
}

// ------------------------------------------------------------------- salaries

export const employeeSalarySchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  salaryType: z.enum(PAYROLL_SALARY_TYPES).default('MONTHLY'),
  amount: money().refine((v) => v >= 0, 'A salary cannot be negative.'),
  currency: z.string().trim().length(3).optional(),
  effectiveFrom: DAY,
  /** Null means "still in force". */
  effectiveTo: DAY.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export type EmployeeSalaryInput = z.infer<typeof employeeSalarySchema>;

export interface EmployeeSalaryRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  salaryType: PayrollSalaryType;
  amount: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  /** True when this is the record in force today. */
  isCurrent: boolean;
  createdAt: string;
}

// ------------------------------------------------------------------ components

export const salaryComponentSchema = z.object({
  name: z.string().trim().min(2, 'Give the component a name.').max(80),
  code: z.string().trim().max(24).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  kind: z.enum(PAYROLL_COMPONENT_KINDS),
  calc: z.enum(PAYROLL_COMPONENT_CALCS).default('FIXED'),
  isTaxable: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export type SalaryComponentInput = z.infer<typeof salaryComponentSchema>;

export interface SalaryComponentRecord extends SalaryComponentInput {
  id: string;
  assignedCount: number;
  createdAt: string;
}

export const employeeComponentSchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  componentId: z.string().trim().min(1).max(64),
  value: money(),
  frequency: z.enum(PAYROLL_COMPONENT_FREQUENCIES).default('RECURRING'),
  effectiveFrom: DAY,
  effectiveTo: DAY.nullable().optional(),
  isActive: z.boolean().default(true),
  note: z.string().trim().max(300).nullable().optional(),
});

export type EmployeeComponentInput = z.infer<typeof employeeComponentSchema>;

export interface EmployeeComponentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  componentId: string;
  componentName: string;
  componentCode: string | null;
  kind: PayrollComponentKind;
  calc: PayrollComponentCalc;
  value: number;
  frequency: PayrollComponentFrequency;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  note: string | null;
}

// --------------------------------------------------------------------- periods

export const payrollPeriodSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the period a name.').max(80),
    startDate: DAY,
    endDate: DAY,
    payDate: DAY.nullable().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The period cannot end before it starts.',
    path: ['endDate'],
  });

export type PayrollPeriodInput = z.infer<typeof payrollPeriodSchema>;

export interface PayrollPeriodRecord {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  status: 'OPEN' | 'CLOSED';
  runCount: number;
  createdAt: string;
}

// ------------------------------------------------------------------------ runs

export const payrollRunSchema = z.object({
  periodId: z.string().trim().min(1, 'Choose a pay period.').max(64),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type PayrollRunInput = z.infer<typeof payrollRunSchema>;

export const payrollCancelSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this run is being cancelled.').max(300),
});

export interface PayrollRunRecord {
  id: string;
  periodId: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  status: PayrollRunStatus;
  currency: string;
  notes: string | null;
  employeeCount: number;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  exceptionCount: number;
  blockingCount: number;
  calculatedAt: string | null;
  approvedAt: string | null;
  finalizedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface PayrollMoneyLine {
  code: string | null;
  label: string;
  kind: string;
  calc: PayrollComponentCalc;
  rate: number | null;
  units: number | null;
  amount: number;
}

export interface PayrollLineRecord {
  id: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;

  salaryType: PayrollSalaryType;
  salaryAmount: number;
  currency: string;
  basis: PayrollBasis;
  basisDays: number;
  dailyRate: number;
  hourlyRate: number;
  salarySegments: number;

  scheduledDays: number;
  scheduledMinutes: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  holidayDays: number;
  weekendDays: number;
  payableDays: number;
  unpaidDays: number;
  workedMinutes: number;
  lateOccurrences: number;
  lateMinutes: number;
  earlyLeaveOccurrences: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;

  basicAmount: number;
  overtimeAmount: number;
  earningsTotal: number;
  deductionsTotal: number;
  adjustmentTotal: number;
  grossAmount: number;
  netAmount: number;

  earnings: PayrollMoneyLine[];
  deductions: PayrollMoneyLine[];
}

export interface PayrollExceptionRecord {
  id: string;
  code: PayrollExceptionCode;
  severity: 'BLOCKING' | 'WARNING';
  message: string;
  employeeId: string | null;
  employeeName: string | null;
  createdAt: string;
}

export interface PayrollCalculationResult {
  runId: string;
  status: PayrollRunStatus;
  employees: number;
  lines: number;
  exceptions: number;
  blocking: number;
  grossTotal: number;
  netTotal: number;
}

// ------------------------------------------------------------------ adjustments

export const payrollAdjustmentSchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  /** The finalized line being corrected, when the correction relates to one. */
  originLineId: z.string().trim().max(64).nullable().optional(),
  kind: z.enum(PAYROLL_COMPONENT_KINDS),
  label: z.string().trim().min(2, 'Give the adjustment a label.').max(80),
  amount: money().refine((v) => v > 0, 'An adjustment must be more than zero.'),
  reason: z.string().trim().min(3, 'Say why this adjustment is being made.').max(500),
});

export type PayrollAdjustmentInput = z.infer<typeof payrollAdjustmentSchema>;

export interface PayrollAdjustmentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  originLineId: string | null;
  appliedRunId: string | null;
  kind: PayrollComponentKind;
  label: string;
  amount: number;
  reason: string;
  appliedAt: string | null;
  createdAt: string;
}

// -------------------------------------------------------------------- payslips

export interface PayslipRecord {
  id: string;
  number: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  runId: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  /** When people are actually paid, from the period. Null when none was set. */
  payDate: string | null;
  currency: string;
  issuedAt: string;
  publishedAt: string | null;
  line: PayrollLineRecord;
}

export const payslipQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  runId: z.string().trim().max(64).optional(),
});

export const payrollLineQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
});


// -------------------------------------------------------------- dashboard

export const payrollDashboardQuerySchema = z.object({
  periodId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  locationId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
});

export interface PayrollDashboard {
  period: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    status: 'OPEN' | 'CLOSED';
  } | null;
  run: { id: string; status: PayrollRunStatus } | null;
  currency: string;
  totalEmployees: number;
  employeesProcessed: number;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  overtimeCost: number;
  overtimeHours: number;
  allowanceTotal: number;
  pendingApprovals: number;
  exceptionCount: number;
  blockingCount: number;
  recentRuns: Array<{
    id: string;
    periodName: string;
    status: PayrollRunStatus;
    netTotal: number;
    employeeCount: number;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------- reports

export const PAYROLL_REPORT_KEYS = [
  'summary',
  'department',
  'employee',
  'overtime',
  'allowance',
  'deduction',
  'attendance',
  'payslip',
] as const;
export type PayrollReportKey = (typeof PAYROLL_REPORT_KEYS)[number];

export const PAYROLL_REPORT_LABELS: Record<PayrollReportKey, string> = {
  summary: 'Payroll summary',
  department: 'Department payroll',
  employee: 'Employee payroll',
  overtime: 'Overtime cost',
  allowance: 'Allowance report',
  deduction: 'Deduction report',
  attendance: 'Attendance vs payroll',
  payslip: 'Payslip report',
};

export const PAYROLL_REPORT_DESCRIPTIONS: Record<PayrollReportKey, string> = {
  summary: 'One row per pay run: what it cost in total.',
  department: 'The same figures grouped by department.',
  employee: 'Every employee line, with basic, allowances and overtime split out.',
  overtime: 'Recorded against approved hours, and what the approved hours cost.',
  allowance: 'Every allowance and bonus paid, itemised.',
  deduction: 'Every deduction taken, itemised, with the units it was charged for.',
  attendance: 'Attendance beside what it cost - why a salary changed.',
  payslip: 'Payslips issued, with their gross, deductions and net.',
};

export const payrollReportQuerySchema = z.object({
  runId: z.string().trim().max(64).optional(),
  periodId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  locationId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
  /** Draft runs are working material; excluded unless asked for. */
  includeDraft: z.enum(['true', 'false']).optional(),
});

export interface PayrollReportColumn {
  key: string;
  label: string;
  align?: 'right';
  money?: boolean;
}

export interface PayrollReportTable {
  key: PayrollReportKey;
  title: string;
  columns: PayrollReportColumn[];
  rows: Array<Record<string, string | number>>;
}

// --------------------------------------------------------- reconciliation

export interface PayrollReconciliation {
  lineId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  attendance: {
    scheduledDays: number;
    presentDays: number;
    halfDays: number;
    paidLeaveDays: number;
    unpaidLeaveDays: number;
    absentDays: number;
    holidayDays: number;
    weekendDays: number;
    overtimeMinutes: number;
    approvedOvertimeMinutes: number;
    lateOccurrences: number;
    lateMinutes: number;
    earlyLeaveOccurrences: number;
    earlyLeaveMinutes: number;
  };
  payroll: {
    salaryType: PayrollSalaryType;
    salaryAmount: number;
    basis: PayrollBasis;
    basisDays: number;
    dailyRate: number;
    hourlyRate: number;
    payableDays: number;
    unpaidDays: number;
    basicAmount: number;
    overtimeAmount: number;
    grossAmount: number;
    deductionsTotal: number;
    netAmount: number;
  };
  earnings: PayrollMoneyLine[];
  deductions: PayrollMoneyLine[];
}
