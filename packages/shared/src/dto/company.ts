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
  })
  .refine((v) => v.halfDayMinutes <= v.fullDayMinutes, {
    message: 'The half-day threshold cannot be above the full-day threshold.',
    path: ['halfDayMinutes'],
  });

export type AttendancePolicyInput = z.infer<typeof attendancePolicySchema>;
