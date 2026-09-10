import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/** Notifications, attendance, shifts and timesheets. */

// ------------------------------------------------------------ notifications

export const NOTIFICATION_TYPES = [
  'APPROVAL_REQUESTED',
  'APPROVAL_APPROVED',
  'APPROVAL_REJECTED',
  'APPROVAL_CANCELLED',
  'PASSWORD_RESET',
  'SYSTEM',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z.enum(['true', 'false']).optional(),
});

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

// --------------------------------------------------------------- attendance

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'HALF_DAY',
  'ABSENT',
  'ON_LEAVE',
  'WEEKEND',
  'HOLIDAY',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  HALF_DAY: 'Half day',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
  WEEKEND: 'Weekend',
  HOLIDAY: 'Holiday',
};

/**
 * Statuses a day can be REPORTED as, which is a wider set than the ones a day
 * can be STORED as.
 *
 * `UPCOMING` is derived, never persisted and deliberately absent from the
 * Prisma enum: a working day that has not happened yet has no attendance fact
 * to record. It exists because the deriver used to fall through to ABSENT for
 * any working day without a record, which meant the rest of the month was
 * reported as absence the moment it was requested - a new joiner opened the
 * attendance page and saw every remaining day of the month marked against them.
 */
export const DERIVED_ATTENDANCE_STATUSES = [...ATTENDANCE_STATUSES, 'UPCOMING', 'OFF_DAY'] as const;
export type DerivedAttendanceStatus = (typeof DERIVED_ATTENDANCE_STATUSES)[number];

export const DERIVED_ATTENDANCE_STATUS_LABELS: Record<DerivedAttendanceStatus, string> = {
  ...ATTENDANCE_STATUS_LABELS,
  UPCOMING: 'Upcoming',
  /**
   * A day the employee's shift does not work, that is not a company weekend.
   * Derived like UPCOMING: the shift's working days decide it and nothing is
   * stored for it.
   */
  OFF_DAY: 'Off day',
};

/**
 * What else was true about a day, alongside its status.
 *
 * A late day is a present day that was late - the status stays PRESENT and
 * the flag says the rest. Statuses answer "was the day worked?"; flags answer
 * "what needs a second look?". Nothing here replaces PRESENT with LATE.
 */
export const ATTENDANCE_FLAGS = [
  'LATE',
  'EARLY_LEAVE',
  'OVERTIME',
  'MISSING_PUNCH',
  'IRREGULAR',
  'MANUAL',
] as const;
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number];

export const ATTENDANCE_FLAG_LABELS: Record<AttendanceFlag, string> = {
  LATE: 'Late',
  EARLY_LEAVE: 'Early leave',
  OVERTIME: 'Overtime',
  MISSING_PUNCH: 'Missing punch',
  IRREGULAR: 'Irregular',
  MANUAL: 'Manually adjusted',
};

/** Where a stored attendance record came from. Mirrors the Prisma enum. */
export const ATTENDANCE_SOURCES = ['SELF', 'SYSTEM', 'ADMIN', 'DEVICE'] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

export const ATTENDANCE_SOURCE_LABELS: Record<AttendanceSource, string> = {
  SELF: 'Self check-in',
  SYSTEM: 'System',
  ADMIN: 'Manual adjustment',
  DEVICE: 'Device',
};

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

export const attendanceQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  // Narrowing only. These never widen what the caller may see - the data scope
  // is applied first and these filter inside it.
  teamId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
});

/**
 * The monthly attendance view: one row per employee per day.
 *
 * `month` (YYYY-MM) is a shorthand for from/to; an explicit range wins. The
 * status filter accepts the derived set, so "show me every off day" is a
 * question this can answer.
 */
export const attendanceMonthlyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.')
    .optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  employeeId: z.string().trim().max(64).optional(),
  employeeNumber: z.string().trim().max(64).optional(),
  q: z.string().trim().max(200).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  shiftId: z.string().trim().max(64).optional(),
  /** A device user ID (PIN). Narrows to the employees that PunchCode maps to. */
  punchCode: z.string().trim().max(64).optional(),
  status: z.enum(DERIVED_ATTENDANCE_STATUSES).optional(),
  flag: z.enum(ATTENDANCE_FLAGS).optional(),
  /** Hide weekends, holidays, off days and future days. */
  workingOnly: z.enum(['true', 'false']).optional(),
});

export type AttendanceMonthlyQuery = z.infer<typeof attendanceMonthlyQuerySchema>;

export interface AttendanceMonthlyRow {
  date: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  teamName: string | null;
  shiftId: string | null;
  shiftName: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  expectedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  status: DerivedAttendanceStatus;
  flags: AttendanceFlag[];
  leaveTypeName: string | null;
  holidayName: string | null;
  source: AttendanceSource | null;
  hasRecord: boolean;
}

export interface AttendanceMonthlyTotals extends AttendanceTotals {
  offDay: number;
  late: number;
  earlyLeave: number;
  overtime: number;
  missingPunch: number;
  irregular: number;
  manual: number;
  earlyLeaveMinutes: number;
  /** Present + half days, over scored working days. Null when nothing was scored. */
  attendancePercentage: number | null;
}

export const attendanceUpsertSchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.'),
  date: isoDate,
  /**
   * Optional. Omit it and the day is scored by the company policy from the
   * times given; send one and the human decision wins. Either way the derived
   * numbers - worked, late, early, overtime - come from the policy.
   */
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  checkInAt: z.string().trim().optional().nullable(),
  checkOutAt: z.string().trim().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const regularizationCreateSchema = z.object({
  attendanceDate: isoDate,
  requestedCheckInAt: z.string().trim().optional().nullable(),
  requestedCheckOutAt: z.string().trim().optional().nullable(),
  requestedStatus: z.enum(ATTENDANCE_STATUSES).optional().nullable(),
  reason: z.string().trim().min(3, 'Give a reason for the correction.').max(1000),
});

export type AttendanceUpsertInput = z.infer<typeof attendanceUpsertSchema>;
export type RegularizationCreateInput = z.infer<typeof regularizationCreateSchema>;

export interface AttendanceRecordItem {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  mode: AttendanceMode | null;
  shiftName: string | null;
  notes: string | null;
  source: string;
}

// ------------------------------------------------------------------- shifts

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes, or null to inherit the company rule. Blank form fields arrive as ''. */
const inheritedMinutes = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.coerce.number().int('Use whole minutes.').min(0).max(max).nullable(),
  );

const inheritedBoolean = z.preprocess(
  (v) => (v === '' || v === undefined || v === 'inherit' ? null : v === 'true' ? true : v === 'false' ? false : v),
  z.boolean().nullable(),
);

export const WEEK_DAY_VALUES = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export const shiftInputSchema = z.object({
  name: z.string().trim().min(2, 'Shift name is required.').max(120),
  code: z.string().trim().max(24).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  startTime: z.string().trim().regex(HHMM, 'Use 24-hour HH:mm, e.g. 09:00.'),
  endTime: z.string().trim().regex(HHMM, 'Use 24-hour HH:mm, e.g. 18:00.'),
  breakMinutes: z.coerce.number().int().min(0).max(480).default(0),
  isActive: z.boolean().default(true),

  /** Empty means the company's working days. */
  workingDays: z.array(z.enum(WEEK_DAY_VALUES)).max(7).default([]),
  /** Null derives it from the window and the break. */
  expectedMinutes: inheritedMinutes(1440).default(null),

  // Rule overrides. Null inherits the company attendance rules.
  graceMinutes: inheritedMinutes(480).default(null),
  earlyLeaveGraceMinutes: inheritedMinutes(480).default(null),
  lateTrackingEnabled: inheritedBoolean.default(null),
  earlyDepartureTrackingEnabled: inheritedBoolean.default(null),
  overtimeEnabled: inheritedBoolean.default(null),
  overtimeDailyCapMinutes: inheritedMinutes(1440).default(null),
  overtimeMinimumMinutes: inheritedMinutes(480).default(null),

  effectiveFrom: z
    .preprocess((v) => (v === '' ? null : v), isoDate.nullable())
    .default(null),
});

export const shiftAssignmentSchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.'),
  shiftId: z.string().trim().min(1, 'Choose a shift.'),
  effectiveFrom: isoDate,
  effectiveTo: z.string().trim().optional().nullable(),
});

/** Closing or re-dating an assignment. The shift itself never changes here. */
export const shiftAssignmentUpdateSchema = z
  .object({
    effectiveFrom: isoDate.optional(),
    effectiveTo: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable()).optional(),
  })
  .refine((v) => v.effectiveFrom !== undefined || v.effectiveTo !== undefined, {
    message: 'Nothing to change.',
    path: ['effectiveTo'],
  });

export type ShiftAssignmentUpdateInput = z.infer<typeof shiftAssignmentUpdateSchema>;

export const shiftAssignmentQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  shiftId: z.string().trim().max(64).optional(),
  /** `true` returns only assignments in force today or later. */
  currentOnly: z.enum(['true', 'false']).optional(),
});

export const shiftChangeRequestSchema = z.object({
  requestedShiftId: z.string().trim().min(1, 'Choose the shift you want.'),
  effectiveFrom: isoDate,
  reason: z.string().trim().min(3, 'Give a reason for the change.').max(1000),
});

export type ShiftInput = z.infer<typeof shiftInputSchema>;
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentSchema>;
export type ShiftChangeRequestInput = z.infer<typeof shiftChangeRequestSchema>;

export interface ShiftRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  isActive: boolean;
  workingDays: WeekDayValue[];
  expectedMinutes: number | null;
  /** The rostered length actually used: expectedMinutes, or derived. */
  effectiveExpectedMinutes: number;
  graceMinutes: number | null;
  earlyLeaveGraceMinutes: number | null;
  lateTrackingEnabled: boolean | null;
  earlyDepartureTrackingEnabled: boolean | null;
  overtimeEnabled: boolean | null;
  overtimeDailyCapMinutes: number | null;
  overtimeMinimumMinutes: number | null;
  effectiveFrom: string | null;
  assignedCount: number;
}

export type WeekDayValue = (typeof WEEK_DAY_VALUES)[number];

export interface ShiftAssignmentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  shiftId: string;
  shiftName: string;
  shiftStartTime: string;
  shiftEndTime: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** True when the assignment covers today. */
  isCurrent: boolean;
}

// --------------------------------------------------------------- timesheets

export const TIMESHEET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

export const TIMESHEET_STATUS_LABELS: Record<TimesheetStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const timesheetQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(TIMESHEET_STATUSES).optional(),
});

export const timesheetCreateSchema = z
  .object({
    employeeId: z.string().trim().min(1).optional(),
    periodStart: isoDate,
    periodEnd: isoDate,
    notes: z.string().trim().max(1000).optional().nullable(),
    entries: z
      .array(
        z.object({
          date: isoDate,
          minutes: z.coerce.number().int().min(0).max(1440),
          description: z.string().trim().max(300).optional().nullable(),
        }),
      )
      .default([]),
  })
  .refine((v) => Date.parse(v.periodEnd) >= Date.parse(v.periodStart), {
    message: 'The period end cannot be before the start.',
    path: ['periodEnd'],
  });

export type TimesheetCreateInput = z.infer<typeof timesheetCreateSchema>;

export interface TimesheetEntryRecord {
  id: string;
  date: string;
  minutes: number;
  description: string | null;
  /** MANUAL unless the line was filled from captured attendance. */
  source: TimesheetEntrySource;
  attendanceRecordId: string | null;
}

export interface TimesheetRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  status: TimesheetStatus;
  totalMinutes: number;
  notes: string | null;
  submittedAt: string | null;
  approvalRequestId: string | null;
  entries: TimesheetEntryRecord[];
}

// ---------------------------------------------------------- password reset

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(10, 'That reset link is not valid.'),
    newPassword: z
      .string()
      .min(10, 'Use at least 10 characters.')
      .max(200)
      .refine((v) => /[a-z]/i.test(v), 'Include at least one letter.')
      .refine((v) => /\d/.test(v), 'Include at least one number.'),
    confirmPassword: z.string().min(1, 'Confirm your new password.'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// -------------------------------------------------- attendance capture (P5)

export const ATTENDANCE_MODES = ['OFFICE', 'REMOTE'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

export const ATTENDANCE_MODE_LABELS: Record<AttendanceMode, string> = {
  OFFICE: 'Office',
  REMOTE: 'Remote',
};

export const checkInSchema = z.object({
  mode: z.enum(ATTENDANCE_MODES).default('OFFICE'),
  notes: z.string().trim().max(500).optional().nullable(),
  // Sent only when the company restricts check-in to approved locations. The
  // browser is never trusted with the decision - the server compares these
  // against the work location itself.
  latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
});

export const checkOutSchema = z.object({
  notes: z.string().trim().max(500).optional().nullable(),
});

export const attendanceSummaryQuerySchema = z.object({
  employeeId: z.string().trim().max(64).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

/** One calendar day, whether or not a record exists for it. */
export interface AttendanceDay {
  date: string;
  /** Derived, so it can also be UPCOMING or OFF_DAY - see DERIVED_ATTENDANCE_STATUSES. */
  status: DerivedAttendanceStatus;
  /** What else was true about the day. Empty for a day with nothing to note. */
  flags: AttendanceFlag[];
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  /** Rostered minutes for the shift in force, or the company default window. */
  expectedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  /** The portion of workedMinutes past the overtime threshold, never extra. */
  overtimeMinutes: number | null;
  irregular: boolean;
  mode: string | null;
  shiftId: string | null;
  shiftName: string | null;
  notes: string | null;
  leaveTypeName: string | null;
  holidayName: string | null;
  /** Null when no record exists. */
  source: AttendanceSource | null;
  recordId: string | null;
  hasRecord: boolean;
}

export interface AttendanceTotals {
  present: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holiday: number;
  weekend: number;
  /** Working days still ahead in the range. Counted, never treated as absence. */
  upcoming: number;
  /** Days the employee's shift does not work. */
  offDay: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
}

export interface AttendanceTodayState {
  date: string;
  status: DerivedAttendanceStatus;
  checkedIn: boolean;
  checkedOut: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  overtimeMinutes: number | null;
  mode: string | null;
  shiftName: string | null;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  /** False on weekends, holidays and approved leave. */
  isWorkingDay: boolean;
  reason: string | null;
  /** True when the company requires coordinates with a check-in. */
  locationRequired: boolean;
  /** True when check-in is limited to approved networks. The list is never sent. */
  networkRestricted: boolean;
  /** The override in force today, or null when the company baseline applies. */
  policyName: string | null;
}

// ------------------------------------------------- team attendance (manager)

/** One employee across the requested range, scoped to what the caller may see. */
export interface TeamAttendanceRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  /// Null when the employee is on no team. The row is still returned - a person
  /// without a team is unassigned, not invisible.
  teamId: string | null;
  teamName: string | null;
  shiftName: string | null;
  days: AttendanceDay[];
  totals: AttendanceTotals;
}

/**
 * The `teamId` filter value that means "employees on no team at all".
 *
 * A sentinel rather than an empty string, because empty already means "do not
 * filter". Without it there is no way to ask for the unassigned: `teamId=<id>`
 * narrows to one team and omitting it returns everyone, so the people with a
 * null team can be seen only in a list that also contains everybody else.
 */
export const UNASSIGNED_TEAM_ID = 'unassigned';

/** The label shown for the null-team bucket. Not a team name - there is no such team. */
export const UNASSIGNED_TEAM_LABEL = 'Unassigned';

/**
 * One team's attendance headline.
 *
 * Deliberately day counts, not minutes: this answers "how is the team doing
 * today", and the per-person rows already carry the detail. `late` counts days
 * where someone arrived late, which is not the same question as `lateMinutes`
 * in AttendanceTotals - one late day is one late day however many minutes it ran.
 */
export interface TeamAttendanceSummaryRow {
  /** Null for the unassigned bucket, which is always last. */
  teamId: string | null;
  teamName: string;
  departmentName: string | null;
  /** Employees counted in this bucket, whether or not they have any days. */
  employees: number;
  present: number;
  late: number;
  absent: number;
  /** Working days scored in the range: present + halfDay + absent + onLeave. */
  total: number;
}

/** Absence finalisation for one day. Safe to repeat: it never overwrites. */
export const markAbsencesSchema = z.object({
  date: isoDate,
  /** Optional narrowing to a single employee; scope is enforced regardless. */
  employeeId: z.string().trim().max(64).optional().nullable(),
});

export type MarkAbsencesInput = z.infer<typeof markAbsencesSchema>;

export interface MarkAbsencesResult {
  date: string;
  scanned: number;
  marked: number;
  skipped: {
    notWorkingDay: number;
    onLeave: number;
    alreadyRecorded: number;
  };
}

// ------------------------------------ attendance -> timesheet, pay period (P6)

export const TIMESHEET_ENTRY_SOURCES = ['MANUAL', 'CAPTURED'] as const;
export type TimesheetEntrySource = (typeof TIMESHEET_ENTRY_SOURCES)[number];

export const TIMESHEET_ENTRY_SOURCE_LABELS: Record<TimesheetEntrySource, string> = {
  MANUAL: 'Manual',
  CAPTURED: 'From attendance',
};

/**
 * Fill a draft timesheet from captured attendance.
 *
 * Attendance stays the source of truth for what was actually worked; the
 * timesheet consumes it. Only CAPTURED lines are rewritten, so anything typed
 * by a person survives a re-sync untouched.
 */
export const timesheetSyncSchema = z.object({
  /** Replace existing captured lines. False adds only days not already covered. */
  replaceExisting: z.boolean().default(true),
});

export type TimesheetSyncInput = z.infer<typeof timesheetSyncSchema>;

export interface TimesheetSyncResult {
  timesheetId: string;
  daysConsidered: number;
  entriesWritten: number;
  entriesRemoved: number;
  manualEntriesKept: number;
  capturedMinutes: number;
  manualMinutes: number;
  totalMinutes: number;
  /** Days with a check-in but no check-out, which are never guessed at. */
  skippedIncomplete: number;
}

export const payPeriodQuerySchema = z.object({
  from: z.string().trim().min(1, 'Choose a period start.'),
  to: z.string().trim().min(1, 'Choose a period end.'),
  employeeId: z.string().trim().max(64).optional(),
});

/**
 * One employee's attendance summarised for a pay period.
 *
 * Deliberately figures, not money: this is the clean input a payroll run would
 * consume, and nothing here decides what anyone is paid.
 */
export interface PayPeriodRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Worked minutes excluding the overtime portion, so the two sum to worked. */
  regularMinutes: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  holidayDays: number;
  weekendDays: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  /** Days needing a human look: checked in but never out. */
  incompleteDays: number;
  /** Days whose record came from an approved correction or an administrator. */
  adjustedDays: number;
}

export interface PayPeriodSummary {
  from: string;
  to: string;
  rows: PayPeriodRow[];
  totals: {
    employees: number;
    workedMinutes: number;
    overtimeMinutes: number;
    absentDays: number;
    leaveDays: number;
    incompleteDays: number;
  };
}

// ------------------------------------------- attendance module (step 1)

/** One employee-day in full: the evidence, the calculation and the changes. */
export const attendanceDayQuerySchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  date: isoDate,
});

export interface AttendanceDayRules {
  /** The override in force, or null when the company baseline applied. */
  policyName: string | null;
  graceMinutes: number;
  lateThresholdMinutes: number;
  earlyLeaveGraceMinutes: number;
  earlyLeaveThresholdMinutes: number;
  halfDayMinutes: number;
  fullDayMinutes: number;
  fullDayToleranceMinutes: number;
  overtimeEnabled: boolean;
  overtimeFromShiftEnd: boolean;
  overtimeDailyCapMinutes: number;
  overtimeMinimumMinutes: number;
  breakIncludedInWindow: boolean;
  irregularCheckInEnabled: boolean;
  irregularCheckInCutoff: string;
  irregularCheckInMode: string;
  missingCheckInStatus: string;
  missingCheckOutStatus: string;
  /** Which of the values above came from the shift rather than the company. */
  fromShift: string[];
}

export interface AttendanceDayPunch extends RawPunchSummary {
  /** Whether this punch was chosen as the arrival or the departure. */
  role: 'IN' | 'OUT' | null;
}

/** The raw punch fields the day view needs. The full record is on /attendance/punches. */
export interface RawPunchSummary {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceSerial: string | null;
  deviceUserId: string;
  rawTimestamp: string;
  punchedAt: string;
  punchState: string | null;
  verifyMode: string | null;
  importedAt: string;
  processedAt: string | null;
}

export interface AttendanceAdjustmentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string;
  kind: 'CORRECTION' | 'MAPPING_CHANGE';
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface AttendanceDayDetail {
  date: string;
  employee: {
    id: string;
    name: string;
    employeeNumber: string;
    departmentName: string | null;
    teamName: string | null;
    designationName: string | null;
    /** Every PunchCode mapped to this person on the day, one per device. */
    punchCodes: Array<{ deviceId: string; deviceName: string; deviceUserId: string }>;
  };
  shift: {
    id: string | null;
    name: string | null;
    startTime: string;
    endTime: string;
    breakMinutes: number;
    expectedMinutes: number;
    /** False when the company default window applied. */
    assigned: boolean;
  };
  rules: AttendanceDayRules;
  /** The stored, processed day. Null when nothing has been stored. */
  processed: AttendanceDay;
  /**
   * What the engine would produce from the raw punches under today's rules.
   * Shown beside the stored figures so a discrepancy is visible; never written.
   */
  fromPunches: {
    checkInAt: string | null;
    checkOutAt: string | null;
    workedMinutes: number | null;
    lateMinutes: number | null;
    earlyLeaveMinutes: number | null;
    overtimeMinutes: number | null;
    status: string;
    irregular: boolean;
  } | null;
  rawPunches: AttendanceDayPunch[];
  adjustments: AttendanceAdjustmentRecord[];
}

/**
 * A manual correction to processed attendance.
 *
 * Times and status are the usual inputs; the minute fields are explicit
 * overrides for when the arithmetic is right and the world is wrong (a device
 * clock that drifted an hour). Anything not sent is recomputed from the times
 * under the rules in force on the day. The reason is mandatory - it is what
 * the audit trail is for.
 */
export const attendanceCorrectionSchema = z
  .object({
    employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
    date: isoDate,
    checkInAt: z.preprocess((v) => (v === '' ? null : v), z.string().trim().nullable()).optional(),
    checkOutAt: z.preprocess((v) => (v === '' ? null : v), z.string().trim().nullable()).optional(),
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    shiftId: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(64).nullable()).optional(),
    workedMinutes: inheritedMinutes(1440).optional(),
    lateMinutes: inheritedMinutes(1440).optional(),
    earlyLeaveMinutes: inheritedMinutes(1440).optional(),
    overtimeMinutes: inheritedMinutes(1440).optional(),
    notes: z.string().trim().max(500).optional().nullable(),
    reason: z.string().trim().min(3, 'Give a reason for the correction.').max(1000),
  })
  .refine(
    (v) =>
      !v.checkInAt ||
      !v.checkOutAt ||
      Date.parse(v.checkOutAt) > Date.parse(v.checkInAt),
    { message: 'Check-out must be after check-in.', path: ['checkOutAt'] },
  );

export type AttendanceCorrectionInput = z.infer<typeof attendanceCorrectionSchema>;

export const attendanceAdjustmentQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  date: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

// ---------------------------------------------------------------- dashboard

export const attendanceDashboardQuerySchema = z.object({
  /** The day the headline counts describe. Defaults to today in the company zone. */
  date: z.string().trim().optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  /** Days of trend to include, ending on the date. */
  trendDays: z.coerce.number().int().min(1).max(31).default(7),
});

export interface AttendanceDashboardCounts {
  totalEmployees: number;
  present: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holiday: number;
  weekend: number;
  offDay: number;
  late: number;
  earlyLeave: number;
  overtime: number;
  missingPunch: number;
  irregular: number;
  /** Present + half days over scored working days; null when nothing was scored. */
  attendancePercentage: number | null;
}

export interface AttendanceDashboardGroup extends AttendanceDashboardCounts {
  id: string | null;
  name: string;
}

export interface AttendanceDashboardPerson {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  teamName: string | null;
  status: DerivedAttendanceStatus;
  flags: AttendanceFlag[];
  checkInAt: string | null;
  checkOutAt: string | null;
  lateMinutes: number | null;
  overtimeMinutes: number | null;
  shiftName: string | null;
}

export interface AttendanceDashboard {
  date: string;
  /** True when the employee list was cut at the server ceiling. */
  truncated: boolean;
  counts: AttendanceDashboardCounts;
  trend: Array<{ date: string } & AttendanceDashboardCounts>;
  byDepartment: AttendanceDashboardGroup[];
  /** Employees on no team are grouped as "Unassigned", never dropped. */
  byTeam: AttendanceDashboardGroup[];
  /** Latest check-ins first. */
  recent: AttendanceDashboardPerson[];
  late: AttendanceDashboardPerson[];
  /** Checked in and not yet out. */
  presentNow: AttendanceDashboardPerson[];
  absent: AttendanceDashboardPerson[];
}

// ------------------------------------------------------------------ reports

export const ATTENDANCE_REPORT_TYPES = [
  'daily',
  'monthly',
  'employee',
  'department',
  'team',
  'late',
  'early-leave',
  'absence',
  'overtime',
  'missing-punch',
  'leave-vs-attendance',
  'summary',
] as const;
export type AttendanceReportType = (typeof ATTENDANCE_REPORT_TYPES)[number];

export const ATTENDANCE_REPORT_LABELS: Record<AttendanceReportType, string> = {
  daily: 'Daily attendance',
  monthly: 'Monthly attendance',
  employee: 'Employee attendance',
  department: 'Department attendance',
  team: 'Team attendance',
  late: 'Late report',
  'early-leave': 'Early leave report',
  absence: 'Absence report',
  overtime: 'Overtime report',
  'missing-punch': 'Missing punch report',
  'leave-vs-attendance': 'Leave vs attendance',
  summary: 'Attendance summary',
};

export const attendanceReportQuerySchema = z.object({
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.')
    .optional(),
  employeeId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  shiftId: z.string().trim().max(64).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

export interface AttendanceReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  kind?: 'text' | 'number' | 'minutes' | 'date' | 'time' | 'percent';
}

export type AttendanceReportCell = string | number | null;

export interface AttendanceReport {
  type: AttendanceReportType;
  title: string;
  from: string;
  to: string;
  generatedAt: string;
  columns: AttendanceReportColumn[];
  rows: Array<Record<string, AttendanceReportCell>>;
  /** A totals line, in the same column keys, where the report has one. */
  totals: Record<string, AttendanceReportCell> | null;
  /** True when the employee set was cut at the server ceiling. */
  truncated: boolean;
}

/**
 * Everything about one employee's attendance over a range, in one payload.
 *
 * The "employee report" of the specification: the month as a calendar, the
 * day-by-day detail behind it, the raw punches underneath that, every
 * correction anyone has made, and the shifts they were on. Assembled server
 * side so the screen makes one request rather than five that could each
 * describe a slightly different range.
 */
export interface AttendanceEmployeeFile {
  employee: {
    id: string;
    name: string;
    employeeNumber: string;
    departmentName: string | null;
    teamName: string | null;
    designationName: string | null;
    joinedOn: string | null;
    punchCodes: Array<{
      deviceId: string;
      deviceName: string;
      deviceUserId: string;
      effectiveFrom: string | null;
      effectiveTo: string | null;
      isActive: boolean;
    }>;
  };
  from: string;
  to: string;
  days: AttendanceDay[];
  totals: AttendanceMonthlyTotals;
  rawPunches: RawPunchSummary[];
  adjustments: AttendanceAdjustmentRecord[];
  shiftHistory: Array<{
    id: string;
    shiftId: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
}

export const attendanceEmployeeFileQuerySchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.')
    .optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});
