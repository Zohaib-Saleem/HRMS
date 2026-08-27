import { z } from 'zod';

export const WEEK_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type WeekDay = (typeof WEEK_DAYS)[number];

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2, 'Company name is required.').max(160),
  legalName: z.string().trim().max(200).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  website: z.string().trim().url('Enter a valid URL.').max(200).optional().nullable(),
  addressLine1: z.string().trim().max(200).optional().nullable(),
  addressLine2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postalCode: z.string().trim().max(24).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().length(3, 'Use a 3-letter currency code.').toUpperCase(),
  dateFormat: z.string().trim().min(1).max(32),
  weekStartsOn: z.enum(WEEK_DAYS),
});

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

// ------------------------------------------------- attendance policy (P5)

export const WEEK_DAY_LABELS: Record<WeekDay, string> = {
  MONDAY: 'Monday',
  TUESDAY: 'Tuesday',
  WEDNESDAY: 'Wednesday',
  THURSDAY: 'Thursday',
  FRIDAY: 'Friday',
  SATURDAY: 'Saturday',
  SUNDAY: 'Sunday',
};

/**
 * An IPv4 address or CIDR block, or an IPv6 literal.
 *
 * IPv6 is matched exactly rather than by prefix on the server, so ranges are
 * only accepted for IPv4 - a mask the matcher would not honour has no business
 * being saved.
 */
const NETWORK_ENTRY =
  /^(?:(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?|[0-9a-fA-F:]{2,45})$/;

/**
 * The attendance rules, all configurable.
 *
 * Kept apart from the company profile form on purpose: these values change how
 * time is scored, so they are edited and audited as their own decision rather
 * than saved by accident alongside a new phone number.
 */
export const attendancePolicySchema = z
  .object({
    /**
     * Non-working days. Empty is allowed - a seven-day operation is a real
     * configuration - but every day being a weekend is not.
     */
    weekendDays: z
      .array(z.enum(WEEK_DAYS))
      .max(6, 'At least one day of the week has to be a working day.'),

    graceMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'Grace cannot be negative.')
      .max(480, 'A grace period longer than eight hours is not a grace period.'),
    halfDayMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),
    fullDayMinutes: z.coerce.number().int('Use whole minutes.').min(1, 'A full day needs at least a minute.').max(1440),
    earlyLeaveGraceMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(480),

    overtimeEnabled: z.boolean(),
    overtimeAfterMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),
    overtimeDailyCapMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),

    locationRestrictionEnabled: z.boolean(),
    defaultGeofenceRadiusM: z.coerce
      .number()
      .int('Use whole metres.')
      .min(10, 'A radius under 10m will reject almost every genuine check-in.')
      .max(100_000),

    /**
     * Optional, unlike the fields above, and deliberately so.
     *
     * These arrived after the endpoint did. Requiring them would break every
     * client still sending the older payload, and - worse - a client that
     * omitted them would silently switch a security control off. Omitted means
     * "leave as it is"; the server merges them over the stored values and
     * checks the invariant there, where it can see what is already configured.
     */
    ipRestrictionEnabled: z.boolean().optional(),
    /**
     * Networks permitted to check in. Validated here so a typo cannot become a
     * rule that silently matches nothing, or - worse - one that looks like it
     * matches something.
     */
    allowedCheckInCidrs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(NETWORK_ENTRY, 'Use an address like 10.0.0.5 or a range like 10.0.0.0/24.'),
      )
      .max(50, 'Fifty networks is already more than anyone can audit.')
      .optional(),
  })
  .refine((v) => v.halfDayMinutes <= v.fullDayMinutes, {
    message: 'The half-day threshold cannot be above the full-day threshold.',
    path: ['halfDayMinutes'],
  });

export type AttendancePolicyInput = z.infer<typeof attendancePolicySchema>;

// ------------------------------------------- scoped attendance policies (P6)

export const ATTENDANCE_POLICY_SCOPES = ['COMPANY', 'DEPARTMENT', 'TEAM', 'EMPLOYEE'] as const;
export type AttendancePolicyScope = (typeof ATTENDANCE_POLICY_SCOPES)[number];

export const ATTENDANCE_POLICY_SCOPE_LABELS: Record<AttendancePolicyScope, string> = {
  COMPANY: 'Whole company',
  DEPARTMENT: 'Department',
  TEAM: 'Team',
  EMPLOYEE: 'Individual',
};

/**
 * A named override of the company attendance baseline.
 *
 * The thresholds mirror the baseline exactly. Weekend days and the check-in
 * restrictions are absent on purpose: those describe the company, not a group
 * of people, so allowing a team to redefine the weekend would produce two
 * calendars that disagree.
 */
export const attendancePolicyInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the policy a name.').max(120),
    description: z.string().trim().max(500).optional().nullable(),

    graceMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(480),
    halfDayMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),
    fullDayMinutes: z.coerce.number().int('Use whole minutes.').min(1).max(1440),
    earlyLeaveGraceMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(480),

    overtimeEnabled: z.boolean().default(true),
    overtimeAfterMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),
    overtimeDailyCapMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440),

    isActive: z.boolean().default(true),
  })
  .refine((v) => v.halfDayMinutes <= v.fullDayMinutes, {
    message: 'The half-day threshold cannot be above the full-day threshold.',
    path: ['halfDayMinutes'],
  });

export type AttendancePolicyInputPayload = z.infer<typeof attendancePolicyInputSchema>;

const policyIsoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

/** Where and from when a policy applies. */
export const attendancePolicyAssignmentSchema = z
  .object({
    policyId: z.string().trim().min(1, 'Choose a policy.'),
    scope: z.enum(ATTENDANCE_POLICY_SCOPES),
    /** Required for every scope except COMPANY. */
    targetId: z.string().trim().max(64).optional().nullable(),
    effectiveFrom: policyIsoDate,
    effectiveTo: z.string().trim().optional().nullable(),
  })
  .refine((v) => v.scope === 'COMPANY' || Boolean(v.targetId), {
    message: 'Choose who this applies to.',
    path: ['targetId'],
  })
  .refine(
    (v) => !v.effectiveTo || Date.parse(v.effectiveTo) >= Date.parse(v.effectiveFrom),
    { message: 'The end date cannot be before the start date.', path: ['effectiveTo'] },
  );

export type AttendancePolicyAssignmentInput = z.infer<typeof attendancePolicyAssignmentSchema>;

export interface AttendancePolicyRecord extends AttendancePolicyInputPayload {
  id: string;
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttendancePolicyAssignmentRecord {
  id: string;
  policyId: string;
  policyName: string;
  scope: AttendancePolicyScope;
  targetId: string | null;
  /** Resolved for display: department, team or employee name. */
  targetName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** What actually applied to one person on one day, and why. */
export interface EffectivePolicyView {
  employeeId: string;
  date: string;
  policyId: string | null;
  policyName: string | null;
  scope: AttendancePolicyScope | null;
  graceMinutes: number;
  halfDayMinutes: number;
  fullDayMinutes: number;
  earlyLeaveGraceMinutes: number;
  overtimeEnabled: boolean;
  overtimeAfterMinutes: number;
  overtimeDailyCapMinutes: number;
}

/** Which employee, and as at which date. */
export const effectivePolicyQuerySchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  on: z.string().trim().optional(),
});
