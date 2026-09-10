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

// ------------------------------------------------------- attendance rules

export const MISSING_PUNCH_RULES = ['PRESENT', 'ABSENT', 'THRESHOLD'] as const;
export type MissingPunchRule = (typeof MISSING_PUNCH_RULES)[number];

export const MISSING_PUNCH_RULE_LABELS: Record<MissingPunchRule, string> = {
  PRESENT: 'Counted present',
  ABSENT: 'Counted absent until corrected',
  THRESHOLD: 'Scored on the usual thresholds',
};

export const IRREGULAR_CUTOFF_MODES = ['ABSOLUTE_TIME', 'AFTER_SHIFT_START'] as const;
export type IrregularCutoffMode = (typeof IRREGULAR_CUTOFF_MODES)[number];

export const IRREGULAR_CUTOFF_MODE_LABELS: Record<IrregularCutoffMode, string> = {
  ABSOLUTE_TIME: 'A fixed time of day',
  AFTER_SHIFT_START: 'Minutes after the shift starts',
};

export const NON_WORKING_DAY_WORK_RULES = ['AS_WORKING_DAY', 'ALL_OVERTIME', 'IGNORE'] as const;
export type NonWorkingDayWorkRule = (typeof NON_WORKING_DAY_WORK_RULES)[number];

export const NON_WORKING_DAY_WORK_RULE_LABELS: Record<NonWorkingDayWorkRule, string> = {
  AS_WORKING_DAY: 'Score it like a working day (overtime after the shift end)',
  ALL_OVERTIME: 'Every worked minute is overtime',
  IGNORE: 'Keep the punches, credit nothing',
};

/** 24-hour wall clock, the same shape shifts already store. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const clockTime = (label: string) =>
  z.string().trim().regex(CLOCK, `${label} must be a 24-hour time, e.g. 09:00.`);

/**
 * The rules that decide what a day is worth, as configuration.
 *
 * Separate from `attendancePolicySchema` because these are Super Admin's to
 * change and that one is not - not because they live anywhere else. Both write
 * to the same Company row; there is one settings store, with two permission
 * tiers over it.
 */
export const attendanceRulesSchema = z
  .object({
    defaultShiftStart: clockTime('Default start'),
    defaultShiftEnd: clockTime('Default end'),

    overtimeEnabled: z.boolean(),
    overtimeFromShiftEnd: z.boolean(),
    overtimeCountsEarlyArrival: z.boolean(),
    overtimeReducedByLateArrival: z.boolean(),
    overtimeDailyCapMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The overtime cap cannot be negative.')
      .max(1440, 'A daily cap longer than a day is not a cap.'),

    lateTrackingEnabled: z.boolean(),
    graceMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The grace period cannot be negative.')
      .max(480, 'A grace period longer than eight hours is not a grace period.'),

    earlyDepartureTrackingEnabled: z.boolean(),
    earlyLeaveGraceMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The grace period cannot be negative.')
      .max(480),
    fullDayToleranceMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The tolerance cannot be negative.')
      .max(240, 'A tolerance longer than four hours would retire the half day.'),

    irregularCheckInEnabled: z.boolean(),
    irregularCheckInCutoff: clockTime('The irregular check-in cutoff'),
    irregularCheckInMode: z.enum(IRREGULAR_CUTOFF_MODES),
    irregularAfterShiftStartMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The cutoff cannot be negative.')
      .max(1440),

    breakIncludedInWindow: z.boolean(),
    overtimeMinimumMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The minimum cannot be negative.')
      .max(480),
    overtimeRoundingMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'Rounding cannot be negative.')
      .max(120),
    overtimeWeeklyCapMinutes: z.coerce.number().int().min(0).max(10_080).nullable(),
    overtimeMonthlyCapMinutes: z.coerce.number().int().min(0).max(44_640).nullable(),

    missingCheckOutStatus: z.enum(MISSING_PUNCH_RULES),
    missingCheckInStatus: z.enum(MISSING_PUNCH_RULES),

    /**
     * Punch integrity. Optional for the same reason as the fields below: an
     * older client that does not send them keeps whatever is stored.
     */
    duplicatePunchWindowSeconds: z.coerce
      .number()
      .int('Use whole seconds.')
      .min(0, 'The window cannot be negative.')
      .max(3600, 'A window longer than an hour would swallow real punches.')
      .optional(),
    maxPlausibleSpanMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The bound cannot be negative.')
      .max(1440, 'A day cannot be longer than a day.')
      .optional(),
    allowImplausibleSpans: z.boolean().optional(),

    /**
     * Added with the attendance module. Optional so a client sending the
     * older payload keeps whatever is stored, and the server merges them over
     * the current values before validating the whole.
     */
    defaultBreakMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'A break cannot be negative.')
      .max(480, 'A break longer than eight hours is a day off.')
      .optional(),
    weekendDays: z
      .array(z.enum(WEEK_DAYS))
      .max(6, 'At least one day of the week has to be a working day.')
      .optional(),
    halfDayMinutes: z.coerce.number().int('Use whole minutes.').min(0).max(1440).optional(),
    fullDayMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(1, 'A full day needs at least a minute.')
      .max(1440)
      .optional(),
    lateThresholdMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The threshold cannot be negative.')
      .max(480)
      .optional(),
    earlyLeaveThresholdMinutes: z.coerce
      .number()
      .int('Use whole minutes.')
      .min(0, 'The threshold cannot be negative.')
      .max(480)
      .optional(),
    weekendWorkRule: z.enum(NON_WORKING_DAY_WORK_RULES).optional(),
    holidayWorkRule: z.enum(NON_WORKING_DAY_WORK_RULES).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.halfDayMinutes !== undefined &&
      value.fullDayMinutes !== undefined &&
      value.halfDayMinutes > value.fullDayMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['halfDayMinutes'],
        message: 'The half-day threshold cannot be above the full-day threshold.',
      });
    }

    if (value.defaultShiftStart === value.defaultShiftEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultShiftEnd'],
        message: 'The end time cannot be the same as the start time.',
      });
    }

    // A cutoff at or before the shift start would mark an on-time arrival
    // irregular, which would silently stop overtime for the whole company.
    if (
      value.irregularCheckInEnabled &&
      value.irregularCheckInCutoff <= value.defaultShiftStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['irregularCheckInCutoff'],
        message:
          'The cutoff must be after the shift start, or an on-time arrival would be treated as irregular.',
      });
    }

    if (
      value.overtimeWeeklyCapMinutes !== null &&
      value.overtimeWeeklyCapMinutes < value.overtimeDailyCapMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overtimeWeeklyCapMinutes'],
        message: 'A weekly cap below the daily cap makes the daily cap unreachable.',
      });
    }

    if (
      value.overtimeMonthlyCapMinutes !== null &&
      value.overtimeWeeklyCapMinutes !== null &&
      value.overtimeMonthlyCapMinutes < value.overtimeWeeklyCapMinutes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overtimeMonthlyCapMinutes'],
        message: 'A monthly cap below the weekly cap makes the weekly cap unreachable.',
      });
    }

    // Not contradictory enough to reject, but the combination is always a
    // mistake: an overtime rule that can never produce a figure.
    if (value.overtimeEnabled && value.overtimeDailyCapMinutes === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overtimeDailyCapMinutes'],
        message: 'Overtime is on but capped at zero. Raise the cap, or turn overtime off.',
      });
    }
  });

export type AttendanceRulesInput = z.infer<typeof attendanceRulesSchema>;

/**
 * The rule values, all present. What the screen edits and what the server
 * stores; the input schema above is the same shape with the newer fields
 * optional.
 */
export interface AttendanceRuleValues
  extends Omit<
    AttendanceRulesInput,
    | 'defaultBreakMinutes'
    | 'weekendDays'
    | 'halfDayMinutes'
    | 'fullDayMinutes'
    | 'lateThresholdMinutes'
    | 'earlyLeaveThresholdMinutes'
    | 'weekendWorkRule'
    | 'holidayWorkRule'
  > {
  defaultBreakMinutes: number;
  weekendDays: WeekDay[];
  halfDayMinutes: number;
  fullDayMinutes: number;
  lateThresholdMinutes: number;
  earlyLeaveThresholdMinutes: number;
  weekendWorkRule: NonWorkingDayWorkRule;
  holidayWorkRule: NonWorkingDayWorkRule;
}

/**
 * Pay-side switches the attendance rules screen shows next to the rules they
 * depend on. They live on payroll settings - one store, no copy - and are
 * edited there; here they are read so the two screens cannot disagree.
 */
export interface AttendancePayrollIntegrationView {
  deductUnpaidAbsence: boolean;
  deductUnpaidLeave: boolean;
  lateDeductionEnabled: boolean;
  earlyLeaveDeductionEnabled: boolean;
  overtimePaid: boolean;
  requireApprovedOvertime: boolean;
  overtimeMultiplier: number;
  overtimeCapMinutes: number | null;
}

/** What the rules screen reads back, including the values it cannot change. */
export interface AttendanceRulesView extends AttendanceRuleValues {
  timezone: string;
  /** Only meaningful while overtimeFromShiftEnd is off. */
  overtimeAfterMinutes: number;
  /** The shipped value of every rule, for "reset to default". */
  defaults: AttendanceRuleValues;
  /** Null when payroll has never been configured for the company. */
  payrollIntegration: AttendancePayrollIntegrationView | null;
  /** True when the caller may change these rules. */
  canManage: boolean;
}

/**
 * The shipped defaults.
 *
 * One list, asserted by a test against the Prisma schema, so the number a
 * screen offers as "the default" is the number a new company actually gets.
 * These are the confirmed office policy: 09:00-18:00, a 540-minute window,
 * eight hours for a full day with half an hour of tolerance.
 */
export const ATTENDANCE_RULE_DEFAULTS: AttendanceRuleValues = {
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  defaultBreakMinutes: 0,
  breakIncludedInWindow: true,
  weekendDays: ['SATURDAY', 'SUNDAY'],
  halfDayMinutes: 240,
  fullDayMinutes: 480,
  fullDayToleranceMinutes: 30,
  lateTrackingEnabled: true,
  graceMinutes: 10,
  lateThresholdMinutes: 0,
  irregularCheckInEnabled: true,
  irregularCheckInCutoff: '11:00',
  irregularCheckInMode: 'ABSOLUTE_TIME',
  irregularAfterShiftStartMinutes: 120,
  earlyDepartureTrackingEnabled: true,
  earlyLeaveGraceMinutes: 10,
  earlyLeaveThresholdMinutes: 0,
  missingCheckOutStatus: 'PRESENT',
  missingCheckInStatus: 'ABSENT',
  duplicatePunchWindowSeconds: 60,
  maxPlausibleSpanMinutes: 960,
  allowImplausibleSpans: false,
  overtimeEnabled: true,
  overtimeFromShiftEnd: true,
  overtimeCountsEarlyArrival: false,
  overtimeReducedByLateArrival: false,
  overtimeMinimumMinutes: 0,
  overtimeRoundingMinutes: 0,
  overtimeDailyCapMinutes: 240,
  overtimeWeeklyCapMinutes: null,
  overtimeMonthlyCapMinutes: null,
  weekendWorkRule: 'AS_WORKING_DAY',
  holidayWorkRule: 'AS_WORKING_DAY',
};

export type AttendanceRuleKey = keyof AttendanceRuleValues;

export type AttendanceRuleFieldKind =
  | 'time'
  | 'minutes'
  /** A duration too short to express in minutes, such as a duplicate window. */
  | 'seconds'
  | 'boolean'
  | 'weekdays'
  | { enum: readonly string[]; labels: Record<string, string> };

/** How one rule is presented: what it is called, what it means, how it is edited. */
export interface AttendanceRuleField {
  key: AttendanceRuleKey;
  label: string;
  description: string;
  kind: AttendanceRuleFieldKind;
  /** Null allowed, shown as "no limit". */
  nullable?: boolean;
  /** Rendered only while this other rule is on. */
  dependsOn?: AttendanceRuleKey;
}

/**
 * A pay-side switch shown for context. Read from payroll settings and edited
 * there, so the attendance screen links across rather than saving a copy.
 */
export interface AttendanceLinkedField {
  key: keyof AttendancePayrollIntegrationView;
  label: string;
  description: string;
}

export interface AttendanceRuleSection {
  key: string;
  title: string;
  description: string;
  fields: AttendanceRuleField[];
  /** Pay-side switches that belong with this section but live in payroll. */
  linked?: AttendanceLinkedField[];
}

/**
 * The rules screen, as data.
 *
 * Every rule the engine reads appears in exactly one section here, which a
 * test asserts: a rule that is stored but has no label, description and
 * default is a rule Super Admin cannot see, which is a hidden rule.
 */
export const ATTENDANCE_RULE_SECTIONS: readonly AttendanceRuleSection[] = [
  {
    key: 'schedule',
    title: 'A. Office schedule',
    description:
      'The window an employee is measured against when no shift is assigned. An assigned shift always wins.',
    fields: [
      { key: 'defaultShiftStart', label: 'Office start', description: 'Lateness is measured from here.', kind: 'time' },
      { key: 'defaultShiftEnd', label: 'Office end', description: 'Early departure and overtime are measured from here.', kind: 'time' },
      {
        key: 'fullDayMinutes',
        label: 'Full-day minutes',
        description: 'Minutes of the scheduled window that earn a full present day. The 09:00-18:00 window is 540 minutes; 480 with the tolerance below credits a day that ran 30 minutes short.',
        kind: 'minutes',
      },
      {
        key: 'defaultBreakMinutes',
        label: 'Break duration',
        description: 'The unpaid break assumed for the default schedule. Only deducted when the break sits outside the window.',
        kind: 'minutes',
      },
      {
        key: 'breakIncludedInWindow',
        label: 'Break included in the window',
        description: 'On: the window already accounts for the break and nothing is subtracted. Off: the break comes off worked minutes before the day is scored.',
        kind: 'boolean',
      },
      {
        key: 'weekendDays',
        label: 'Weekend days',
        description: 'Non-working days of the week. Every other day is a working day. Read by attendance and leave alike.',
        kind: 'weekdays',
      },
    ],
  },
  {
    key: 'late',
    title: 'B. Late arrival',
    description: 'What arriving after the start is worth.',
    fields: [
      { key: 'lateTrackingEnabled', label: 'Track late arrival', description: 'Off: no lateness is measured or reported.', kind: 'boolean' },
      {
        key: 'graceMinutes',
        label: 'Grace period',
        description: 'Arrivals this many minutes after the start are not late at all. Past it, the full lateness is recorded.',
        kind: 'minutes',
        dependsOn: 'lateTrackingEnabled',
      },
      {
        key: 'lateThresholdMinutes',
        label: 'Late threshold',
        description: 'Recorded lateness at or above this carries the LATE flag and counts as a late day. Zero flags any lateness past the grace.',
        kind: 'minutes',
        dependsOn: 'lateTrackingEnabled',
      },
      {
        key: 'irregularCheckInEnabled',
        label: 'Flag irregular arrivals',
        description: 'A check-in after the cutoff does not fit the shift: the day is flagged and no overtime is derived from it.',
        kind: 'boolean',
      },
      {
        key: 'irregularCheckInMode',
        label: 'Cutoff measured as',
        description: 'A fixed time of day suits one shared schedule; minutes after the shift start is the only form that works for a night shift.',
        kind: { enum: IRREGULAR_CUTOFF_MODES, labels: IRREGULAR_CUTOFF_MODE_LABELS },
        dependsOn: 'irregularCheckInEnabled',
      },
      {
        key: 'irregularCheckInCutoff',
        label: 'Irregular arrival cutoff',
        description: 'Used when the cutoff is a fixed time of day.',
        kind: 'time',
        dependsOn: 'irregularCheckInEnabled',
      },
      {
        key: 'irregularAfterShiftStartMinutes',
        label: 'Minutes after shift start',
        description: 'Used when the cutoff is measured from the shift start.',
        kind: 'minutes',
        dependsOn: 'irregularCheckInEnabled',
      },
    ],
  },
  {
    key: 'early',
    title: 'C. Early leave',
    description: 'What leaving before the end is worth.',
    fields: [
      { key: 'earlyDepartureTrackingEnabled', label: 'Track early departure', description: 'Off: no early departure is measured or reported.', kind: 'boolean' },
      {
        key: 'earlyLeaveGraceMinutes',
        label: 'Minimum early minutes',
        description: 'Leaving this many minutes before the end is forgiven entirely. Past it, the full early departure is recorded.',
        kind: 'minutes',
        dependsOn: 'earlyDepartureTrackingEnabled',
      },
      {
        key: 'earlyLeaveThresholdMinutes',
        label: 'Early leave threshold',
        description: 'Recorded early departure at or above this carries the EARLY_LEAVE flag and counts as an early-leave day. Zero flags any early departure past the minimum.',
        kind: 'minutes',
        dependsOn: 'earlyDepartureTrackingEnabled',
      },
      {
        key: 'fullDayToleranceMinutes',
        label: 'Full-day tolerance',
        description: 'How far short of a full day still earns one. Leaving half an hour early is worth reporting and not worth downgrading the day over.',
        kind: 'minutes',
      },
    ],
    linked: [
      {
        key: 'earlyLeaveDeductionEnabled',
        label: 'Deduction behaviour',
        description: 'Whether early departure costs anything in pay. Set on Payroll settings.',
      },
    ],
  },
  {
    key: 'classification',
    title: 'D. Attendance classification',
    description: 'How the minutes of a day become a status.',
    fields: [
      {
        key: 'halfDayMinutes',
        label: 'Half-day threshold',
        description: 'Minutes at or above this - but short of a full day - earn a half day. Below it the day is absent, so this is also the absent threshold.',
        kind: 'minutes',
      },
      {
        key: 'missingCheckInStatus',
        label: 'Missing check-in',
        description: 'What a day with a check-out and no check-in, or with neither, is worth.',
        kind: { enum: MISSING_PUNCH_RULES, labels: MISSING_PUNCH_RULE_LABELS },
      },
      {
        key: 'missingCheckOutStatus',
        label: 'Missing check-out',
        description: 'What a day with a check-in and no check-out is worth. The day is flagged MISSING_PUNCH either way.',
        kind: { enum: MISSING_PUNCH_RULES, labels: MISSING_PUNCH_RULE_LABELS },
      },
    ],
  },
  {
    key: 'overtime',
    title: 'E. Overtime',
    description: 'What time past the shift end is worth. Overtime is a labelled part of worked minutes, never time added to them.',
    fields: [
      { key: 'overtimeEnabled', label: 'Track overtime', description: 'Off: overtime is always zero.', kind: 'boolean' },
      {
        key: 'overtimeFromShiftEnd',
        label: 'Overtime starts after the shift end',
        description: 'On: measured from the end of the applicable shift. Off: anything past the duration threshold counts, which charges the break to the company every day.',
        kind: 'boolean',
        dependsOn: 'overtimeEnabled',
      },
      {
        key: 'overtimeCountsEarlyArrival',
        label: 'Early arrival counts as overtime',
        description: 'Whether turning up before the start earns anything.',
        kind: 'boolean',
        dependsOn: 'overtimeEnabled',
      },
      {
        key: 'overtimeReducedByLateArrival',
        label: 'Late arrival reduces overtime',
        description: 'Whether lateness is deducted from the overtime earned after the end.',
        kind: 'boolean',
        dependsOn: 'overtimeEnabled',
      },
      {
        key: 'overtimeMinimumMinutes',
        label: 'Minimum overtime',
        description: 'Overtime shorter than this is not credited, so a two-minute overrun does not become a payable figure.',
        kind: 'minutes',
        dependsOn: 'overtimeEnabled',
      },
      {
        key: 'overtimeRoundingMinutes',
        label: 'Overtime rounding',
        description: 'Credited overtime is rounded down to a multiple of this. Zero is no rounding.',
        kind: 'minutes',
        dependsOn: 'overtimeEnabled',
      },
      { key: 'overtimeDailyCapMinutes', label: 'Daily cap', description: 'The most overtime one day can earn, so a forgotten check-out cannot book the whole evening.', kind: 'minutes', dependsOn: 'overtimeEnabled' },
      { key: 'overtimeWeeklyCapMinutes', label: 'Weekly cap', description: 'Ceiling across a week, applied after the daily cap.', kind: 'minutes', nullable: true, dependsOn: 'overtimeEnabled' },
      { key: 'overtimeMonthlyCapMinutes', label: 'Monthly cap', description: 'Ceiling across a month, applied after the weekly cap.', kind: 'minutes', nullable: true, dependsOn: 'overtimeEnabled' },
    ],
    linked: [
      { key: 'overtimeMultiplier', label: 'Overtime multiplier', description: 'What an overtime hour pays, relative to an ordinary one. Set on Payroll settings.' },
      { key: 'requireApprovedOvertime', label: 'Approval required', description: 'Whether only overtime on an approved timesheet is paid. Set on Payroll settings.' },
      { key: 'overtimeCapMinutes', label: 'Paid overtime cap per period', description: 'A pay ceiling on top of the caps above. Set on Payroll settings.' },
    ],
  },
  {
    key: 'absence',
    title: 'F. Leave and absence',
    description:
      'Approved leave and absence are decided by the leave module and the calendar; what they cost is decided by payroll. Shown here so the whole picture is in one place.',
    fields: [],
    linked: [
      { key: 'deductUnpaidAbsence', label: 'Absence affects payroll', description: 'Whether a day recorded as absent reduces pay.' },
      { key: 'deductUnpaidLeave', label: 'Unpaid leave affects payroll', description: 'Whether approved leave on an unpaid leave type reduces pay. Whether a leave type is paid is set on the leave type itself.' },
    ],
  },
  {
    key: 'nonWorking',
    title: 'G. Holidays and weekends',
    description: 'What time worked on a day nobody was rostered for is worth. The day keeps its holiday or weekend status either way.',
    fields: [
      { key: 'weekendWorkRule', label: 'Weekend behaviour', description: 'What happens when someone works on a weekend day.', kind: { enum: NON_WORKING_DAY_WORK_RULES, labels: NON_WORKING_DAY_WORK_RULE_LABELS } },
      { key: 'holidayWorkRule', label: 'Holiday behaviour', description: 'What happens when someone works on a holiday.', kind: { enum: NON_WORKING_DAY_WORK_RULES, labels: NON_WORKING_DAY_WORK_RULE_LABELS } },
    ],
  },
  {
    key: 'integrity',
    title: 'H. Punch integrity',
    description:
      'When a day\u2019s punches are trustworthy enough to derive hours from. A terminal records events, not intent: it will report the same badge twice, and it cannot tell a forgotten check-out from a fourteen-hour day. These decide what happens when the events do not add up.',
    fields: [
      {
        key: 'duplicatePunchWindowSeconds',
        label: 'Duplicate punch window',
        description:
          'Punches closer together than this, saying the same thing, are one event seen twice and the later ones are ignored when pairing. Zero takes every punch at face value. The raw punches are never altered.',
        kind: 'seconds',
      },
      {
        key: 'maxPlausibleSpanMinutes',
        label: 'Longest believable day',
        description:
          'The longest first-to-last span still believed. Beyond it the day is reported as irregular with no hours, rather than crediting a figure nobody worked. Zero switches the check off.',
        kind: 'minutes',
      },
      {
        key: 'allowImplausibleSpans',
        label: 'Score days past that bound anyway',
        description:
          'Off: a day longer than the bound contributes no hours and is listed for correction. On: it is scored on its punches, which is what happened before this setting existed.',
        kind: 'boolean',
      },
    ],
  },
  {
    key: 'payroll',
    title: 'I. Payroll integration',
    description:
      'Whether each attendance fact reaches a payslip. These switches live on Payroll settings, which is where they are edited; they are read here so the two screens always agree.',
    fields: [],
    linked: [
      { key: 'lateDeductionEnabled', label: 'Late deduction', description: 'Whether recorded lateness reduces pay.' },
      { key: 'earlyLeaveDeductionEnabled', label: 'Early leave deduction', description: 'Whether recorded early departure reduces pay.' },
      { key: 'deductUnpaidAbsence', label: 'Absence deduction', description: 'Whether an absent day reduces pay.' },
      { key: 'deductUnpaidLeave', label: 'Unpaid leave deduction', description: 'Whether unpaid leave reduces pay.' },
      { key: 'overtimePaid', label: 'Overtime paid', description: 'Whether credited overtime is paid at all.' },
      { key: 'requireApprovedOvertime', label: 'Approved overtime only', description: 'Whether overtime needs an approved timesheet before it is paid.' },
    ],
  },
];

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
