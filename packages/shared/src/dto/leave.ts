import { z } from 'zod';
import { paginationQuerySchema } from './common.js';
import { APPROVAL_STATUSES, type ApprovalStatus } from './approvals.js';

export const LEAVE_DAY_PARTS = ['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF'] as const;
export type LeaveDayPart = (typeof LEAVE_DAY_PARTS)[number];

export const LEAVE_DAY_PART_LABELS: Record<LeaveDayPart, string> = {
  FULL_DAY: 'Full day',
  FIRST_HALF: 'First half',
  SECOND_HALF: 'Second half',
};

const isoDate = z
  .string()
  .trim()
  .refine((v) => v !== '' && !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

// ---------------------------------------------------------------- leave types

export const leaveTypeInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Leave type name is required.').max(120),
    code: optionalText(24),
    description: optionalText(500),
    annualEntitlementDays: z.coerce.number().min(0).max(365),
    monthlyAccrualDays: z.coerce.number().min(0).max(31),
    carryForwardEnabled: z.boolean().default(false),
    carryForwardCapDays: z.coerce.number().min(0).max(365).nullish(),
    isPaid: z.boolean().default(true),
    /**
     * Whether payroll deducts this leave even though it is paid.
     *
     * Off unless a company deliberately turns it on for a type. Approved paid
     * leave is leave the company agreed to pay for, and deducting it by
     * default would make "paid" mean nothing.
     */
    isDeductible: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .refine(
    (v) => v.monthlyAccrualDays * 12 >= 0 && v.monthlyAccrualDays <= v.annualEntitlementDays,
    {
      message: 'Monthly accrual cannot exceed the annual entitlement.',
      path: ['monthlyAccrualDays'],
    },
  )
  .refine(
    (v) => !v.carryForwardEnabled || v.carryForwardCapDays === null || v.carryForwardCapDays === undefined || v.carryForwardCapDays >= 0,
    { message: 'Enter a carry-forward cap, or leave it blank for uncapped.', path: ['carryForwardCapDays'] },
  );

export type LeaveTypeInput = z.infer<typeof leaveTypeInputSchema>;

export const leaveTypeQuerySchema = paginationQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
});

export interface LeaveTypeRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  annualEntitlementDays: number;
  monthlyAccrualDays: number;
  carryForwardEnabled: boolean;
  carryForwardCapDays: number | null;
  isPaid: boolean;
  isDeductible: boolean;
  isActive: boolean;
  requestCount: number;
}

// ------------------------------------------------------------- leave requests

export const leaveRequestCreateSchema = z
  .object({
    leaveTypeId: z.string().trim().min(1, 'Choose a leave type.'),
    startDate: isoDate,
    endDate: isoDate,
    dayPart: z.enum(LEAVE_DAY_PARTS).default('FULL_DAY'),
    reason: z.string().trim().min(3, 'Give a reason for the leave.').max(1000),
    /**
     * Supporting evidence - a medical certificate, a booking confirmation.
     * A link rather than an upload: there is no document store in this system
     * yet, and a link to one the company already uses loses nothing.
     */
    documentUrl: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => (v === '' || v === undefined ? null : v))
      .refine((v) => v === null || /^https?:\/\//i.test(v), {
        message: 'Enter a link starting with http:// or https://.',
      }),
    documentName: optionalText(200),
  })
  .refine((v) => Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: 'The end date cannot be before the start date.',
    path: ['endDate'],
  })
  .refine((v) => v.dayPart === 'FULL_DAY' || v.startDate === v.endDate, {
    message: 'A half day applies to a single date only.',
    path: ['dayPart'],
  });

export type LeaveRequestCreateInput = z.infer<typeof leaveRequestCreateSchema>;

export const leaveRequestQuerySchema = paginationQuerySchema.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
  employeeId: z.string().trim().max(64).optional(),
  leaveTypeId: z.string().trim().max(64).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  /** `mine` limits the list to the caller's own requests. */
  view: z.enum(['all', 'mine']).default('all'),
});

export const leaveCancelSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export interface LeaveRequestRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveTypeId: string;
  leaveTypeName: string;
  isPaid: boolean;
  isDeductible: boolean;
  startDate: string;
  endDate: string;
  dayPart: LeaveDayPart;
  totalDays: number;
  reason: string;
  documentUrl: string | null;
  documentName: string | null;
  status: ApprovalStatus;
  approvalRequestId: string | null;
  decidedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** True when the caller may withdraw it. */
  canCancel: boolean;
}

// ----------------------------------------------------------------- balances

export interface LeaveBalanceRecord {
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string | null;
  isPaid: boolean;
  year: number;
  annualEntitlementDays: number;
  monthlyAccrualDays: number;
  carryForwardEnabled: boolean;
  carryForwardCapDays: number | null;
  openingDays: number;
  accruedDays: number;
  adjustmentDays: number;
  /** Why the adjustment was made. Null when there is none. */
  adjustmentNote: string | null;
  usedDays: number;
  pendingDays: number;
  availableDays: number;
}

/**
 * A manual correction to one employee's balance for one leave type and year.
 *
 * `adjustmentDays` is the whole correction, not an increment: it replaces the
 * stored figure, and the audit trail records what it replaced. The reason is
 * compulsory - a balance nobody can explain is a balance nobody trusts, and
 * the note is shown beside the figure on the employee's profile.
 */
export const balanceAdjustmentSchema = z.object({
  employeeId: z.string().trim().min(1),
  leaveTypeId: z.string().trim().min(1),
  year: z.coerce.number().int().min(2000).max(2100),
  adjustmentDays: z.coerce.number().min(-365).max(365),
  adjustmentNote: z
    .string()
    .trim()
    .min(3, 'Give the reason for this adjustment.')
    .max(500, 'Keep the reason under 500 characters.'),
});
export type BalanceAdjustmentInput = z.infer<typeof balanceAdjustmentSchema>;

// ------------------------------------------------------------------ holidays

export const holidayInputSchema = z.object({
  name: z.string().trim().min(2, 'Holiday name is required.').max(160),
  date: isoDate,
  /** Empty means every location. */
  locationId: optionalText(64),
  isActive: z.boolean().default(true),
});

export type HolidayInput = z.infer<typeof holidayInputSchema>;

export const holidayQuerySchema = paginationQuerySchema.extend({
  locationId: z.string().trim().max(64).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export interface HolidayRecord {
  id: string;
  name: string;
  date: string;
  locationId: string | null;
  locationName: string | null;
  isActive: boolean;
}
