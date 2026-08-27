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

const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

export const attendanceQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

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

export const shiftInputSchema = z.object({
  name: z.string().trim().min(2, 'Shift name is required.').max(120),
  code: z.string().trim().max(24).optional().nullable(),
  startTime: z.string().trim().regex(HHMM, 'Use 24-hour HH:mm, e.g. 09:00.'),
  endTime: z.string().trim().regex(HHMM, 'Use 24-hour HH:mm, e.g. 18:00.'),
  breakMinutes: z.coerce.number().int().min(0).max(480).default(0),
  isActive: z.boolean().default(true),
});

export const shiftAssignmentSchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.'),
  shiftId: z.string().trim().min(1, 'Choose a shift.'),
  effectiveFrom: isoDate,
  effectiveTo: z.string().trim().optional().nullable(),
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
  startTime: string;
  endTime: string;
  breakMinutes: number;
  isActive: boolean;
  assignedCount: number;
}

export interface ShiftAssignmentRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  shiftId: string;
  shiftName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
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
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  /** The portion of workedMinutes past the overtime threshold, never extra. */
  overtimeMinutes: number | null;
  mode: string | null;
  shiftName: string | null;
  notes: string | null;
  leaveTypeName: string | null;
  holidayName: string | null;
  hasRecord: boolean;
}

export interface AttendanceTotals {
  present: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  holiday: number;
  weekend: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
}

export interface AttendanceTodayState {
  date: string;
  status: AttendanceStatus;
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
}

// ------------------------------------------------- team attendance (manager)

/** One employee across the requested range, scoped to what the caller may see. */
export interface TeamAttendanceRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  departmentName: string | null;
  shiftName: string | null;
  days: AttendanceDay[];
  totals: AttendanceTotals;
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
