import { z } from 'zod';
import { paginationQuerySchema } from './common.js';
import { EMPLOYMENT_STATUSES } from './employee.js';

/**
 * Employee loans and salary advances.
 *
 * The rule the whole module exists to make safe: only an ACTIVE loan is ever
 * deducted from pay. An application nobody has approved costs the employee
 * nothing, and a loan that has been approved but not released costs them
 * nothing either - the schedule exists, but payroll only reads installments
 * belonging to a loan somebody has actually activated.
 *
 * The outstanding balance is never stored. It is the schedule read one way and
 * the payment history read the other, so the two cannot drift apart.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

/** A month, as yyyy-MM or yyyy-MM-dd. Stored pinned to the first of the month. */
const monthInput = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}(-\d{2})?$/.test(v), 'Choose a month.');

export const LOAN_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

/**
 * What each stored status is called on a screen.
 *
 * The stored statuses are the lifecycle the code reasons about and they do not
 * change. The words do: ACTIVE means "released and being recovered", which a
 * reader calls Disbursed, and COMPLETED means nothing is owed. A loan that is
 * ACTIVE and has started being repaid reads "Repayment in progress" - that
 * finer label needs the installments, so it comes from `loanStatusLabel`.
 * This map is for places that only have the status, such as a filter.
 */
export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  ACTIVE: 'Disbursed / repaying',
  COMPLETED: 'Fully repaid',
  CANCELLED: 'Cancelled',
};

/**
 * The label for one loan or advance, from its status and how far it has got.
 *
 * Approved-but-not-released is always "Approved" - never "Active" and never
 * "Resolved". Released and nothing recovered yet is "Disbursed"; released with
 * something already recovered is "Repayment in progress". An advance is
 * recovered from one payslip, so it is Disbursed until it is Fully repaid.
 */
export function loanStatusLabel(loan: {
  status: LoanStatus;
  kind?: LoanKind;
  paidInstallments?: number;
}): string {
  if (loan.status !== 'ACTIVE') return LOAN_STATUS_LABELS[loan.status];
  if (loan.kind === 'SALARY_ADVANCE') return 'Disbursed';
  return (loan.paidInstallments ?? 0) > 0 ? 'Repayment in progress' : 'Disbursed';
}

export const LOAN_STATUS_DESCRIPTIONS: Record<LoanStatus, string> = {
  PENDING: 'Applied for and awaiting a decision. Nothing is deducted.',
  APPROVED: 'Agreed but not released yet. Nothing is deducted until it is activated.',
  REJECTED: 'Declined. Nothing is deducted.',
  ACTIVE: 'Released to the employee. Payroll deducts the installment due in each period.',
  COMPLETED: 'Fully repaid. Nothing more is deducted.',
  CANCELLED: 'Withdrawn or written off. No further deductions.',
};

/**
 * What was lent.
 *
 * A salary advance is pay handed over early. Three things set it apart from a
 * loan and nothing else does: the whole amount comes back from ONE payslip, the
 * ceiling is a share of one month's salary rather than a multiple of it, and a
 * payslip names the recovery separately from a loan repayment. Approval,
 * release and collection are the loan machinery, unchanged.
 */
export const LOAN_KINDS = ['LOAN', 'SALARY_ADVANCE'] as const;

export type LoanKind = (typeof LOAN_KINDS)[number];

export const LOAN_KIND_LABELS: Record<LoanKind, string> = {
  LOAN: 'Loan',
  SALARY_ADVANCE: 'Salary advance',
};

/** An advance is always recovered in a single installment. */
export const SALARY_ADVANCE_INSTALLMENTS = 1;

/** The payslip line code for each kind, so payroll and reports agree on it. */
export const LOAN_KIND_PAYROLL_CODES: Record<LoanKind, 'LOAN' | 'ADVANCE'> = {
  LOAN: 'LOAN',
  SALARY_ADVANCE: 'ADVANCE',
};

/** Shared by both write schemas: an advance with a schedule is not an advance. */
function singleRecovery(
  value: { kind: LoanKind; installmentCount: number },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'SALARY_ADVANCE' && value.installmentCount !== SALARY_ADVANCE_INSTALLMENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['installmentCount'],
      message: 'A salary advance is recovered in full from a single month.',
    });
  }
}

/** The only status payroll ever deducts against. */
export const LOAN_DEDUCTIBLE_STATUS: LoanStatus = 'ACTIVE';

export const LOAN_INSTALLMENT_STATUSES = [
  'SCHEDULED',
  'PENDING_PAYROLL',
  'PAID',
  'WAIVED',
  'SKIPPED',
] as const;

export type LoanInstallmentStatus = (typeof LOAN_INSTALLMENT_STATUSES)[number];

export const LOAN_INSTALLMENT_STATUS_LABELS: Record<LoanInstallmentStatus, string> = {
  SCHEDULED: 'Scheduled',
  PENDING_PAYROLL: 'In an unfinalized run',
  PAID: 'Paid',
  WAIVED: 'Waived',
  SKIPPED: 'Not collected',
};

/**
 * What an installment is, as somebody reading the schedule would say it.
 *
 * Kept apart from what can be DONE to it: the Actions column used to show
 * "Waive" on every scheduled row, which read as a status. Status is this;
 * actions are `LoanInstallmentRecord.actions`, decided by the server.
 */
export const LOAN_INSTALLMENT_DISPLAY_STATUSES = [
  'NOT_STARTED',
  'UPCOMING',
  'DUE',
  'OVERDUE',
  'IN_PAYROLL',
  'PAID',
  'WAIVED',
  'NOT_COLLECTED',
] as const;

export type LoanInstallmentDisplayStatus = (typeof LOAN_INSTALLMENT_DISPLAY_STATUSES)[number];

export const LOAN_INSTALLMENT_DISPLAY_LABELS: Record<LoanInstallmentDisplayStatus, string> = {
  NOT_STARTED: 'Not released yet',
  UPCOMING: 'Upcoming',
  DUE: 'Due',
  OVERDUE: 'Overdue',
  IN_PAYROLL: 'In payroll (not finalized)',
  PAID: 'Paid',
  WAIVED: 'Waived',
  NOT_COLLECTED: 'Not collected',
};

/**
 * One installment's display status.
 *
 * `currentMonth` is the payroll month today falls in (yyyy-MM). A scheduled
 * installment for this month is Due; for an earlier month it is Overdue - the
 * next run will collect it - and for a later one, Upcoming. Nothing is
 * scheduled-and-owed on a loan that has not been released.
 */
export function installmentDisplayStatus(
  row: { status: LoanInstallmentStatus; dueMonth: string },
  loanStatus: LoanStatus,
  currentMonth: string,
): LoanInstallmentDisplayStatus {
  switch (row.status) {
    case 'PAID':
      return 'PAID';
    case 'WAIVED':
      return 'WAIVED';
    case 'SKIPPED':
      return 'NOT_COLLECTED';
    case 'PENDING_PAYROLL':
      return 'IN_PAYROLL';
    default: {
      if (loanStatus === 'PENDING' || loanStatus === 'APPROVED') return 'NOT_STARTED';
      if (loanStatus !== 'ACTIVE') return 'NOT_COLLECTED';
      const month = row.dueMonth.slice(0, 7);
      const now = currentMonth.slice(0, 7);
      if (month < now) return 'OVERDUE';
      if (month === now) return 'DUE';
      return 'UPCOMING';
    }
  }
}

// ------------------------------------------------------------------ ledger

export const LOAN_TRANSACTION_TYPES = [
  'PAYROLL_DEDUCTION',
  'MANUAL_PAYMENT',
  'PAYMENT_REVERSAL',
  'WAIVER',
  'SCHEDULE_CORRECTION',
] as const;

export type LoanTransactionType = (typeof LOAN_TRANSACTION_TYPES)[number];

export const LOAN_TRANSACTION_LABELS: Record<LoanTransactionType, string> = {
  PAYROLL_DEDUCTION: 'Deducted by payroll',
  MANUAL_PAYMENT: 'Payment recorded outside payroll',
  PAYMENT_REVERSAL: 'Payment reversed',
  WAIVER: 'Waived',
  SCHEDULE_CORRECTION: 'Schedule corrected',
};

/** What may be done to one installment, decided by the server per caller. */
export const LOAN_INSTALLMENT_ACTIONS = ['RECORD_PAYMENT', 'REVERSE_PAYMENT', 'WAIVE'] as const;

export type LoanInstallmentAction = (typeof LOAN_INSTALLMENT_ACTIONS)[number];

/** Installment statuses that count towards what has been repaid. */
export const LOAN_SETTLED_STATUSES: readonly LoanInstallmentStatus[] = ['PAID', 'WAIVED'];

/**
 * The repayment schedule for a loan.
 *
 * Every installment is the same figure except the last, which carries the
 * rounding remainder so the sum is exactly the principal. Doing it the other
 * way - rounding each installment and letting the total land where it may -
 * is how a loan ends up a few cents short and never closes.
 *
 * Pure and exported so the API, the admin form and the employee's own view all
 * show the same numbers before anything is written.
 */
export function buildSchedule(input: {
  principal: number;
  installments: number;
  startMonth: string;
  decimals?: number;
}): Array<{ sequence: number; dueMonth: string; amount: number }> {
  const decimals = input.decimals ?? 2;
  const factor = 10 ** decimals;
  const count = Math.max(1, Math.trunc(input.installments));

  const totalUnits = Math.round(input.principal * factor);
  const perUnits = Math.floor(totalUnits / count);

  const rows: Array<{ sequence: number; dueMonth: string; amount: number }> = [];
  let assigned = 0;

  for (let i = 0; i < count; i += 1) {
    // The last row takes whatever is left, so the schedule always sums to the
    // principal exactly rather than to the principal give or take a cent.
    const units = i === count - 1 ? totalUnits - assigned : perUnits;
    assigned += units;
    rows.push({
      sequence: i + 1,
      dueMonth: addMonths(input.startMonth, i),
      amount: units / factor,
    });
  }

  return rows;
}

/** yyyy-MM-01 `count` months after the given month. */
export function addMonths(month: string, count: number): string {
  const [yearPart, monthPart] = month.slice(0, 7).split('-');
  const year = Number(yearPart);
  const index = Number(monthPart) - 1 + count;
  const targetYear = year + Math.floor(index / 12);
  const targetMonth = ((index % 12) + 12) % 12;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-01`;
}

/** The even installment a schedule would use, for showing before it is saved. */
export function monthlyDeductionFor(principal: number, installments: number): number {
  const rows = buildSchedule({ principal, installments, startMonth: '2000-01' });
  return rows[0]?.amount ?? 0;
}

// ------------------------------------------------------------------- payloads

/** Admin creating a loan outright. It starts ACTIVE unless told otherwise. */
export const loanCreateSchema = z
  .object({
    kind: z.enum(LOAN_KINDS).default('LOAN'),
    employeeId: z.string().trim().min(1, 'Choose an employee.'),
    principalAmount: z.coerce.number().positive('Enter the loan amount.').max(1_000_000_000),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    installmentCount: z.coerce
      .number()
      .int('Enter a whole number of installments.')
      .min(1, 'A loan needs at least one installment.')
      .max(240),
    startMonth: monthInput,
    reference: optionalText(64),
    purpose: optionalText(500),
    notes: optionalText(2000),
    /**
     * Whether repayment starts immediately. False files the loan as APPROVED,
     * so the schedule exists and payroll ignores it until somebody releases it.
     */
    activate: z.boolean().default(true),
    /**
     * An authorised user's decision to grant a loan the eligibility rules
     * refuse.
     *
     * Its ABSENCE is meaningful, which is why it is optional rather than
     * nullable-with-a-default: omit it and there is no override, so an
     * ineligible employee is refused exactly as they would be on their own
     * application. Send it - even empty - and an override is being attempted,
     * which the policy may forbid outright or require a reason for.
     */
    overrideReason: z.string().trim().max(1000).optional(),
    /**
     * For a loan entered after the fact: how many of its first installments
     * were already repaid outside HRMS. Each is settled on the ledger as a
     * manual payment, with the reason below, so the next payroll does not
     * collect months that were paid long ago.
     */
    alreadyRepaidInstallments: z.coerce.number().int().min(0).max(240).default(0),
    alreadyRepaidReason: optionalText(1000),
  })
  .superRefine(singleRecovery)
  .superRefine((value, ctx) => {
    if (value.alreadyRepaidInstallments > value.installmentCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alreadyRepaidInstallments'],
        message: 'More installments repaid than the loan has.',
      });
    }
    if (value.alreadyRepaidInstallments > 0 && !value.alreadyRepaidReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alreadyRepaidReason'],
        message: 'Say how the earlier installments were repaid.',
      });
    }
  });

export type LoanCreateInput = z.infer<typeof loanCreateSchema>;

/** An employee applying for one. No employee id: it is always for themselves. */
export const loanApplicationSchema = z
  .object({
    kind: z.enum(LOAN_KINDS).default('LOAN'),
    principalAmount: z.coerce.number().positive('Enter the amount you need.').max(1_000_000_000),
    installmentCount: z.coerce
      .number()
      .int('Enter a whole number of installments.')
      .min(1, 'Choose how many months to repay over.')
      .max(240),
    /**
     * Omitted, the server picks the deduction month by the company rule (see
     * `GET /loans/deduction-month`). Sent, it is checked against that rule:
     * never a month before the current payroll month, never a closed one.
     */
    startMonth: monthInput.optional(),
    purpose: z.string().trim().min(3, 'Say what the loan is for.').max(500),
    notes: optionalText(2000),
  })
  .superRefine(singleRecovery);

export type LoanApplicationInput = z.infer<typeof loanApplicationSchema>;

export const loanDecisionSchema = z.object({
  /** Approving and releasing in one step is the ordinary case. */
  activate: z.boolean().default(true),
  /** Overrides the applicant's request when the amount agreed is different. */
  principalAmount: z.coerce.number().positive().max(1_000_000_000).optional(),
  installmentCount: z.coerce.number().int().min(1).max(240).optional(),
  startMonth: monthInput.optional(),
  note: optionalText(1000),
});

export type LoanDecisionInput = z.infer<typeof loanDecisionSchema>;

export const loanRejectSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it was declined.').max(1000),
});

export const loanCancelSchema = z.object({
  reason: optionalText(1000),
});

export const loanQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(LOAN_STATUSES).optional(),
  kind: z.enum(LOAN_KINDS).optional(),
  /**
   * The borrower's employment status - the employee's own field, reached
   * through the relation. Not a copy held on the loan: a loan taken out on
   * probation belongs to whoever that person is TODAY, and a stored copy would
   * still be filtering them as a probationer a year after they were confirmed.
   */
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  /** `mine` limits the list to the caller's own loans. */
  view: z.enum(['all', 'mine']).default('all'),
});

// --------------------------------------------------------------- read shapes

export interface LoanInstallmentRecord {
  id: string;
  sequence: number;
  dueMonth: string;
  amount: number;
  status: LoanInstallmentStatus;
  payrollRunId: string | null;
  paidAt: string | null;
  note: string | null;
  /** The status a reader sees - see `installmentDisplayStatus`. */
  displayStatus: LoanInstallmentDisplayStatus;
  /** How it was settled, when it has been: the ledger entry behind it. */
  settledBy: LoanTransactionType | null;
  /** What this caller may do to it. Empty is common and correct. */
  actions: LoanInstallmentAction[];
}

export interface LoanRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  kind: LoanKind;
  reference: string | null;
  principalAmount: number;
  currency: string;
  installmentCount: number;
  monthlyDeduction: number;
  startMonth: string;
  status: LoanStatus;
  purpose: string | null;
  notes: string | null;

  /** Derived from the schedule, never stored. */
  paidAmount: number;
  remainingAmount: number;
  paidInstallments: number;
  /** The next installment still to be collected, when there is one. */
  nextDueMonth: string | null;

  requestedAt: string | null;
  approvalRequestId: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  activatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;

  /** What the caller may do, decided server-side from permissions and scope. */
  canApprove: boolean;
  canCancel: boolean;
  /** The label for this loan's stage - see `loanStatusLabel`. */
  statusLabel: string;
}

export interface LoanDetail extends LoanRecord {
  installments: LoanInstallmentRecord[];
  /** The ledger, oldest first. */
  transactions: LoanTransactionRecord[];
  /** Whether the caller may correct the schedule and record payments. */
  canCorrect: boolean;
}

// ------------------------------------------------------------ corrections

/** A real calendar date, yyyy-MM-dd. */
const dateInput = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a date.');

const correctionReason = z.string().trim().min(3, 'Give a reason for the correction.').max(1000);

/** An installment repaid outside payroll: cash, transfer, or before HRMS. */
export const loanRecordPaymentSchema = z.object({
  paidOn: dateInput,
  reference: optionalText(120),
  reason: correctionReason,
});
export type LoanRecordPaymentInput = z.infer<typeof loanRecordPaymentSchema>;

/** Takes back a manual payment recorded in error. */
export const loanReversePaymentSchema = z.object({ reason: correctionReason });

/** Forgives one installment. Deliberate, authorised and explained. */
export const loanWaiveSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this installment is being waived.').max(500),
});

/** Moves every installment still scheduled so the first falls in `startMonth`. */
export const loanRescheduleSchema = z.object({
  startMonth: monthInput,
  reason: correctionReason,
});
export type LoanRescheduleInput = z.infer<typeof loanRescheduleSchema>;

/** The deduction month rule, as the server applies it. */
export interface LoanDeductionMonthInfo {
  /** The payroll month today falls in, in the company's timezone. */
  currentMonth: string;
  /** What a request made today is recovered from by default. */
  defaultMonth: string;
  /** Months whose payroll is finalized; nothing new is scheduled into them. */
  closedMonths: string[];
}

export interface LoanTransactionRecord {
  id: string;
  installmentId: string | null;
  installmentSequence: number | null;
  type: LoanTransactionType;
  amount: number;
  effectiveDate: string;
  payrollRunId: string | null;
  reference: string | null;
  reason: string | null;
  reversesId: string | null;
  reversed: boolean;
  detail: unknown;
  createdByName: string | null;
  createdAt: string;
}
