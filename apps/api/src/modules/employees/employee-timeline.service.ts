import type { Prisma } from '@prisma/client';
import {
  CASE_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  LEAVE_DAY_PART_LABELS,
  MEDICAL_CATEGORY_LABELS,
  PERMISSIONS,
  TIMELINE_CATEGORIES,
  type EmployeeStatus,
  type EmployeeTimelineQuery,
  type EmployeeTimelinePage,
  type EmploymentStatus,
  type EmploymentType,
  type MedicalCategory,
  type Permission,
  type TimelineCategory,
  type TimelineEvent,
  type TimelineEventType,
  type TimelineLinkTab,
} from '@hrms/shared';
import type { AuthContext } from '../../auth/session.js';
import { prisma } from '../../core/db.js';
import { dateColumnToDayKey, dayKeyInZone, todayInZone } from '../../core/zoned-time.js';
import { deskScopeFilter, resolveDeskAgent } from '../cases/case-desk.service.js';
import { toNumber } from '../loans/loans.service.js';

/**
 * The employee timeline: one person's history, assembled from the modules that
 * already hold it.
 *
 * This file writes NOTHING. It creates no record, it stores no event, and
 * opening a timeline leaves the database exactly as it found it. Every entry
 * below is an existing row read back - a salary record, a loan, a claim, a
 * contract, an audit entry - rendered into one shape so they can be read in
 * order. There is no timeline table because a timeline table would be a second
 * copy of facts that already have an owner, and the second copy is the one
 * that goes wrong.
 *
 * ## How permission works here
 *
 * The route has already established two things: the caller holds
 * `employee.read`, and this employee is inside their data scope. That is
 * admission to the PROFILE. It is not admission to the profile's contents, and
 * this service never treats it as such.
 *
 * Each block below is gated on the permission its own module requires - the
 * same constant, checked the same way, so a reader gets exactly the salary,
 * medical, loan and case history they would get by opening those modules
 * directly. A block the caller cannot read is not fetched at all: no query is
 * issued, nothing is redacted afterwards, and the category does not appear in
 * the filter chips. That ordering matters. Redaction after the fact is a thing
 * somebody forgets to do on the next branch; not reading the row cannot be
 * forgotten.
 *
 * The one grant this feature could have accidentally invented - "may read the
 * timeline" - deliberately does not exist. There is nothing to grant somebody
 * that would let them past the modules' own gates.
 *
 * ## Attendance
 *
 * Daily attendance is NOT here, and that is a design decision rather than an
 * omission. A punch is not an event in somebody's employment; ten years of
 * them would bury the four things that are. What is here is the corrections -
 * the days a human being changed, and the requests to change them - which is
 * the part of attendance that has an actor and a reason.
 */

/**
 * How far back each source is read.
 *
 * A ceiling rather than a page: the events are merged and sorted across every
 * source before anything is paginated, so a per-source page would silently
 * drop the older half of one module the moment another was chattier. Twenty
 * years of an ordinary employee fits inside this comfortably; the cap exists
 * so that a pathological record cannot turn one profile view into an unbounded
 * read.
 */
const SOURCE_LIMIT = 500;

/** Anniversaries stop here. Nobody serves sixty years, and the loop must end. */
const MAX_ANNIVERSARIES = 60;

/** Employee fields whose CHANGE is part of employment history. */
const EMPLOYMENT_FIELDS = [
  'status',
  'employmentStatus',
  'employmentType',
  'departmentId',
  'teamId',
  'designationId',
  'jobTitle',
  'locationId',
  'managerId',
  'secondaryManagerId',
] as const;

type EmploymentField = (typeof EMPLOYMENT_FIELDS)[number];

/**
 * An event before its actor has a name and its day has a timezone.
 *
 * `actorUserId` is resolved in one batch at the end rather than per event, and
 * it never reaches the client: the response carries a name or nothing.
 */
interface Draft {
  id: string;
  category: TimelineCategory;
  type: TimelineEventType;
  at: Date;
  dateOnly: boolean;
  title: string;
  description: string | null;
  details: Array<{ label: string; value: string }>;
  actorUserId?: string | null;
  /** For the sources that store a typed name instead of a login. */
  actorName?: string | null;
  link: TimelineLinkTab | null;
}

// ---------------------------------------------------------------- formatting

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "PKR 135,000". The code, not a symbol: a server has no locale of its own. */
function money(amount: number, currency: string): string {
  return `${currency} ${NUMBER.format(amount)}`;
}

/** A yyyy-MM-dd day, as "15 Jun 2022". */
function dayLabel(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function dateLabel(value: Date | null | undefined): string | null {
  return value ? dayLabel(dateColumnToDayKey(value)) : null;
}

/** `employmentStatus` -> "Employment status". For the correction field list. */
function humaniseField(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/Id$/, '');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** "1 day" / "2 days", because "2 day" makes a reader stop and re-read. */
function plural(count: number, noun: string): string {
  return `${NUMBER.format(count)} ${noun}${count === 1 ? '' : 's'}`;
}

// -------------------------------------------------------------- the reading

interface Sources {
  timezone: string;
  currency: string;
}

/** What a caller may read, category by category. */
interface Access {
  salary: boolean;
  attendance: boolean;
  leave: boolean;
  loan: boolean;
  medical: boolean;
  cases: boolean;
  contracts: boolean;
  policies: boolean;
  /** Identity-document expiry dates live behind the restricted-fields grant. */
  sensitive: boolean;
  /**
   * Whether an employment change may be ATTRIBUTED to the person who made it.
   *
   * The change itself is the employee's own record and needs no extra grant.
   * "Who changed it, when, from where" is the audit log, and the audit log has
   * a grant already - so the name is shown to a reader who holds it and the
   * event stands without a name to everybody else. An employee reading their
   * own history sees what happened to them; they do not thereby gain a window
   * onto the administrative trail.
   */
  auditActor: boolean;
}

async function resolveAccess(auth: AuthContext, employeeId: string): Promise<Access> {
  const can = (permission: Permission) => auth.permissions.has(permission);

  /*
   * Medical follows the medical module's own rule exactly: `medical.read` is
   * the door, and whose claims you may see is decided by whether this is your
   * own record or you hold oversight. A wide data scope does not widen it,
   * which is why the check is on the caller's employee id and not on scope.
   */
  let medical = false;
  if (can(PERMISSIONS.MEDICAL_READ)) {
    const oversight =
      can(PERMISSIONS.MEDICAL_MANAGE) || can(PERMISSIONS.MEDICAL_CLAIM_APPROVE);
    if (oversight) {
      medical = true;
    } else {
      const self = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });
      medical = self?.id === employeeId;
    }
  }

  return {
    salary: can(PERMISSIONS.PAYROLL_READ),
    attendance: can(PERMISSIONS.ATTENDANCE_READ),
    leave: can(PERMISSIONS.LEAVE_READ),
    loan: can(PERMISSIONS.LOAN_READ),
    medical,
    cases: can(PERMISSIONS.CASE_READ_OWN) || can(PERMISSIONS.CASE_READ_DEPARTMENT) || can(PERMISSIONS.CASE_READ_ALL),
    contracts: can(PERMISSIONS.CONTRACT_READ),
    policies: can(PERMISSIONS.POLICY_READ),
    sensitive: can(PERMISSIONS.EMPLOYEE_SENSITIVE_READ),
    auditActor: can(PERMISSIONS.AUDIT_READ),
  };
}

/**
 * Which of this employee's cases the caller may see.
 *
 * Null means none, and callers treat it as no rows rather than no filter -
 * the same contract `employeeScopeFilter` and `deskScopeFilter` already use,
 * for the same reason: the mistake that widens a departmental agent into a
 * company-wide one is one `?? {}` away.
 */
async function caseFilter(
  auth: AuthContext,
  employeeId: string,
): Promise<Prisma.CaseWhereInput | null> {
  const own = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  // Your own cases, on your own profile, with the grant the module requires.
  if (own?.id === employeeId && auth.permissions.has(PERMISSIONS.CASE_READ_OWN)) {
    return { companyId: auth.companyId, requesterEmployeeId: employeeId };
  }

  const agent = await resolveDeskAgent(auth);
  if (!agent) return null;

  const scope = deskScopeFilter(agent);
  if (!scope) return null;

  return { AND: [scope, { requesterEmployeeId: employeeId }] };
}

// -------------------------------------------------------- the event builders

/**
 * The audit log, read as employment history.
 *
 * Only the fields in `EMPLOYMENT_FIELDS` produce an event. That whitelist is a
 * privacy control, not a tidiness one: an `employee.update` entry carries a
 * field-level diff of everything that changed in that request, which can
 * include a bank account or a national ID. Walking the whitelist means those
 * columns are never read out of the diff - and it also means the timeline does
 * not advertise that a restricted field was edited, which a generic "profile
 * updated" event would.
 *
 * Ids inside the diff are resolved to names before they are shown. A reader is
 * told the person moved to Development, never that `departmentId` became a
 * cuid.
 */
function employmentChangeEvents(
  rows: AuditRow[],
  names: NameBook,
  employee: EmployeeRow,
  access: Access,
): Draft[] {
  const events: Draft[] = [];
  const confirmedOnFile = employee.confirmationDate !== null;

  for (const row of rows) {
    const before = (row.before ?? {}) as Record<string, unknown>;
    const after = (row.after ?? {}) as Record<string, unknown>;
    const actorUserId = access.auditActor ? row.actorId : null;

    if (row.action === 'employee.reactivate') {
      events.push({
        id: `audit:${row.id}:reactivate`,
        category: 'EMPLOYMENT',
        type: 'EMPLOYEE_REACTIVATED',
        at: row.createdAt,
        dateOnly: false,
        title: 'Reactivated',
        description: 'Returned to active employment.',
        details: [{ label: 'Status', value: EMPLOYEE_STATUS_LABELS.ACTIVE }],
        actorUserId,
        link: 'Overview',
      });
      continue;
    }

    for (const field of EMPLOYMENT_FIELDS) {
      if (!(field in after)) continue;

      const from = before[field];
      const to = after[field];
      if (from === to) continue;

      const event = changeEvent(field, from, to, names);
      if (!event) continue;

      /*
       * Exits and confirmations are told once, by the milestone that carries
       * the date they took effect. An audit entry is dated when somebody typed
       * it, which is rarely the day the person actually left - so the entry
       * contributes its ACTOR to the milestone and no event of its own.
       */
      if (field === 'status' && (to === 'TERMINATED' || to === 'RESIGNED')) continue;
      if (field === 'employmentStatus' && to === 'PERMANENT' && confirmedOnFile) continue;

      events.push({
        id: `audit:${row.id}:${field}`,
        category: 'EMPLOYMENT',
        at: row.createdAt,
        dateOnly: false,
        actorUserId,
        link: 'Overview',
        ...event,
      });
    }
  }

  return events;
}

type ChangeShape = Pick<Draft, 'type' | 'title' | 'description' | 'details'>;

/** One whitelisted field change, as a sentence a person can read. */
function changeEvent(
  field: EmploymentField,
  from: unknown,
  to: unknown,
  names: NameBook,
): ChangeShape | null {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  const arrow = (previous: string | null, next: string | null, fallback = 'Not set') =>
    `${previous ?? fallback} → ${next ?? fallback}`;

  switch (field) {
    case 'status': {
      const previous = EMPLOYEE_STATUS_LABELS[text(from) as EmployeeStatus] ?? null;
      const next = EMPLOYEE_STATUS_LABELS[text(to) as EmployeeStatus] ?? null;
      if (!next) return null;
      return {
        type: 'EMPLOYMENT_STATUS_CHANGED',
        title: 'Employment status changed',
        description: arrow(previous, next),
        details: [
          { label: 'Previous', value: previous ?? '—' },
          { label: 'New', value: next },
        ],
      };
    }
    case 'employmentStatus': {
      const previous = EMPLOYMENT_STATUS_LABELS[text(from) as EmploymentStatus] ?? null;
      const next = EMPLOYMENT_STATUS_LABELS[text(to) as EmploymentStatus] ?? null;
      return {
        type: 'EMPLOYMENT_STAGE_CHANGED',
        title: 'Employment stage changed',
        description: arrow(previous, next, 'Unclassified'),
        details: [
          { label: 'Previous', value: previous ?? 'Unclassified' },
          { label: 'New', value: next ?? 'Unclassified' },
        ],
      };
    }
    case 'employmentType': {
      const previous = EMPLOYMENT_TYPE_LABELS[text(from) as EmploymentType] ?? null;
      const next = EMPLOYMENT_TYPE_LABELS[text(to) as EmploymentType] ?? null;
      if (!next) return null;
      return {
        type: 'EMPLOYMENT_TYPE_CHANGED',
        title: 'Employment type changed',
        description: arrow(previous, next),
        details: [
          { label: 'Previous', value: previous ?? '—' },
          { label: 'New', value: next },
        ],
      };
    }
    case 'departmentId':
      return referenceChange(
        'DEPARTMENT_CHANGED',
        'Department changed',
        'Department',
        names.department.get(text(from) ?? '') ?? null,
        names.department.get(text(to) ?? '') ?? null,
      );
    case 'teamId':
      return referenceChange(
        'TEAM_CHANGED',
        'Team changed',
        'Team',
        names.team.get(text(from) ?? '') ?? null,
        names.team.get(text(to) ?? '') ?? null,
      );
    case 'designationId':
      return referenceChange(
        'DESIGNATION_CHANGED',
        'Designation changed',
        'Designation',
        names.designation.get(text(from) ?? '') ?? null,
        names.designation.get(text(to) ?? '') ?? null,
      );
    case 'jobTitle':
      return referenceChange(
        'DESIGNATION_CHANGED',
        'Job title changed',
        'Job title',
        text(from),
        text(to),
      );
    case 'locationId':
      return referenceChange(
        'LOCATION_CHANGED',
        'Work location changed',
        'Location',
        names.location.get(text(from) ?? '') ?? null,
        names.location.get(text(to) ?? '') ?? null,
      );
    case 'managerId':
      return referenceChange(
        'MANAGER_CHANGED',
        'Manager changed',
        'Manager',
        names.employee.get(text(from) ?? '') ?? null,
        names.employee.get(text(to) ?? '') ?? null,
      );
    case 'secondaryManagerId':
      return referenceChange(
        'MANAGER_CHANGED',
        'Second manager changed',
        'Second manager',
        names.employee.get(text(from) ?? '') ?? null,
        names.employee.get(text(to) ?? '') ?? null,
      );
    default:
      return null;
  }
}

/**
 * A change from one named thing to another.
 *
 * Returns null when neither side has a name. That happens when both ids point
 * at rows that have since been deleted, and "— → —" is not an event; it is
 * noise that would make a reader think something had gone wrong.
 */
function referenceChange(
  type: TimelineEventType,
  title: string,
  label: string,
  previous: string | null,
  next: string | null,
): ChangeShape | null {
  if (!previous && !next) return null;
  return {
    type,
    title,
    description: `${previous ?? 'None'} → ${next ?? 'None'}`,
    details: [
      { label: `Previous ${label.toLowerCase()}`, value: previous ?? 'None' },
      { label: `New ${label.toLowerCase()}`, value: next ?? 'None' },
    ],
  };
}

// ------------------------------------------------------------ the milestones

/**
 * The employment milestones, dated by the day they took effect.
 *
 * These come from the employee's own dated columns rather than from the audit
 * log, and that is the point: `terminationDate` is the day somebody left,
 * while an audit entry is dated the afternoon an administrator got round to
 * recording it. A timeline that showed the second would be quietly wrong about
 * the fact people actually ask it for.
 *
 * The audit log still contributes: it is searched for the entry that made each
 * change, purely to attribute it. So a termination reads with the date it
 * happened AND the name of whoever recorded it, which neither source carries
 * alone.
 */
function milestoneEvents(
  employee: EmployeeRow,
  rows: AuditRow[],
  access: Access,
  today: string,
): Draft[] {
  const events: Draft[] = [];

  /** Newest audit entry that made this change, for the "Changed by" line. */
  const actorFor = (matches: (row: AuditRow) => boolean): string | null => {
    if (!access.auditActor) return null;
    for (const row of rows) {
      if (matches(row)) return row.actorId;
    }
    return null;
  };

  /** The `after` diff of an audit entry, as a plain object. */
  const after = (row: AuditRow) => (row.after ?? {}) as Record<string, unknown>;

  const designation = employee.designation?.name ?? employee.jobTitle ?? null;
  const department = employee.department?.name ?? null;

  // --- joined ---------------------------------------------------------------
  // The hire date when there is one; the day the record was created when there
  // is not. Never a guess: an employee with neither has no joining event.
  const joinedAt = employee.hireDate ?? employee.createdAt;
  events.push({
    id: 'employee:joined',
    category: 'EMPLOYMENT',
    type: 'EMPLOYEE_JOINED',
    at: joinedAt,
    dateOnly: employee.hireDate !== null,
    title: 'Joined company',
    description: [department, designation].filter(Boolean).join(' · ') || null,
    details: [
      { label: 'Department', value: department ?? '—' },
      { label: 'Designation', value: designation ?? '—' },
      { label: 'Employment type', value: EMPLOYMENT_TYPE_LABELS[employee.employmentType] },
      ...(employee.hireDate
        ? [{ label: 'Hire date', value: dateLabel(employee.hireDate)! }]
        : []),
    ],
    actorUserId: actorFor((row) => row.action === 'employee.create'),
    link: 'Overview',
  });

  // --- work anniversaries ---------------------------------------------------
  // Derived from the hire date, which is a real recorded fact, and never past
  // today or past the day the person left - an anniversary somebody was not
  // here for is exactly the invented history this feature must not produce.
  if (employee.hireDate) {
    const hireDay = dateColumnToDayKey(employee.hireDate);
    const [year = 0, month = 1, day = 1] = hireDay.split('-').map(Number);
    const lastDay = employee.terminationDate
      ? dateColumnToDayKey(employee.terminationDate)
      : today;
    const until = lastDay < today ? lastDay : today;

    for (let n = 1; n <= MAX_ANNIVERSARIES; n += 1) {
      const at = new Date(Date.UTC(year + n, month - 1, day));
      const key = dateColumnToDayKey(at);
      if (key > until) break;
      events.push({
        id: `employee:anniversary:${n}`,
        category: 'EMPLOYMENT',
        type: 'WORK_ANNIVERSARY',
        at,
        dateOnly: true,
        title: 'Work anniversary',
        description: `Completed ${plural(n, 'year')}`,
        details: [
          { label: 'Years of service', value: String(n) },
          { label: 'Joined', value: dayLabel(hireDay) },
        ],
        link: 'Overview',
      });
    }
  }

  // --- confirmation ---------------------------------------------------------
  if (employee.confirmationDate) {
    events.push({
      id: 'employee:confirmed',
      category: 'EMPLOYMENT',
      type: 'EMPLOYEE_CONFIRMED',
      at: employee.confirmationDate,
      dateOnly: true,
      title: 'Confirmed permanent',
      description: employee.employmentStatus
        ? EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]
        : null,
      details: [
        { label: 'Effective', value: dateLabel(employee.confirmationDate)! },
        {
          label: 'Employment stage',
          value: employee.employmentStatus
            ? EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]
            : 'Unclassified',
        },
      ],
      actorUserId: actorFor((row) => after(row).employmentStatus === 'PERMANENT'),
      link: 'Overview',
    });
  }

  // --- resignation ----------------------------------------------------------
  if (employee.status === 'RESIGNED' && employee.resignationDate) {
    events.push({
      id: 'employee:resigned',
      category: 'EMPLOYMENT',
      type: 'EMPLOYEE_RESIGNED',
      at: employee.resignationDate,
      dateOnly: true,
      title: 'Resigned',
      description: 'Resignation recorded.',
      details: [
        { label: 'Resignation date', value: dateLabel(employee.resignationDate)! },
        { label: 'Last working day', value: dateLabel(employee.terminationDate) ?? '—' },
      ],
      actorUserId: actorFor((row) => after(row).status === 'RESIGNED'),
      link: 'Overview',
    });

    // The day they actually stopped working, when it is not the day they said
    // so. Payroll and attendance both read this one, so it is worth its own row.
    const resignedDay = dateColumnToDayKey(employee.resignationDate);
    if (
      employee.terminationDate &&
      dateColumnToDayKey(employee.terminationDate) !== resignedDay
    ) {
      events.push({
        id: 'employee:last-working-day',
        category: 'EMPLOYMENT',
        type: 'EMPLOYEE_LAST_WORKING_DAY',
        at: employee.terminationDate,
        dateOnly: true,
        title: 'Last working day',
        description: null,
        details: [{ label: 'Date', value: dateLabel(employee.terminationDate)! }],
        link: 'Overview',
      });
    }
  }

  // --- termination ----------------------------------------------------------
  if (employee.status === 'TERMINATED' && employee.terminationDate) {
    events.push({
      id: 'employee:terminated',
      category: 'EMPLOYMENT',
      type: 'EMPLOYEE_TERMINATED',
      at: employee.terminationDate,
      dateOnly: true,
      title: 'Employment terminated',
      description: `${
        employee.employmentStatus
          ? EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]
          : EMPLOYEE_STATUS_LABELS.ACTIVE
      } → ${EMPLOYEE_STATUS_LABELS.TERMINATED}`,
      details: [
        { label: 'Status', value: EMPLOYEE_STATUS_LABELS.TERMINATED },
        { label: 'Termination date', value: dateLabel(employee.terminationDate)! },
      ],
      actorUserId: actorFor((row) => after(row).status === 'TERMINATED'),
      link: 'Overview',
    });
  }

  return events;
}

// ------------------------------------------------------------------- salary

/**
 * Pay history, as the paperwork and the money together.
 *
 * `EmployeeSalary` is the money - effective-dated, and what payroll reads.
 * `SalaryRevision` is the decision that opened one of those rows: what it was,
 * what it became, who signed it and why. When a salary row has a revision
 * pointing at it the revision is shown INSTEAD, never as well, because they
 * are two records of one event and showing both would read as two raises.
 */
function salaryEvents(
  salaries: SalaryRow[],
  revisions: RevisionRow[],
  currency: string,
): Draft[] {
  const events: Draft[] = [];
  const revised = new Set(revisions.map((r) => r.salaryId).filter(Boolean) as string[]);

  const ordered = [...salaries].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );

  ordered.forEach((row, index) => {
    if (revised.has(row.id)) return;

    const previous = ordered[index - 1];
    const amount = money(toNumber(row.amount), row.currency ?? currency);

    events.push({
      id: `salary:${row.id}`,
      category: 'SALARY',
      type: previous ? 'SALARY_UPDATED' : 'SALARY_CREATED',
      at: row.effectiveFrom,
      dateOnly: true,
      title: previous ? 'Salary updated' : 'Salary recorded',
      description: previous
        ? `${money(toNumber(previous.amount), previous.currency ?? currency)} → ${amount}`
        : amount,
      details: [
        ...(previous
          ? [
              {
                label: 'Previous',
                value: money(toNumber(previous.amount), previous.currency ?? currency),
              },
            ]
          : []),
        { label: 'New', value: amount },
        { label: 'Effective', value: dateLabel(row.effectiveFrom)! },
      ],
      link: 'Salary & Payroll',
    });
  });

  for (const row of revisions) {
    const from = money(toNumber(row.currentAmount), row.currency ?? currency);
    const to = money(toNumber(row.newAmount), row.currency ?? currency);
    const percent = toNumber(row.incrementPercent);

    events.push({
      id: `revision:${row.id}`,
      category: 'SALARY',
      type: 'SALARY_INCREMENT',
      at: row.effectiveDate,
      dateOnly: true,
      title: 'Salary updated',
      description: `${from} → ${to}`,
      details: [
        { label: 'Previous', value: from },
        { label: 'New', value: to },
        {
          label: 'Increase',
          value: `${money(toNumber(row.incrementAmount), row.currency ?? currency)}${percent ? ` (${NUMBER.format(percent)}%)` : ''}`,
        },
        { label: 'Effective', value: dateLabel(row.effectiveDate)! },
        { label: 'Reason', value: row.reason },
      ],
      actorUserId: row.approvedByUserId,
      // A director who signed it off by email has no login here, and the
      // record still has to say who they were.
      actorName: row.approvedByName,
      link: 'Salary & Payroll',
    });
  }

  return events;
}

// --------------------------------------------------------------- attendance

/**
 * Attendance, minus the attendance.
 *
 * Deliberately no daily records: a decade of punches is not a history, it is
 * a haystack, and every one of those days is already on the Attendance tab
 * where it can be read as a calendar. What belongs on a timeline is the days
 * somebody CHANGED - the correction requests and the corrections themselves -
 * because those have an actor, a reason and a decision.
 */
function attendanceEvents(
  requests: RegularizationRow[],
  adjustments: AdjustmentRow[],
): Draft[] {
  const events: Draft[] = [];

  for (const row of requests) {
    const day = dateLabel(row.attendanceDate)!;

    events.push({
      id: `regularization:${row.id}:requested`,
      category: 'ATTENDANCE',
      type: 'ATTENDANCE_CORRECTION_REQUESTED',
      at: row.createdAt,
      dateOnly: false,
      title: 'Attendance correction requested',
      description: day,
      details: [
        { label: 'For the day', value: day },
        { label: 'Reason', value: row.reason },
      ],
      link: 'Attendance',
    });

    if (row.status === 'APPROVED' || row.status === 'REJECTED') {
      events.push({
        id: `regularization:${row.id}:decided`,
        category: 'ATTENDANCE',
        type:
          row.status === 'APPROVED'
            ? 'ATTENDANCE_CORRECTION_APPROVED'
            : 'ATTENDANCE_CORRECTION_REJECTED',
        at: row.updatedAt,
        dateOnly: false,
        title:
          row.status === 'APPROVED'
            ? 'Attendance correction approved'
            : 'Attendance correction rejected',
        description: day,
        details: [{ label: 'For the day', value: day }],
        link: 'Attendance',
      });
    }
  }

  for (const row of adjustments) {
    const day = dateLabel(row.date)!;
    const mapping = row.kind === 'MAPPING_CHANGE';

    events.push({
      id: `adjustment:${row.id}`,
      category: 'ATTENDANCE',
      type: 'ATTENDANCE_CORRECTED',
      at: row.createdAt,
      dateOnly: false,
      title: mapping ? 'Attendance re-attributed' : 'Attendance corrected',
      description: day,
      details: [
        { label: 'For the day', value: day },
        // The NAMES of the fields that moved, never their values: the before
        // and after of a corrected day belong to the Attendance tab, which
        // shows them beside the day they describe.
        {
          label: 'Changed',
          value: row.changedFields.map(humaniseField).join(', ') || '—',
        },
        { label: 'Reason', value: row.reason },
      ],
      actorUserId: row.actorId,
      link: 'Attendance',
    });
  }

  return events;
}

// -------------------------------------------------------------------- leave

function leaveEvents(rows: LeaveRow[]): Draft[] {
  const events: Draft[] = [];

  for (const row of rows) {
    const days = toNumber(row.totalDays);
    const span =
      dateColumnToDayKey(row.startDate) === dateColumnToDayKey(row.endDate)
        ? dateLabel(row.startDate)!
        : `${dateLabel(row.startDate)} – ${dateLabel(row.endDate)}`;
    const summary = `${row.leaveType.name} · ${plural(days, 'day')}`;

    const details = [
      { label: 'Leave type', value: row.leaveType.name },
      { label: 'Dates', value: span },
      { label: 'Days', value: plural(days, 'day') },
      { label: 'Day part', value: LEAVE_DAY_PART_LABELS[row.dayPart] },
      { label: 'Reason', value: row.reason },
    ];

    events.push({
      id: `leave:${row.id}:requested`,
      category: 'LEAVE',
      type: 'LEAVE_REQUESTED',
      at: row.createdAt,
      dateOnly: false,
      title: 'Leave requested',
      description: summary,
      details,
      link: 'Leave',
    });

    if ((row.status === 'APPROVED' || row.status === 'REJECTED') && row.decidedAt) {
      events.push({
        id: `leave:${row.id}:decided`,
        category: 'LEAVE',
        type: row.status === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
        at: row.decidedAt,
        dateOnly: false,
        title: row.status === 'APPROVED' ? 'Leave approved' : 'Leave rejected',
        description: summary,
        details,
        link: 'Leave',
      });
    }

    if (row.status === 'CANCELLED' && row.cancelledAt) {
      events.push({
        id: `leave:${row.id}:cancelled`,
        category: 'LEAVE',
        type: 'LEAVE_CANCELLED',
        at: row.cancelledAt,
        dateOnly: false,
        // Attendance reconciliation cancels leave nobody withdrew; the
        // timeline says so rather than reading like a person's decision.
        title: row.cancelledBySystem ? 'Leave cancelled automatically' : 'Leave cancelled',
        description: row.cancelledBySystem && row.cancellationReason ? row.cancellationReason : summary,
        details,
        link: 'Leave',
      });
    }
  }

  return events;
}

// -------------------------------------------------------------------- loans

function loanEvents(rows: LoanRow[], currency: string): Draft[] {
  const events: Draft[] = [];

  for (const row of rows) {
    const principal = money(toNumber(row.principalAmount), row.currency ?? currency);
    const summary = `${principal} · ${plural(row.installmentCount, 'installment')}`;
    const details = [
      { label: 'Amount', value: principal },
      { label: 'Installments', value: String(row.installmentCount) },
      {
        label: 'Monthly deduction',
        value: money(toNumber(row.monthlyDeduction), row.currency ?? currency),
      },
      ...(row.purpose ? [{ label: 'Purpose', value: row.purpose }] : []),
    ];

    const add = (
      suffix: string,
      type: TimelineEventType,
      at: Date | null,
      title: string,
      extra: Array<{ label: string; value: string }> = [],
      actorUserId: string | null = null,
    ) => {
      if (!at) return;
      events.push({
        id: `loan:${row.id}:${suffix}`,
        category: 'LOAN',
        type,
        at,
        dateOnly: false,
        title,
        description: summary,
        details: [...details, ...extra],
        actorUserId,
        link: 'Loans',
      });
    };

    // An HR-created loan has no application; `createdAt` is when it was
    // recorded, and that is the honest date for one.
    // A salary advance travels the same states under its own name.
    const advance = row.kind === 'SALARY_ADVANCE';
    const noun = advance ? 'Salary advance' : 'Loan';
    add('applied', 'LOAN_APPLIED', row.requestedAt ?? row.createdAt, row.requestedAt ? `${noun} applied for` : `${noun} recorded`);
    add('approved', 'LOAN_APPROVED', row.approvedAt, `${noun} approved`, [], row.approvedByUserId);
    add(
      'rejected',
      'LOAN_REJECTED',
      row.rejectedAt,
      `${noun} rejected`,
      row.rejectionReason ? [{ label: 'Reason', value: row.rejectionReason }] : [],
    );
    add('activated', 'LOAN_ACTIVATED', row.activatedAt, advance ? 'Salary advance released' : 'Loan repayment started');
    add('completed', 'LOAN_COMPLETED', row.completedAt, advance ? 'Salary advance recovered' : 'Loan repaid');
    add('cancelled', 'LOAN_CANCELLED', row.cancelledAt, `${noun} cancelled`);
  }

  return events;
}

// ------------------------------------------------------------------ medical

/**
 * Medical claims, as amounts and decisions only.
 *
 * No diagnosis, no provider, no claimant's note - none of it is read out of
 * the database here. A claim's free text is where somebody may have described
 * a condition, and a timeline is the last place that should surface. What the
 * timeline carries is what a benefit ledger carries: a category, an amount and
 * what was decided.
 */
function medicalEvents(rows: MedicalRow[], currency: string): Draft[] {
  const events: Draft[] = [];

  for (const row of rows) {
    const requested = money(toNumber(row.requestedAmount), currency);
    const approved =
      row.approvedAmount === null ? null : money(toNumber(row.approvedAmount), currency);
    const category = MEDICAL_CATEGORY_LABELS[row.category as MedicalCategory] ?? row.category;

    const base = [
      { label: 'Category', value: category },
      { label: 'Claimed', value: requested },
    ];

    events.push({
      id: `claim:${row.id}:submitted`,
      category: 'MEDICAL',
      type: 'MEDICAL_CLAIM_SUBMITTED',
      at: row.submittedAt,
      dateOnly: false,
      title: 'Medical claim submitted',
      description: `${requested} · ${category}`,
      details: base,
      link: null,
    });

    const decided = row.decidedAt;
    if (decided && (row.status === 'APPROVED' || row.status === 'PARTIALLY_APPROVED' || row.status === 'PAID')) {
      events.push({
        id: `claim:${row.id}:decided`,
        category: 'MEDICAL',
        type: 'MEDICAL_CLAIM_APPROVED',
        at: decided,
        dateOnly: false,
        title: row.status === 'PARTIALLY_APPROVED' ? 'Medical claim part-approved' : 'Medical claim approved',
        description: `${approved ?? requested} · ${category}`,
        details: [...base, { label: 'Approved', value: approved ?? '—' }],
        actorUserId: row.reviewedByUserId,
        link: null,
      });
    }

    if (decided && row.status === 'REJECTED') {
      events.push({
        id: `claim:${row.id}:rejected`,
        category: 'MEDICAL',
        type: 'MEDICAL_CLAIM_REJECTED',
        at: decided,
        dateOnly: false,
        title: 'Medical claim rejected',
        description: `${requested} · ${category}`,
        details: base,
        actorUserId: row.reviewedByUserId,
        link: null,
      });
    }

    if (row.paidAt) {
      events.push({
        id: `claim:${row.id}:paid`,
        category: 'MEDICAL',
        type: 'MEDICAL_CLAIM_PAID',
        at: row.paidAt,
        dateOnly: false,
        title: 'Medical claim paid',
        description: `${approved ?? requested} · ${category}`,
        details: [...base, { label: 'Paid', value: approved ?? '—' }],
        actorUserId: row.paidByUserId,
        link: null,
      });
    }

    if (row.cancelledAt) {
      events.push({
        id: `claim:${row.id}:cancelled`,
        category: 'MEDICAL',
        type: 'MEDICAL_CLAIM_CANCELLED',
        at: row.cancelledAt,
        dateOnly: false,
        title: 'Medical claim withdrawn',
        description: `${requested} · ${category}`,
        details: base,
        link: null,
      });
    }
  }

  return events;
}

// -------------------------------------------------------------------- cases

function caseEvents(rows: CaseRow[]): Draft[] {
  const events: Draft[] = [];

  for (const row of rows) {
    const details = [
      { label: 'Subject', value: row.subject },
      { label: 'Queue', value: `${row.department.name} · ${row.category.name}` },
      { label: 'Status', value: CASE_STATUS_LABELS[row.status] },
    ];

    events.push({
      id: `case:${row.id}:opened`,
      category: 'CASE',
      type: 'CASE_OPENED',
      at: row.createdAt,
      dateOnly: false,
      title: 'Case opened',
      description: row.subject,
      details,
      link: null,
    });

    if (row.resolvedAt) {
      events.push({
        id: `case:${row.id}:resolved`,
        category: 'CASE',
        type: 'CASE_RESOLVED',
        at: row.resolvedAt,
        dateOnly: false,
        title: 'Case resolved',
        description: row.subject,
        details,
        link: null,
      });
    }

    if (row.closedAt) {
      events.push({
        id: `case:${row.id}:closed`,
        category: 'CASE',
        type: 'CASE_CLOSED',
        at: row.closedAt,
        dateOnly: false,
        title: 'Case closed',
        description: row.subject,
        details,
        link: null,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------- documents

/**
 * The paperwork: contracts, policy acknowledgements, and what has expired.
 *
 * There is no general employee document store in this system yet, so nothing
 * here pretends there is. A contract's `documentName` is shown when one was
 * recorded and omitted when it was not - an "Employment Contract uploaded"
 * event for a contract nobody attached a file to would be a fiction.
 */
function documentEvents(
  contracts: ContractRow[],
  policies: PolicyRow[],
  employee: EmployeeRow,
  access: Access,
  today: string,
): Draft[] {
  const events: Draft[] = [];

  for (const row of contracts) {
    const type = CONTRACT_TYPE_LABELS[row.contractType] ?? row.contractType;

    events.push({
      id: `contract:${row.id}:started`,
      category: 'DOCUMENT',
      type: 'CONTRACT_STARTED',
      at: row.startDate,
      dateOnly: true,
      title: row.documentName ? 'Contract document recorded' : 'Contract started',
      description: row.documentName ?? type,
      details: [
        { label: 'Contract type', value: type },
        { label: 'Start date', value: dateLabel(row.startDate)! },
        { label: 'End date', value: dateLabel(row.endDate) ?? 'Open-ended' },
        ...(row.reference ? [{ label: 'Reference', value: row.reference }] : []),
        ...(row.documentName ? [{ label: 'Document', value: row.documentName }] : []),
      ],
      actorUserId: row.createdBy,
      link: 'Contracts & Policies',
    });

    // Only an end date that has actually passed. A contract expiring next
    // month is a thing to act on, not a thing that happened, and it belongs on
    // the screen that chases it rather than in a history.
    if (row.endDate && dateColumnToDayKey(row.endDate) <= today) {
      events.push({
        id: `contract:${row.id}:ended`,
        category: 'DOCUMENT',
        type: 'CONTRACT_ENDED',
        at: row.endDate,
        dateOnly: true,
        title: row.status === 'TERMINATED' ? 'Contract terminated' : 'Contract expired',
        description: type,
        details: [
          { label: 'Contract type', value: type },
          { label: 'End date', value: dateLabel(row.endDate)! },
        ],
        link: 'Contracts & Policies',
      });
    }
  }

  for (const row of policies) {
    const name = `${row.policy.name} (v${row.policy.version})`;

    events.push({
      id: `policy:${row.id}:assigned`,
      category: 'DOCUMENT',
      type: 'POLICY_ASSIGNED',
      at: row.assignedAt,
      dateOnly: false,
      title: 'Policy assigned',
      description: name,
      details: [
        { label: 'Policy', value: name },
        { label: 'Due', value: dateLabel(row.dueDate) ?? 'No deadline' },
      ],
      actorUserId: row.assignedBy,
      link: 'Contracts & Policies',
    });

    if (row.acknowledgedAt && (row.status === 'ACKNOWLEDGED' || row.status === 'DECLINED')) {
      events.push({
        id: `policy:${row.id}:answered`,
        category: 'DOCUMENT',
        type: row.status === 'ACKNOWLEDGED' ? 'POLICY_ACKNOWLEDGED' : 'POLICY_DECLINED',
        at: row.acknowledgedAt,
        dateOnly: false,
        title: row.status === 'ACKNOWLEDGED' ? 'Policy acknowledged' : 'Policy declined',
        description: name,
        details: [{ label: 'Policy', value: name }],
        link: 'Contracts & Policies',
      });
    }
  }

  /*
   * Identity documents that have run out.
   *
   * Behind `employee.sensitive.read`, which is the grant that already governs
   * these columns everywhere else - and only the fact and the date, never the
   * number on the document. Past expiries only, for the same reason a contract
   * end date has to have passed.
   */
  if (access.sensitive) {
    const expiries: Array<[string, Date | null, string]> = [
      ['national-id', employee.nationalIdExpiry, 'National ID'],
      ['passport', employee.passportExpiry, 'Passport'],
      ['visa', employee.visaExpiry, 'Visa'],
    ];

    for (const [key, date, label] of expiries) {
      if (!date || dateColumnToDayKey(date) > today) continue;
      events.push({
        id: `expiry:${key}`,
        category: 'DOCUMENT',
        type: 'DOCUMENT_EXPIRED',
        at: date,
        dateOnly: true,
        title: `${label} expired`,
        description: dateLabel(date),
        details: [
          { label: 'Document', value: label },
          { label: 'Expired', value: dateLabel(date)! },
        ],
        link: 'Overview',
      });
    }
  }

  return events;
}

// ------------------------------------------------------------- the row shapes

type Amount = Prisma.Decimal | number;

interface AuditRow {
  id: string;
  action: string;
  actorId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

interface EmployeeRow {
  id: string;
  createdAt: Date;
  hireDate: Date | null;
  confirmationDate: Date | null;
  resignationDate: Date | null;
  terminationDate: Date | null;
  status: EmployeeStatus;
  employmentStatus: EmploymentStatus | null;
  employmentType: EmploymentType;
  jobTitle: string | null;
  department: { name: string } | null;
  designation: { name: string } | null;
  nationalIdExpiry: Date | null;
  passportExpiry: Date | null;
  visaExpiry: Date | null;
}

interface SalaryRow {
  id: string;
  amount: Amount;
  currency: string | null;
  effectiveFrom: Date;
}

interface RevisionRow {
  id: string;
  salaryId: string | null;
  currentAmount: Amount;
  newAmount: Amount;
  incrementAmount: Amount;
  incrementPercent: Amount;
  currency: string | null;
  effectiveDate: Date;
  reason: string;
  approvedByUserId: string | null;
  approvedByName: string | null;
}

interface RegularizationRow {
  id: string;
  attendanceDate: Date;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
}

interface AdjustmentRow {
  id: string;
  date: Date;
  kind: 'CORRECTION' | 'MAPPING_CHANGE';
  changedFields: string[];
  reason: string;
  actorId: string | null;
  createdAt: Date;
}

interface LeaveRow {
  id: string;
  startDate: Date;
  endDate: Date;
  dayPart: 'FULL_DAY' | 'FIRST_HALF' | 'SECOND_HALF';
  totalDays: Amount;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  createdAt: Date;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBySystem?: boolean;
  cancellationReason?: string | null;
  leaveType: { name: string };
}

interface LoanRow {
  kind: 'LOAN' | 'SALARY_ADVANCE';
  id: string;
  principalAmount: Amount;
  monthlyDeduction: Amount;
  currency: string | null;
  installmentCount: number;
  purpose: string | null;
  createdAt: Date;
  requestedAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  activatedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
}

interface MedicalRow {
  id: string;
  category: string;
  requestedAmount: Amount;
  approvedAmount: Amount | null;
  status: 'PENDING' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'CANCELLED' | 'PAID';
  submittedAt: Date;
  decidedAt: Date | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  reviewedByUserId: string | null;
  paidByUserId: string | null;
}

interface CaseRow {
  id: string;
  subject: string;
  status: keyof typeof CASE_STATUS_LABELS;
  createdAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  department: { name: string };
  category: { name: string };
}

interface ContractRow {
  id: string;
  contractType: keyof typeof CONTRACT_TYPE_LABELS;
  status: string;
  reference: string | null;
  startDate: Date;
  endDate: Date | null;
  documentName: string | null;
  createdBy: string | null;
}

interface PolicyRow {
  id: string;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'DECLINED';
  assignedAt: Date;
  assignedBy: string | null;
  acknowledgedAt: Date | null;
  dueDate: Date | null;
  policy: { name: string; version: string };
}

// ------------------------------------------------------------ name resolution

interface NameBook {
  user: Map<string, string>;
  employee: Map<string, string>;
  department: Map<string, string>;
  team: Map<string, string>;
  designation: Map<string, string>;
  location: Map<string, string>;
}

const emptyNameBook = (): NameBook => ({
  user: new Map(),
  employee: new Map(),
  department: new Map(),
  team: new Map(),
  designation: new Map(),
  location: new Map(),
});

/** Every id an employment diff points at, bucketed by what it points at. */
function referencedIds(rows: AuditRow[]): Record<string, Set<string>> {
  const buckets: Record<string, Set<string>> = {
    departmentId: new Set(),
    teamId: new Set(),
    designationId: new Set(),
    locationId: new Set(),
    managerId: new Set(),
  };

  for (const row of rows) {
    for (const side of [row.before, row.after]) {
      const diff = (side ?? {}) as Record<string, unknown>;
      for (const field of Object.keys(buckets)) {
        const value = diff[field];
        if (typeof value === 'string' && value.length > 0) buckets[field]!.add(value);
      }
      // Both manager columns resolve against the same employee table.
      const secondary = diff.secondaryManagerId;
      if (typeof secondary === 'string' && secondary.length > 0) {
        buckets.managerId!.add(secondary);
      }
    }
  }

  return buckets;
}

/** The organisation names an employment diff needs, in one round of queries. */
async function resolveReferenceNames(
  companyId: string,
  rows: AuditRow[],
): Promise<NameBook> {
  const book = emptyNameBook();
  const ids = referencedIds(rows);

  const list = (key: string) => [...ids[key]!];
  const anything = Object.values(ids).some((set) => set.size > 0);
  if (!anything) return book;

  const [departments, teams, designations, locations, employees] = await Promise.all([
    ids.departmentId!.size
      ? prisma.department.findMany({
          where: { companyId, id: { in: list('departmentId') } },
          select: { id: true, name: true },
        })
      : [],
    ids.teamId!.size
      ? prisma.team.findMany({
          where: { companyId, id: { in: list('teamId') } },
          select: { id: true, name: true },
        })
      : [],
    ids.designationId!.size
      ? prisma.designation.findMany({
          where: { companyId, id: { in: list('designationId') } },
          select: { id: true, name: true },
        })
      : [],
    ids.locationId!.size
      ? prisma.location.findMany({
          where: { companyId, id: { in: list('locationId') } },
          select: { id: true, name: true },
        })
      : [],
    ids.managerId!.size
      ? prisma.employee.findMany({
          where: { companyId, id: { in: list('managerId') } },
          select: { id: true, firstName: true, lastName: true, displayName: true },
        })
      : [],
  ]);

  for (const row of departments) book.department.set(row.id, row.name);
  for (const row of teams) book.team.set(row.id, row.name);
  for (const row of designations) book.designation.set(row.id, row.name);
  for (const row of locations) book.location.set(row.id, row.name);
  for (const row of employees) {
    book.employee.set(row.id, row.displayName ?? `${row.firstName} ${row.lastName}`.trim());
  }

  return book;
}

/**
 * Actor names, resolved once for every source at the end.
 *
 * The employee's own name is preferred over the account's, because "Ayesha
 * Khan" is who people know and the login may be spelled differently. The email
 * is the last resort and never an id - an id on screen tells a reader nothing
 * and tells a curious one something.
 */
async function resolveActorNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      employee: { select: { firstName: true, lastName: true, displayName: true } },
    },
  });

  return new Map(
    users.map((user) => {
      const employee = user.employee;
      const fromEmployee = employee
        ? (employee.displayName ?? `${employee.firstName} ${employee.lastName}`.trim())
        : '';
      return [
        user.id,
        fromEmployee || `${user.firstName} ${user.lastName}`.trim() || user.email,
      ];
    }),
  );
}

// ----------------------------------------------------------------- the cursor

const encodeCursor = (key: string): string => Buffer.from(key, 'utf8').toString('base64url');

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded.includes('|') ? decoded : null;
  } catch {
    return null;
  }
}

/** Sorted-order position of an event. ISO is fixed-width, so this compares. */
const sortKey = (event: { occurredAt: string; id: string }): string =>
  `${event.occurredAt}|${event.id}`;

// -------------------------------------------------------------- the endpoint

/**
 * One employee's timeline, filtered, sorted and paged.
 *
 * Every source is read, merged and sorted BEFORE anything is paged. Paging
 * each source separately would be cheaper and wrong: the twentieth event
 * overall is not the twentieth event of any one module, and a chatty module
 * would push a quiet one off the end of the list rather than further down it.
 *
 * The caller is expected to have established scope already; nothing here is a
 * substitute for `assertEmployeeInScope`.
 */
export async function employeeTimeline(
  auth: AuthContext,
  employeeId: string,
  query: EmployeeTimelineQuery,
): Promise<EmployeeTimelinePage> {
  const [employee, company, access] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, companyId: auth.companyId },
      select: {
        id: true,
        createdAt: true,
        hireDate: true,
        confirmationDate: true,
        resignationDate: true,
        terminationDate: true,
        status: true,
        employmentStatus: true,
        employmentType: true,
        jobTitle: true,
        department: { select: { name: true } },
        designation: { select: { name: true } },
        nationalIdExpiry: true,
        passportExpiry: true,
        visaExpiry: true,
      },
    }) as Promise<EmployeeRow | null>,
    prisma.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { currency: true, timezone: true },
    }),
    resolveAccess(auth, employeeId),
  ]);

  if (!employee) {
    // The route checks existence first; this is the belt to that braces.
    return emptyPage(query);
  }

  const sources: Sources = { currency: company.currency, timezone: company.timezone };
  const today = todayInZone(sources.timezone);
  const scope = { companyId: auth.companyId, employeeId };
  const cases = access.cases ? await caseFilter(auth, employeeId) : null;

  const [
    auditRows,
    salaries,
    revisions,
    regularizations,
    adjustments,
    leaveRows,
    loans,
    claims,
    caseRows,
    contracts,
    policies,
  ] = await Promise.all([
    prisma.auditLog.findMany({
      where: { companyId: auth.companyId, entityType: 'Employee', entityId: employeeId },
      orderBy: { createdAt: 'desc' },
      take: SOURCE_LIMIT,
      select: { id: true, action: true, actorId: true, before: true, after: true, createdAt: true },
    }) as Promise<AuditRow[]>,

    access.salary
      ? (prisma.employeeSalary.findMany({
          where: scope,
          orderBy: { effectiveFrom: 'desc' },
          take: SOURCE_LIMIT,
          select: { id: true, amount: true, currency: true, effectiveFrom: true },
        }) as Promise<SalaryRow[]>)
      : [],
    access.salary
      ? (prisma.salaryRevision.findMany({
          where: scope,
          orderBy: { effectiveDate: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            salaryId: true,
            currentAmount: true,
            newAmount: true,
            incrementAmount: true,
            incrementPercent: true,
            currency: true,
            effectiveDate: true,
            reason: true,
            approvedByUserId: true,
            approvedByName: true,
          },
        }) as Promise<RevisionRow[]>)
      : [],

    access.attendance
      ? (prisma.attendanceRegularizationRequest.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            attendanceDate: true,
            reason: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        }) as Promise<RegularizationRow[]>)
      : [],
    access.attendance
      ? (prisma.attendanceAdjustment.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            date: true,
            kind: true,
            changedFields: true,
            reason: true,
            actorId: true,
            createdAt: true,
          },
        }) as Promise<AdjustmentRow[]>)
      : [],

    access.leave
      ? (prisma.leaveRequest.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            startDate: true,
            endDate: true,
            dayPart: true,
            totalDays: true,
            reason: true,
            status: true,
            createdAt: true,
            decidedAt: true,
            cancelledAt: true,
            cancelledBySystem: true,
            cancellationReason: true,
            leaveType: { select: { name: true } },
          },
        }) as Promise<LeaveRow[]>)
      : [],

    access.loan
      ? (prisma.employeeLoan.findMany({
          where: scope,
          orderBy: { createdAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            kind: true,
            principalAmount: true,
            monthlyDeduction: true,
            currency: true,
            installmentCount: true,
            purpose: true,
            createdAt: true,
            requestedAt: true,
            approvedAt: true,
            approvedByUserId: true,
            rejectedAt: true,
            rejectionReason: true,
            activatedAt: true,
            completedAt: true,
            cancelledAt: true,
          },
        }) as Promise<LoanRow[]>)
      : [],

    access.medical
      ? (prisma.medicalClaim.findMany({
          where: scope,
          orderBy: { submittedAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            category: true,
            requestedAmount: true,
            approvedAmount: true,
            status: true,
            submittedAt: true,
            decidedAt: true,
            paidAt: true,
            cancelledAt: true,
            reviewedByUserId: true,
            paidByUserId: true,
          },
        }) as Promise<MedicalRow[]>)
      : [],

    cases
      ? (prisma.case.findMany({
          where: cases,
          orderBy: { createdAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            subject: true,
            status: true,
            createdAt: true,
            resolvedAt: true,
            closedAt: true,
            department: { select: { name: true } },
            category: { select: { name: true } },
          },
        }) as Promise<CaseRow[]>)
      : [],

    access.contracts
      ? (prisma.employeeContract.findMany({
          where: scope,
          orderBy: { startDate: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            contractType: true,
            status: true,
            reference: true,
            startDate: true,
            endDate: true,
            documentName: true,
            createdBy: true,
          },
        }) as Promise<ContractRow[]>)
      : [],
    access.policies
      ? (prisma.employeePolicyAssignment.findMany({
          where: scope,
          orderBy: { assignedAt: 'desc' },
          take: SOURCE_LIMIT,
          select: {
            id: true,
            status: true,
            assignedAt: true,
            assignedBy: true,
            acknowledgedAt: true,
            dueDate: true,
            policy: { select: { name: true, version: true } },
          },
        }) as Promise<PolicyRow[]>)
      : [],
  ]);

  const names = await resolveReferenceNames(auth.companyId, auditRows);

  const drafts: Draft[] = [
    ...milestoneEvents(employee, auditRows, access, today),
    ...employmentChangeEvents(auditRows, names, employee, access),
    ...salaryEvents(salaries, revisions, sources.currency),
    ...attendanceEvents(regularizations, adjustments),
    ...leaveEvents(leaveRows),
    ...loanEvents(loans, sources.currency),
    ...medicalEvents(claims, sources.currency),
    ...caseEvents(caseRows),
    ...documentEvents(contracts, policies, employee, access, today),
  ];

  const actorIds = [
    ...new Set(
      drafts
        .map((draft) => draft.actorUserId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const actors = await resolveActorNames(actorIds);

  const events: TimelineEvent[] = drafts.map((draft) => {
    const day = draft.dateOnly
      ? dateColumnToDayKey(draft.at)
      : dayKeyInZone(draft.at, sources.timezone);

    return {
      id: draft.id,
      category: draft.category,
      type: draft.type,
      occurredAt: draft.at.toISOString(),
      day,
      year: Number(day.slice(0, 4)),
      dateOnly: draft.dateOnly,
      title: draft.title,
      description: draft.description,
      details: draft.details,
      // The stored name wins: it is the one the record was signed with, and it
      // exists for approvers who never had a login here at all.
      actorName:
        draft.actorName ??
        (draft.actorUserId ? (actors.get(draft.actorUserId) ?? null) : null),
      link: draft.link,
    };
  });

  /*
   * The chips describe the whole timeline, not the current view. Recomputing
   * them from the filtered set would make the year a reader just selected the
   * only year on offer, which is a trap rather than a filter.
   */
  const years = [...new Set(events.map((event) => event.year))].sort((a, b) => b - a);
  const present = new Set(events.map((event) => event.category));
  const categories = TIMELINE_CATEGORIES.filter((category) => present.has(category));

  const filtered = events.filter(
    (event) =>
      (!query.category || event.category === query.category) &&
      (!query.year || event.year === query.year),
  );

  const ascending = query.order === 'asc';
  filtered.sort((a, b) => {
    const left = sortKey(a);
    const right = sortKey(b);
    if (left === right) return 0;
    return ascending ? (left < right ? -1 : 1) : left > right ? -1 : 1;
  });

  const cursorKey = decodeCursor(query.cursor);
  const after = cursorKey
    ? filtered.filter((event) =>
        ascending ? sortKey(event) > cursorKey : sortKey(event) < cursorKey,
      )
    : filtered;

  const page = after.slice(0, query.limit);
  const hasMore = after.length > page.length;
  const last = page[page.length - 1];

  return {
    data: page,
    meta: {
      limit: query.limit,
      order: query.order,
      total: filtered.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(sortKey(last)) : null,
      years,
      categories,
    },
  };
}

/** What a caller gets for an employee with nothing readable behind them. */
function emptyPage(query: EmployeeTimelineQuery): EmployeeTimelinePage {
  return {
    data: [],
    meta: {
      limit: query.limit,
      order: query.order,
      total: 0,
      hasMore: false,
      nextCursor: null,
      years: [],
      categories: [],
    },
  };
}
