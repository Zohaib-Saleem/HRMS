import { z } from 'zod';

/**
 * The employee timeline.
 *
 * A READ layer and nothing else. There is no timeline table, no timeline
 * migration and no write path: every event below is a row some other module
 * already owns, read back and normalised into one shape. That is deliberate -
 * a second copy of "when was she confirmed?" is a second copy that eventually
 * disagrees with the first, and the disagreement always surfaces in front of
 * the person it is about.
 *
 * Two consequences fall out of that and both are load-bearing:
 *
 *   - A category the caller may not read is ABSENT, never empty. An empty
 *     "Salary" section reads as "this person has never had a raise", which is a
 *     statement about the employee; an absent one is a statement about the
 *     reader, which is the true one.
 *   - Nothing here carries a database id a person could read. Actors are
 *     names, and an event's link is the profile TAB its module lives on, so
 *     the drawer can hand the reader on to the real module without this
 *     feature inventing a second way to address a loan or a claim.
 */

export const TIMELINE_CATEGORIES = [
  'EMPLOYMENT',
  'SALARY',
  'ATTENDANCE',
  'LEAVE',
  'LOAN',
  'MEDICAL',
  'CASE',
  'DOCUMENT',
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

/** What the filter chips say. Plural, because a chip names a body of history. */
export const TIMELINE_CATEGORY_LABELS: Record<TimelineCategory, string> = {
  EMPLOYMENT: 'Employment',
  SALARY: 'Salary',
  ATTENDANCE: 'Attendance',
  LEAVE: 'Leave',
  LOAN: 'Loans',
  MEDICAL: 'Medical',
  CASE: 'Cases',
  DOCUMENT: 'Documents',
};

/**
 * Every event this system can honestly produce.
 *
 * The list is short on purpose. An event type exists here only when some
 * existing table already records both the fact and the day it happened - see
 * `employee-timeline.service.ts`, where each one is read from exactly one
 * place. Nothing is derived from an assumption about what probably happened.
 */
export const TIMELINE_EVENT_TYPES = [
  // --- employment -----------------------------------------------------------
  'EMPLOYEE_JOINED',
  'WORK_ANNIVERSARY',
  'EMPLOYEE_CONFIRMED',
  'EMPLOYEE_RESIGNED',
  'EMPLOYEE_LAST_WORKING_DAY',
  'EMPLOYEE_TERMINATED',
  'EMPLOYEE_REACTIVATED',
  'EMPLOYMENT_STATUS_CHANGED',
  'EMPLOYMENT_STAGE_CHANGED',
  'EMPLOYMENT_TYPE_CHANGED',
  'DEPARTMENT_CHANGED',
  'TEAM_CHANGED',
  'DESIGNATION_CHANGED',
  'MANAGER_CHANGED',
  'LOCATION_CHANGED',

  // --- salary ---------------------------------------------------------------
  'SALARY_CREATED',
  'SALARY_UPDATED',
  'SALARY_INCREMENT',

  // --- attendance -----------------------------------------------------------
  'ATTENDANCE_CORRECTION_REQUESTED',
  'ATTENDANCE_CORRECTION_APPROVED',
  'ATTENDANCE_CORRECTION_REJECTED',
  'ATTENDANCE_CORRECTED',

  // --- leave ----------------------------------------------------------------
  'LEAVE_REQUESTED',
  'LEAVE_APPROVED',
  'LEAVE_REJECTED',
  'LEAVE_CANCELLED',

  // --- loans ----------------------------------------------------------------
  'LOAN_APPLIED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'LOAN_ACTIVATED',
  'LOAN_COMPLETED',
  'LOAN_CANCELLED',

  // --- medical --------------------------------------------------------------
  'MEDICAL_CLAIM_SUBMITTED',
  'MEDICAL_CLAIM_APPROVED',
  'MEDICAL_CLAIM_REJECTED',
  'MEDICAL_CLAIM_PAID',
  'MEDICAL_CLAIM_CANCELLED',

  // --- cases ----------------------------------------------------------------
  'CASE_OPENED',
  'CASE_RESOLVED',
  'CASE_CLOSED',

  // --- documents ------------------------------------------------------------
  'CONTRACT_STARTED',
  'CONTRACT_ENDED',
  'POLICY_ASSIGNED',
  'POLICY_ACKNOWLEDGED',
  'POLICY_DECLINED',
  'DOCUMENT_EXPIRED',
] as const;

export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * Which profile tab an event's own module lives on.
 *
 * A tab name rather than a record id, because the drawer's job is to hand the
 * reader over to the module that owns the record - not to become a second,
 * thinner copy of it. It also means the timeline never publishes an address
 * for a loan or a claim that the module itself does not already publish.
 */
export type TimelineLinkTab =
  | 'Overview'
  | 'Attendance'
  | 'Leave'
  | 'Loans'
  | 'Salary & Payroll'
  | 'Contracts & Policies';

/** One normalised event. Every field is display-ready; none is an id. */
export interface TimelineEvent {
  /**
   * Stable within a response and across pages, so React can key on it and the
   * cursor can point at it. Opaque: it addresses nothing.
   */
  id: string;
  category: TimelineCategory;
  type: TimelineEventType;
  /** The instant the event is sorted by, ISO 8601. */
  occurredAt: string;
  /** The calendar day it happened on IN THE COMPANY'S OWN TIMEZONE. */
  day: string;
  /** The year of `day`. Sent rather than derived, so separators cannot drift. */
  year: number;
  /**
   * True when the source was a date column rather than a timestamp - a salary
   * effective date, a hire date. The UI shows no clock time for these, because
   * there never was one.
   */
  dateOnly: boolean;
  title: string;
  description: string | null;
  /** Ordered rows for the detail drawer. Already formatted, already redacted. */
  details: Array<{ label: string; value: string }>;
  /** Who did it, by name. Null when nobody is recorded, or when unreadable. */
  actorName: string | null;
  link: TimelineLinkTab | null;
}

export const employeeTimelineQuerySchema = z.object({
  category: z.enum(TIMELINE_CATEGORIES).optional(),
  year: z.coerce.number().int().min(1900).max(2999).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Keyset position, opaque. Produced only by this endpoint. */
  cursor: z.string().trim().max(256).optional(),
});

export type EmployeeTimelineQuery = z.infer<typeof employeeTimelineQuerySchema>;

export interface EmployeeTimelineMeta {
  limit: number;
  order: 'asc' | 'desc';
  /** Events matching the filters, across every page. */
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * The years that hold anything, newest first, and the categories that hold
   * anything the caller may read. Both ignore the current filters, so the chips
   * do not rearrange themselves as somebody clicks through them - and both are
   * narrowed by permission, so a chip is never offered for history the reader
   * would be refused.
   */
  years: number[];
  categories: TimelineCategory[];
}

export interface EmployeeTimelinePage {
  data: TimelineEvent[];
  meta: EmployeeTimelineMeta;
}

/** Default page size. One screen's worth; the rest arrives on Load more. */
export const TIMELINE_PAGE_SIZE = 20;
