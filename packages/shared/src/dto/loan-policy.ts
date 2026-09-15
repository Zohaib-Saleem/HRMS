import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * The company-wide loan policy: the rules an application is measured against.
 *
 * Everything here is configuration. No threshold in this file appears as a
 * literal anywhere in the eligibility engine - the engine reads a policy row
 * and compares, and a company that wants two months' salary changes a number
 * on a settings screen rather than waiting for a deployment.
 *
 * Policies are VERSIONED rather than edited. Each save writes a new row with
 * its own `effectiveFrom`, and the row in force at an instant is the newest one
 * whose `effectiveFrom` is at or before it. Two things follow, and both are the
 * point:
 *
 *   - A loan is always explicable. The policy that governed an application is
 *     the version in force when it was submitted, and that version still
 *     exists, unedited, however many times the rules have moved since.
 *   - History needs no second table. The change log IS the sequence of
 *     versions, and a field-level diff between neighbours is derived on read,
 *     so it cannot drift from the values it describes.
 */

// --- evaluation period -------------------------------------------------------

/**
 * How far back the attendance rules look, in completed calendar months.
 *
 * Completed, always: today is a partial day and this month is a partial month,
 * and an employee should not be refused a loan on the strength of a morning
 * that has not finished. A 3 means the three whole months before this one.
 */
export const LOAN_EVALUATION_MONTHS = [1, 2, 3, 6, 12] as const;
export type LoanEvaluationMonths = (typeof LOAN_EVALUATION_MONTHS)[number];

export const LOAN_EVALUATION_MONTHS_LABELS: Record<LoanEvaluationMonths, string> = {
  1: 'Previous 1 completed month',
  2: 'Previous 2 completed months',
  3: 'Previous 3 completed months',
  6: 'Previous 6 completed months',
  12: 'Previous 12 completed months',
};

// --- the policy itself -------------------------------------------------------

/**
 * The defaults a company starts with, and the values the first policy row is
 * created from.
 *
 * Held here rather than as Prisma column defaults so the API, the settings
 * screen and the tests all read one list. The database carries the same
 * defaults so a row inserted by hand is still a valid policy.
 */
export const LOAN_POLICY_DEFAULTS = {
  maxSalaryMultiplier: 1,
  minEmploymentMonths: 3,
  /**
   * Eligible employment statuses, one switch per value of EMPLOYMENT_STATUSES.
   *
   * These defaults reproduce the rule that was already in force: probation was
   * refused unless a company said otherwise, and everybody else was allowed.
   * `allowInternee` starts false because an internship is the case a company
   * most often means to exclude - but it is a setting, not a law, and turning it
   * on is a checkbox on Settings -> Loans -> Loan Policy.
   */
  allowProbation: false,
  allowPermanent: true,
  allowInternee: false,
  minAttendancePercent: 90,
  maxUnapprovedAbsences: 3,
  maxLateDays: 10,
  maxMissingPunches: 3,
  evaluationMonths: 3 as LoanEvaluationMonths,
  maxMonthlyDeductionPercent: 30,
  oneActiveLoan: true,
  onePendingLoan: true,
  blockTerminated: true,
  blockResigned: true,
  minSalary: 0,
  maxTenureMonths: 12,
  maxInstallments: 12,
  allowHrOverride: true,
  requireOverrideReason: true,
} as const;

/**
 * The editable policy.
 *
 * Bounds are sanity rails, not policy: they stop a typo becoming a rule (a
 * 900% attendance minimum, a 5,000-month tenure) and otherwise stay out of the
 * way. Where a real company might plausibly want the value, it is allowed.
 */
export const loanPolicySchema = z.object({
  /**
   * The ceiling, as a multiple of monthly salary. Never stored against an
   * employee - it is recomputed from the salary in force and the policy in
   * force every time somebody asks.
   */
  maxSalaryMultiplier: z.coerce
    .number()
    .positive('The multiple has to be greater than zero.')
    .max(24, 'Two years of salary is the most this can be set to.'),
  minEmploymentMonths: z.coerce
    .number()
    .int('Enter a whole number of months.')
    .min(0)
    .max(240),
  allowProbation: z.boolean(),
  allowPermanent: z.boolean(),
  allowInternee: z.boolean(),
  minAttendancePercent: z.coerce.number().min(0).max(100),
  maxUnapprovedAbsences: z.coerce.number().int().min(0).max(365),
  maxLateDays: z.coerce.number().int().min(0).max(365),
  maxMissingPunches: z.coerce.number().int().min(0).max(365),
  evaluationMonths: z.coerce
    .number()
    .int()
    .refine(
      (v): v is LoanEvaluationMonths => (LOAN_EVALUATION_MONTHS as readonly number[]).includes(v),
      'Choose one of the offered evaluation periods.',
    ),
  maxMonthlyDeductionPercent: z.coerce
    .number()
    .positive('A deduction ceiling of zero would block every loan.')
    .max(100),
  oneActiveLoan: z.boolean(),
  onePendingLoan: z.boolean(),
  blockTerminated: z.boolean(),
  blockResigned: z.boolean(),
  minSalary: z.coerce.number().min(0).max(1_000_000_000),
  maxTenureMonths: z.coerce.number().int().min(1).max(240),
  maxInstallments: z.coerce.number().int().min(1).max(240),
  allowHrOverride: z.boolean(),
  requireOverrideReason: z.boolean(),
  /**
   * When the new version takes effect. Defaults to the moment it is saved.
   * A future date lets a company announce a change before it bites; the
   * version in force is still whichever one has already started.
   */
  effectiveFrom: z.string().trim().min(1).optional(),
});

export type LoanPolicyInput = z.infer<typeof loanPolicySchema>;

/** One stored version, as the API reports it. */
export interface LoanPolicyRecord extends Omit<LoanPolicyInput, 'effectiveFrom'> {
  id: string;
  effectiveFrom: string;
  createdAt: string;
  /** Null for the seeded default, which nobody authored. */
  createdByName: string | null;
  /** True for the version currently in force. */
  isCurrent: boolean;
}

/** What the policy screen needs: the live policy plus whether you may edit it. */
export interface LoanPolicyView {
  policy: LoanPolicyRecord;
  canManage: boolean;
  currency: string;
  /** Present only when a version has been saved with a future effective date. */
  scheduled: LoanPolicyRecord | null;
}

// --- history -----------------------------------------------------------------

/** One field that moved between two consecutive versions. */
export interface LoanPolicyFieldChange {
  field: keyof LoanPolicyInput;
  label: string;
  from: string;
  to: string;
}

/**
 * One entry in the change history: a version, and how it differs from the one
 * it replaced. The first version has no predecessor and so no changes.
 */
export interface LoanPolicyHistoryEntry {
  id: string;
  effectiveFrom: string;
  changedAt: string;
  changedByName: string | null;
  changes: LoanPolicyFieldChange[];
}

export const loanPolicyHistoryQuerySchema = paginationQuerySchema;

/** Field labels, shared by the settings form, the confirmation and the history. */
export const LOAN_POLICY_LABELS: Record<keyof LoanPolicyInput, string> = {
  maxSalaryMultiplier: 'Maximum loan multiple',
  minEmploymentMonths: 'Minimum employment period',
  allowProbation: 'Probation',
  allowPermanent: 'Permanent',
  allowInternee: 'Internee',
  minAttendancePercent: 'Minimum attendance',
  maxUnapprovedAbsences: 'Maximum unapproved absences',
  maxLateDays: 'Maximum late days',
  maxMissingPunches: 'Maximum missing punches',
  evaluationMonths: 'Attendance evaluation period',
  maxMonthlyDeductionPercent: 'Maximum monthly deduction',
  oneActiveLoan: 'One active loan at a time',
  onePendingLoan: 'One pending application at a time',
  blockTerminated: 'Block terminated employees',
  blockResigned: 'Block resigned employees',
  minSalary: 'Minimum salary',
  maxTenureMonths: 'Maximum tenure',
  maxInstallments: 'Maximum installments',
  allowHrOverride: 'Allow HR override',
  requireOverrideReason: 'Require an override reason',
  effectiveFrom: 'Effective from',
};

// --- eligibility -------------------------------------------------------------

/**
 * Which rule an application failed.
 *
 * A machine-readable key beside every human sentence, so the UI can highlight
 * the field a failure belongs to without parsing English, and so a test can
 * assert the rule rather than its wording.
 */
export const LOAN_ELIGIBILITY_RULES = [
  'EMPLOYEE_RECORD',
  'EMPLOYMENT_STATUS',
  'MIN_EMPLOYMENT',
  'PROBATION',
  'SALARY_RECORD',
  'MIN_SALARY',
  'MAX_AMOUNT',
  'ATTENDANCE_PERCENT',
  'UNAPPROVED_ABSENCES',
  'LATE_DAYS',
  'MISSING_PUNCHES',
  'ACTIVE_LOAN',
  'PENDING_LOAN',
  'MAX_TENURE',
  'MAX_INSTALLMENTS',
  'MONTHLY_DEDUCTION',
] as const;

export type LoanEligibilityRule = (typeof LOAN_ELIGIBILITY_RULES)[number];

export interface LoanEligibilityFailure {
  rule: LoanEligibilityRule;
  /**
   * What the employee is told. Written for the person who has to fix it, and
   * carrying only figures about themselves that they may already see on their
   * own dashboard - never another employee's, and never an internal id.
   */
  message: string;
}

/**
 * The server's answer, and the only answer that counts.
 *
 * The same shape backs the employee's dialog and the HR override panel. It is
 * advisory to the browser and authoritative on the server: `POST /loans/apply`
 * runs this again and refuses on its own result, so a forged response changes
 * nothing.
 */
export interface LoanEligibilityResult {
  eligible: boolean;
  /** The most this employee could borrow right now, under the live policy. */
  maxAllowedAmount: number;
  /** The largest installment the deduction ceiling permits. */
  maxMonthlyDeduction: number;
  /** Monthly salary the two figures above were computed from. Null when none. */
  monthlySalary: number | null;
  currency: string;
  maxTenureMonths: number;
  maxInstallments: number;
  /** Set only when an amount and a tenure were supplied. */
  estimatedMonthlyDeduction: number | null;
  reasons: string[];
  failedRules: LoanEligibilityRule[];
  failures: LoanEligibilityFailure[];
  /** Things worth saying that do not block anything. */
  warnings: string[];
  /** The attendance window the attendance rules were measured over. */
  evaluation: {
    months: number;
    from: string | null;
    to: string | null;
    /**
     * Attendance over the days the employee was EXPECTED to attend - present,
     * half days and absences.
     *
     * Approved leave is excluded from the denominator, so taking leave that was
     * granted cannot cost somebody a loan. This makes it deliberately different
     * from the percentage on the attendance screens, which answers "how much of
     * the period was worked" and counts leave against it. Both are computed from
     * the same derived days; they are two questions, not two engines.
     */
    attendancePercentage: number | null;
    unapprovedAbsences: number;
    lateDays: number;
    missingPunches: number;
    /** False when the window holds no scored day, so nothing was measurable. */
    measured: boolean;
  };
  /** Whether the policy would let an authorised user override a refusal. */
  overrideAllowed: boolean;
}

/**
 * Asking whether a loan would be allowed.
 *
 * Every field is optional: with none of them this answers "what could I borrow
 * at all", which is what the Apply button needs before a form has been filled
 * in. With them it answers "would THIS application pass".
 */
export const loanEligibilityQuerySchema = z.object({
  /**
   * Whose eligibility. Omitted means the caller's own, which is the only value
   * an employee can use - the server refuses anything else without the
   * permission and data scope to read that employee.
   */
  employeeId: z.string().trim().max(64).optional(),
  principalAmount: z.coerce.number().positive().max(1_000_000_000).optional(),
  installmentCount: z.coerce.number().int().min(1).max(240).optional(),
});

export type LoanEligibilityQuery = z.infer<typeof loanEligibilityQuerySchema>;

/**
 * An authorised user's decision to allow an application the rules refused.
 *
 * The reason is mandatory when the policy says so, and the policy says so by
 * default: an override with no reason is an unexplained exception to a
 * financial control, and six months later nobody can say why it was made.
 */
export const loanOverrideSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});
