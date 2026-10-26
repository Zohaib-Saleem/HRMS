import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * Employee cases: the helpdesk.
 *
 * Somebody's payslip is wrong, their laptop will not boot, their leave balance
 * looks short, the air conditioning in the meeting room has been off for a
 * week. None of those is a request for a DECISION, which is what every other
 * module in this product models - a leave request, a loan application and a
 * medical claim all end in somebody saying yes or no. A case ends in somebody
 * DOING something, and then in a conversation about whether it is actually
 * done.
 *
 * That difference is why cases do not go through the shared approval engine.
 * An approval has one shape - request, route to an approver, decide, finish -
 * and a case has none of it: there is no approver, the thing being asked for
 * is work rather than permission, and the interesting state ("we are looking at
 * it", "we are waiting on you", "we are waiting on a part") lives between
 * "raised" and "finished" rather than at either end. Forcing that through an
 * approval chain would have produced a queue of PENDING approvals nobody could
 * act on and a conversation with nowhere to live.
 *
 * There are two sides to this module and they are two sets of endpoints, two
 * sets of grants and two screens, not one of each with a flag. The REQUESTER
 * raises a case, watches it, replies to it and reopens it, and every query on
 * that side is pinned to their own employee record. The DESK reads a queue,
 * assigns, moves a case through the workflow, answers the requester and writes
 * notes the requester never sees. Nothing on the requester's side widens when
 * somebody holds a desk grant, and nothing on the desk's side is reachable
 * without one.
 *
 * The vocabulary below is shared by both, which is the point of it being here:
 * the transition map that decides what the desk may do is the same map that
 * refuses a requester's reopen, so the two sides cannot drift into disagreeing
 * about what a case is allowed to do next.
 */

// --- priority ----------------------------------------------------------------

export const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export type CasePriority = (typeof CASE_PRIORITIES)[number];

/** What an employee picks when they raise a case, unless they say otherwise. */
export const DEFAULT_CASE_PRIORITY: CasePriority = 'NORMAL';

export const CASE_PRIORITY_LABELS: Record<CasePriority, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

/**
 * What each priority is actually for, in the requester's own terms.
 *
 * Written as consequences rather than as adjectives. "High" means nothing on
 * its own and everybody picks it; "my work is blocked" is a question somebody
 * can answer honestly about their own day.
 */
export const CASE_PRIORITY_DESCRIPTIONS: Record<CasePriority, string> = {
  LOW: 'A question or a small annoyance. Nothing is blocked.',
  NORMAL: 'Ordinary. Needs attention but the day works around it.',
  HIGH: 'Your work is blocked, or a deadline is at risk.',
  URGENT: 'Nobody can work, or money or safety is involved.',
};

/** Most urgent first. The order a queue is worked in, and the order shown. */
export const CASE_PRIORITY_RANK: Record<CasePriority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

// --- status ------------------------------------------------------------------

export const CASE_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING',
  'ON_HOLD',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  PENDING: 'Pending',
  ON_HOLD: 'On hold',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
};

/**
 * What each status means, written from the requester's side of the desk.
 *
 * PENDING and ON_HOLD are the pair worth being careful about, because they are
 * the two that look identical on a list and mean opposite things about whose
 * move it is. PENDING is waiting on the REQUESTER - an answer, a screenshot, a
 * decision only they can make - and is the one state where the case will not
 * move until they do something. ON_HOLD is waiting on anything else: a part on
 * order, a vendor, a change window. Collapsing them into one "waiting" status
 * loses exactly the fact somebody opening their case list wants to know.
 */
export const CASE_STATUS_DESCRIPTIONS: Record<CaseStatus, string> = {
  OPEN: 'Raised and waiting to be picked up.',
  IN_PROGRESS: 'Somebody is working on it.',
  PENDING: 'Waiting on you. Reply and it moves again.',
  ON_HOLD: 'Paused on something outside the team - a part, a vendor, a change window.',
  RESOLVED: 'Done, as far as the team can tell. Reopen it if it is not.',
  CLOSED: 'Finished and filed.',
  REOPENED: 'It came back. Being looked at again.',
};

/** Statuses where the case is still somebody's problem. */
export const CASE_LIVE_STATUSES: readonly CaseStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'PENDING',
  'ON_HOLD',
  'REOPENED',
];

/** Statuses where the work is over. Only a reopen moves a case out of these. */
export const CASE_SETTLED_STATUSES: readonly CaseStatus[] = ['RESOLVED', 'CLOSED'];

/**
 * The whole workflow, as the only statement of it anywhere.
 *
 * One map, both sides of the desk. The requester exercises exactly one edge of
 * it - reopening their own settled case - and the desk exercises the rest, but
 * neither has its own copy: a transition absent from here is refused by the
 * server whoever asks for it, and a button that offers one is drawn from this
 * map rather than from a list beside it.
 *
 * CLOSED is deliberately not terminal. A case that was closed and turns out not
 * to be fixed is the commonest complaint about every helpdesk ever built, and
 * making the employee raise a second case to say so loses the history of the
 * first. So CLOSED -> REOPENED exists, and it is the employee's own to use.
 */
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  OPEN: ['IN_PROGRESS', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'],
  PENDING: ['IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED'],
  ON_HOLD: ['IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  CLOSED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS', 'PENDING', 'ON_HOLD', 'RESOLVED', 'CLOSED'],
};

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The statuses an employee may move their OWN case to, and from where.
 *
 * A strict subset of the map above, because holding `case.reopen.own` must not
 * become a way to mark your own case resolved or to take it off somebody's
 * queue. Reopening is the only transition that is the requester's to make:
 * they are the only person who can tell whether the thing is actually fixed.
 */
export const CASE_REQUESTER_TRANSITIONS: Partial<Record<CaseStatus, readonly CaseStatus[]>> = {
  RESOLVED: ['REOPENED'],
  CLOSED: ['REOPENED'],
};

export function canRequesterTransition(from: CaseStatus, to: CaseStatus): boolean {
  return (CASE_REQUESTER_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Whether the requester may still add a reply.
 *
 * Everything but CLOSED. A RESOLVED case is deliberately still open to a reply,
 * because "that did not fix it" is the most useful thing anybody says on a
 * helpdesk and making them reopen the case first buries it. A CLOSED case is
 * filed, and the way back in is to reopen it - which is a status change, is
 * audited as one, and puts the case back on a queue rather than adding a
 * message to something nobody is watching.
 *
 * Shared so the button and the endpoint cannot disagree about it.
 */
export function canRequesterReply(status: CaseStatus): boolean {
  return status !== 'CLOSED';
}

/** Whether the requester may reopen it - the one transition that is theirs. */
export function canRequesterReopen(status: CaseStatus): boolean {
  return (CASE_SETTLED_STATUSES as readonly CaseStatus[]).includes(status);
}

// --- the category catalogue --------------------------------------------------

/**
 * Where a case is routed, in two levels under an EXISTING department.
 *
 * The department is never typed and never invented here: it is a row in the
 * company's own `departments` table, the same row the employee's record points
 * at and the same row the org chart draws. A helpdesk that kept its own list of
 * departments would drift from the real one within a release, and "IT" on a
 * case would stop meaning the IT department.
 *
 * Category and subcategory are ordinary configuration rows, not an enum and not
 * a constant in the frontend. Every company's helpdesk is shaped like its own
 * company: one runs Payroll and Reimbursement as separate queues, another has
 * one Finance queue and does not want the choice on the form at all. The
 * catalogue below is a STARTING POINT that the seeder writes once; an
 * administrator then edits, adds and retires rows on the catalogue screen, and
 * nothing in the web app has an opinion about what the list contains.
 */

/**
 * The first level of routing. Wrapped in an object rather than left as a bare
 * tree so a subcategory can carry its own description later without changing
 * the shape callers destructure.
 */
export interface CaseCategorySeed {
  name: string;
  description?: string;
  subcategories: readonly string[];
}

export interface CaseDepartmentCatalogueSeed {
  /**
   * Which department this belongs to, matched against the company's own
   * department names case-insensitively.
   *
   * A list rather than one name because the same function goes by different
   * names in different companies - "HR", "People Operations" and "Human
   * Resources" are one department - and because matching is the ONLY way a
   * default catalogue can attach itself to departments it did not create. A
   * department that matches nothing here simply starts with no categories, and
   * an administrator gives it some.
   */
  departmentAliases: readonly string[];
  categories: readonly CaseCategorySeed[];
}

/**
 * The catalogue a new installation starts with.
 *
 * Deliberately conservative: four departments and the queues almost every
 * company has, with nothing invented that an administrator would immediately
 * have to delete. Seeding is additive and idempotent - it never edits or
 * removes a row somebody has changed, because the moment this list is treated
 * as the truth rather than as a starting point, an administrator's edit is
 * silently undone on the next deploy.
 */
export const DEFAULT_CASE_CATEGORY_CATALOGUE: readonly CaseDepartmentCatalogueSeed[] = [
  {
    departmentAliases: ['HR', 'Human Resources', 'People', 'People Operations', 'People Ops'],
    categories: [
      {
        name: 'Attendance & Leaves',
        description: 'Missing punches, wrong attendance, leave balances and applications.',
        subcategories: ['Missing punch', 'Attendance correction', 'Leave balance', 'Leave request'],
      },
      {
        name: 'Employment',
        description: 'Contracts, probation, transfers and anything about the job itself.',
        subcategories: ['Contract', 'Probation & confirmation', 'Transfer', 'Resignation'],
      },
      {
        name: 'Documents',
        description: 'Letters, certificates and copies of paperwork.',
        subcategories: ['Experience letter', 'Salary certificate', 'Personal records'],
      },
      {
        name: 'General HR',
        description: 'Anything else for the HR team.',
        subcategories: [],
      },
    ],
  },
  {
    departmentAliases: ['Finance', 'Accounts', 'Accounting'],
    categories: [
      {
        name: 'Salary',
        description: 'What was paid, and whether it was right.',
        subcategories: ['Salary not received', 'Incorrect amount', 'Deduction query'],
      },
      {
        name: 'Payroll',
        description: 'Payslips, tax and the payroll run itself.',
        subcategories: ['Payslip', 'Tax deduction', 'Bank details'],
      },
      {
        name: 'Loan',
        description: 'Loans and salary advances.',
        subcategories: ['Loan application', 'Installment query', 'Early settlement'],
      },
      {
        name: 'Reimbursement',
        description: 'Money spent and being claimed back.',
        subcategories: ['Travel', 'Medical', 'Other expense'],
      },
    ],
  },
  {
    departmentAliases: ['IT', 'Information Technology', 'Technology', 'IT Support'],
    categories: [
      {
        name: 'Email',
        description: 'Mailboxes, distribution lists and mail that will not send.',
        subcategories: ['Cannot sign in', 'Mailbox full', 'New mailbox'],
      },
      {
        name: 'Computer / Laptop',
        description: 'The machine itself.',
        subcategories: ['Will not start', 'Slow or crashing', 'Hardware replacement', 'New machine'],
      },
      {
        name: 'Internet',
        description: 'Connectivity, Wi-Fi and the VPN.',
        subcategories: ['No connection', 'Slow connection', 'VPN'],
      },
      {
        name: 'Software',
        description: 'Applications and licences.',
        subcategories: ['Installation', 'Licence', 'Error or bug'],
      },
      {
        name: 'Account Access',
        description: 'Passwords and permissions for company systems.',
        subcategories: ['Password reset', 'New account', 'Permission change'],
      },
    ],
  },
  {
    departmentAliases: ['Admin', 'Administration', 'Facilities', 'Office Administration'],
    categories: [
      {
        name: 'Office Facilities',
        description: 'The building, the desks and everything in them.',
        subcategories: ['Air conditioning', 'Electricity', 'Water', 'Cleaning', 'Furniture'],
      },
      {
        name: 'Transport',
        description: 'Company transport and travel arrangements.',
        subcategories: ['Pick and drop', 'Vehicle booking', 'Fuel'],
      },
      {
        name: 'Parking',
        description: 'Parking allocation and access.',
        subcategories: ['Parking slot', 'Access card'],
      },
      {
        name: 'Maintenance',
        description: 'Something is broken and needs fixing.',
        subcategories: ['Repair request', 'Preventive maintenance'],
      },
    ],
  },
];

/** One selectable subcategory, as the create form receives it. */
export interface CaseSubcategoryOption {
  id: string;
  name: string;
  description: string | null;
}

/** One selectable category, with whatever subcategories sit under it. */
export interface CaseCategoryOption {
  id: string;
  name: string;
  description: string | null;
  subcategories: CaseSubcategoryOption[];
}

/**
 * The create form's entire vocabulary, in one request.
 *
 * Departments come from the company's own department rows, and only those with
 * at least one active category appear: a department nobody has given a queue to
 * cannot receive a case, and offering it would produce a form that fails on
 * submit. The web app renders whatever is in here and knows none of the names.
 */
export interface CaseDepartmentCatalogue {
  departmentId: string;
  departmentName: string;
  categories: CaseCategoryOption[];
}

// --- attachments -------------------------------------------------------------

/**
 * What may be attached to a case.
 *
 * Every type here can be identified from the file's own leading bytes, or - for
 * the two text types - proven to be text. That is the whole selection rule, and
 * it is deliberately narrow for a first release: an upload endpoint that
 * accepts a format it cannot verify is an upload endpoint that accepts
 * anything, whatever the Content-Type header claimed. Office documents are ZIP
 * containers and a ZIP header proves nothing about what is inside, so they are
 * left to a later phase that can look properly rather than waved through now.
 */
export const CASE_ATTACHMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
] as const;

export type CaseAttachmentContentType = (typeof CASE_ATTACHMENT_CONTENT_TYPES)[number];

export const CASE_ATTACHMENT_EXTENSIONS: Record<CaseAttachmentContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** Shown to the person choosing a file, so a refusal is never a surprise. */
export const CASE_ATTACHMENT_TYPE_LABELS = 'JPEG, PNG, WebP, PDF, TXT or CSV';

export const CASE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * How many files one case may carry in total, replies included.
 *
 * A limit rather than none, because an unbounded count is a way to fill a disk
 * one 10 MB file at a time from an ordinary employee account.
 */
export const CASE_ATTACHMENT_MAX_PER_CASE = 20;

export const CASE_ATTACHMENT_TOO_LARGE_MESSAGE =
  'That file is larger than 10 MB. Attach a smaller one.';

export const CASE_ATTACHMENT_UNSUPPORTED_MESSAGE = `That file type cannot be attached. Use ${CASE_ATTACHMENT_TYPE_LABELS}.`;

export const CASE_ATTACHMENT_TOO_MANY_MESSAGE = `A case can carry ${CASE_ATTACHMENT_MAX_PER_CASE} attachments. Remove one before adding another.`;

/**
 * The stored name of an uploaded file, as it is safe to show and to send back.
 *
 * A filename is the one part of an upload that is written entirely by whoever
 * made the request, so it is treated as a LABEL and never as a path: the object
 * key it is stored under is generated server-side from a UUID and owes nothing
 * to this value. What survives here is the display name, with every directory
 * separator, control character and leading dot removed, because those are what
 * turn a label into a traversal or into a file the operating system hides.
 *
 * Shared so the browser shows the same name the server will keep, rather than
 * the one the user picked and then finding they disagree.
 */
export function safeAttachmentName(raw: string, fallback = 'attachment'): string {
  const cleaned = raw
    // Control characters. They have no business in a name, and a newline in
    // one is how a header injection gets into `Content-Disposition`.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Path separators, and the characters Windows refuses in a filename.
    // Turned into a hyphen rather than dropped, so `a/b.pdf` stays legible
    // as `a-b.pdf` instead of silently becoming `ab.pdf`.
    .replace(/[\\/:*?"<>|]/g, '-')
    // Runs of either collapse, so a Windows path does not come out peppered
    // with `--` where its drive letter and separators used to be.
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    // Nothing decorative at either end. A leading dot makes a dotfile, a
    // trailing one is a Windows landmine, and a leading hyphen is what is
    // left of `../../` once the separators have gone.
    .replace(/^[\s.-]+/, '')
    .replace(/[\s.-]+$/, '');

  if (cleaned.length === 0) return fallback;
  return cleaned.length > 150 ? cleaned.slice(0, 150) : cleaned;
}

export interface CaseAttachmentRecord {
  id: string;
  /** Null when the file was attached to the case rather than to a reply. */
  messageId: string | null;
  fileName: string;
  contentType: CaseAttachmentContentType;
  sizeBytes: number;
  uploadedByName: string | null;
  createdAt: string;
}

/**
 * Where an attachment is fetched from.
 *
 * Built here so the browser never assembles an API path out of ids by hand,
 * and so the case id always travels with the attachment id - the download route
 * checks BOTH against the caller's own cases, and a URL shape that made the
 * case id optional would be an invitation to drop it.
 */
export function caseAttachmentUrl(caseId: string, attachmentId: string): string {
  return `/api/v1/cases/${encodeURIComponent(caseId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

// --- the case number ---------------------------------------------------------

/** `CASE-2026-000001`. */
export const CASE_NUMBER_PREFIX = 'CASE-';

export const CASE_NUMBER_SEQUENCE_DIGITS = 6;

/**
 * The reference people quote, built from the year and a per-company sequence.
 *
 * Not the id. The id is a cuid, which is correct for a primary key and useless
 * to a human being reading it aloud down a phone line - and a case number is
 * read aloud constantly. The year in the middle is what makes it recognisable
 * a year later, and the sequence restarts with it, so the number stays short
 * for as long as the installation lives.
 */
export function formatCaseNumber(year: number, sequence: number): string {
  return `${CASE_NUMBER_PREFIX}${year}-${String(sequence).padStart(CASE_NUMBER_SEQUENCE_DIGITS, '0')}`;
}

/** The `CASE-2026-` part, which is what a "highest so far" query matches on. */
export function caseNumberYearPrefix(year: number): string {
  return `${CASE_NUMBER_PREFIX}${year}-`;
}

/**
 * Reads the sequence back out of a case number, or null if it is not one.
 *
 * Used by the generator to find the highest number issued this year, which is
 * why it is strict: a row whose number does not parse is skipped rather than
 * guessed at, so one hand-edited value cannot reset the sequence.
 */
export function parseCaseNumberSequence(caseNumber: string, year: number): number | null {
  const prefix = caseNumberYearPrefix(year);
  if (!caseNumber.startsWith(prefix)) return null;
  const suffix = caseNumber.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number.parseInt(suffix, 10);
}

// --- writing --------------------------------------------------------------

const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, `Keep this under ${max} characters.`);

/**
 * Raising a case.
 *
 * There is no employee id in here, and that is the whole of the employee-side
 * security story for creation: a case is raised BY the caller FOR the caller,
 * resolved from the session, and there is no field an employee could set to
 * become somebody else. A desk-side "raise on behalf of" would be a separate
 * endpoint with its own permission rather than an optional field on this one -
 * an optional field is exactly how that permission gets forgotten.
 *
 * `departmentId` and `categoryId` are ids, never names. The server re-reads
 * both and refuses a category that does not belong to the named department, so
 * a hand-built POST cannot file an IT case against the Finance queue.
 */
export const caseCreateSchema = z.object({
  departmentId: trimmed(1, 64, 'Choose which department this is for.'),
  categoryId: trimmed(1, 64, 'Choose what this is about.'),
  /** Optional: plenty of categories have no subcategories at all. */
  subcategoryId: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  subject: trimmed(3, 200, 'Give it a short subject line.'),
  description: trimmed(10, 5000, 'Describe what is happening, in a sentence or two.'),
  priority: z.enum(CASE_PRIORITIES).default(DEFAULT_CASE_PRIORITY),
});

export type CaseCreateInput = z.infer<typeof caseCreateSchema>;

/**
 * A reply on a case.
 *
 * `internal` is absent by design. An internal note is a message the requester
 * must never see, and the endpoint an employee posts to writes `isInternal =
 * false` unconditionally rather than reading a flag off the body - so there is
 * no payload that turns an employee's reply into a note. The desk's own reply
 * schema, `caseDeskReplySchema` below, is where that flag lives, behind its own
 * grant and its own endpoint.
 */
export const caseReplySchema = z.object({
  message: trimmed(1, 5000, 'Write something before sending.'),
});

export type CaseReplyInput = z.infer<typeof caseReplySchema>;

/** Reopening a settled case. The reason becomes the first message on it again. */
export const caseReopenSchema = z.object({
  reason: trimmed(3, 2000, 'Say what is still wrong.'),
});

export type CaseReopenInput = z.infer<typeof caseReopenSchema>;

// --- reading -----------------------------------------------------------------

/**
 * The case list's query.
 *
 * Every filter here is applied by the database, and the shape is why: an
 * employee with four years of cases must not have them all sent to the browser
 * so it can hide most of them. `q` searches the case number and the subject -
 * not the description and not the conversation, which would make the index
 * useless and would let a search term confirm the contents of a case.
 */
export const caseQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CASE_STATUSES).optional(),
  priority: z.enum(CASE_PRIORITIES).optional(),
  departmentId: z.string().trim().max(64).optional(),
  categoryId: z.string().trim().max(64).optional(),
  /** Raised on or after this day, inclusive. */
  from: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-MM-dd date.')
    .optional(),
  /** Raised on or before this day, inclusive - the whole of that day. */
  to: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-MM-dd date.')
    .optional(),
});

export type CaseQuery = z.infer<typeof caseQuerySchema>;

/** Columns a case list may be ordered by. Anything else falls back. */
export const CASE_SORT_FIELDS = ['createdAt', 'updatedAt', 'priority', 'status'] as const;

export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

/** One row of the case list. Denormalised names, because a list shows names. */
export interface CaseRecord {
  id: string;
  caseNumber: string;
  subject: string;

  departmentId: string;
  departmentName: string;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;

  priority: CasePriority;
  status: CaseStatus;

  requesterEmployeeId: string;
  requesterName: string;
  requesterEmployeeNumber: string;

  /** Null until somebody on the desk picks it up. */
  assignedUserId: string | null;
  assignedToName: string | null;
  /** When the current assignee was given the case. Null while unassigned. */
  assignedAt: string | null;

  /** How many replies the caller can actually see. Internal notes excluded. */
  messageCount: number;
  attachmentCount: number;

  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;

  /** Decided server-side from the caller's permissions, never in the browser. */
  canReply: boolean;
  canReopen: boolean;
  canAttach: boolean;
}

export interface CaseMessageRecord {
  id: string;
  /**
   * Null for a message the system wrote about itself - a status change, say.
   * Kept as one message stream rather than a second "events" table, because a
   * case is read as a conversation and an event that scrolls separately from
   * the replies it explains is an event nobody reads.
   */
  senderUserId: string | null;
  senderName: string | null;
  /** True when the sender is the case's own requester. Drives which side it sits on. */
  fromRequester: boolean;
  message: string;
  /**
   * Whether this is a staff-only note.
   *
   * Always false in everything an employee is sent - the employee endpoints
   * filter internal messages out of the query rather than out of the render, so
   * a note is not merely hidden by CSS. True only on the desk's own view, which
   * reads this same shape through its own endpoints.
   */
  internal: boolean;
  attachments: CaseAttachmentRecord[];
  /** The people tagged in it. Only ids the server validated - never parsed from text. */
  mentions: CaseMessageMentionRecord[];
  createdAt: string;
}

export interface CaseDetail extends CaseRecord {
  description: string;
  messages: CaseMessageRecord[];
  /** Files attached to the case itself rather than to any one reply. */
  attachments: CaseAttachmentRecord[];
}

/**
 * The dashboard card's figures.
 *
 * Counted by the database in one grouped query rather than by fetching cases
 * and counting them in the browser. `counts` carries every status so a card can
 * choose what to show without a second round trip when it changes its mind
 * about which of them matter.
 */
export interface CaseSummary {
  counts: Record<CaseStatus, number>;
  /** Everything still live - the sum of the five unsettled statuses. */
  live: number;
  total: number;
}

export const EMPTY_CASE_COUNTS: Record<CaseStatus, number> = {
  OPEN: 0,
  IN_PROGRESS: 0,
  PENDING: 0,
  ON_HOLD: 0,
  RESOLVED: 0,
  CLOSED: 0,
  REOPENED: 0,
};

// --- the desk ----------------------------------------------------------------

/**
 * The other side of the helpdesk: the people who answer.
 *
 * Everything below is reached through its own endpoints under `/cases/queue`
 * and its own grants, and none of it relaxes the requester's side by a field.
 * That separation is the design rather than an accident of ordering: an
 * employee's routes narrow to their own employee id in the WHERE clause, and a
 * desk route narrows to the queues the caller is allowed to work. A single set
 * of routes with a `view=all` parameter would have made those two the same
 * code path with a flag deciding which - and a flag is a thing that gets
 * defaulted wrong once.
 *
 * How far a member of the desk can see is two grants and nothing else:
 *
 *   `case.read.department`  the cases filed to the department on their OWN
 *                           employee record. An IT case is worked by IT.
 *   `case.read.all`         every case in the company, for whoever runs the
 *                           whole desk rather than one queue of it.
 *
 * Deliberately NOT a DataScope. A `DEPARTMENT` scope is handed out so somebody
 * can read their department's employee RECORDS, and reading a person's record
 * is not a reason to read what they asked HR about. The two questions are
 * different and must be able to be answered differently.
 */

/** How wide the caller's view of the queue is, decided from their grants. */
export type CaseDeskScope = 'NONE' | 'DEPARTMENT' | 'ALL';

/**
 * The assignee filter, which is three different questions in one control.
 *
 * `me` and `unassigned` are the two a person on the desk actually asks - "what
 * is mine" and "what has nobody picked up" - and they are spelled as words
 * rather than as a user id so the screen does not have to know its own id to
 * build the commonest filter it offers. Anything else is read as a user id.
 */
export const CASE_ASSIGNEE_FILTERS = ['me', 'unassigned'] as const;

export type CaseAssigneeFilter = (typeof CASE_ASSIGNEE_FILTERS)[number];

/**
 * The queue's query: the employee list's filters, plus who it is assigned to.
 *
 * `mine` and `unassigned` deliberately do not become two endpoints. They are
 * the same list with one clause different, and a queue that answered them from
 * different routes would drift in its sorting, its paging and its columns
 * within a release.
 */
export const caseQueueQuerySchema = caseQuerySchema.extend({
  /** `me`, `unassigned`, or a user id. Absent means every case in scope. */
  assignee: z.string().trim().max(64).optional(),
  /**
   * Narrows to the five live statuses in one clause.
   *
   * A queue is read as "what is still mine to do" far more often than as
   * "everything that ever happened", and expressing that as five repeated
   * status parameters would make the commonest view of this screen the
   * fiddliest URL on the installation.
   */
  live: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type CaseQueueQuery = z.infer<typeof caseQueueQuerySchema>;

/**
 * Taking a case, handing it over, or putting it back.
 *
 * Null is a real value here and means unassigned - "this is nobody's" is a
 * statement somebody makes on purpose when they cannot work it after all, and
 * a queue that could only ever gain owners would fill up with cases assigned to
 * whoever last opened them.
 *
 * The id is checked server-side against the people who could actually work the
 * case: a user who holds no desk grant cannot be handed one, because a case in
 * a queue nobody can open is a case that is lost rather than assigned.
 */
export const caseAssignSchema = z.object({
  assignedUserId: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

export type CaseAssignInput = z.infer<typeof caseAssignSchema>;

/**
 * Moving a case along.
 *
 * The note is optional and becomes an ordinary message on the case, which is
 * how the requester finds out WHY their case went on hold rather than only
 * that it did. Without one the case still records the change - every status
 * change writes a system message - but a status that changes with no
 * explanation is the thing people ring up about.
 */
export const caseStatusChangeSchema = z.object({
  status: z.enum(CASE_STATUSES),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  /**
   * Whether that note is staff-only.
   *
   * Refused unless the caller holds `case.note.internal`, and refused rather
   * than quietly downgraded: a note somebody marked internal and had published
   * to the requester is the worst possible failure mode of this field.
   */
  internal: z.boolean().default(false),
});

export type CaseStatusChangeInput = z.infer<typeof caseStatusChangeSchema>;

/** Re-judging how urgent a case is, which is the desk's call once they see it. */
export const casePriorityChangeSchema = z.object({
  priority: z.enum(CASE_PRIORITIES),
});

export type CasePriorityChangeInput = z.infer<typeof casePriorityChangeSchema>;

/**
 * Re-routing a case that was filed in the wrong queue.
 *
 * The single commonest thing that happens to a real helpdesk ticket, and the
 * alternative to supporting it is a desk that closes cases with "please raise
 * this with IT instead" - which loses the conversation and makes the requester
 * do the routing twice. The three ids are validated exactly as they are on
 * create: same function, same rules, so a re-route cannot put a case somewhere
 * a new case could not have been filed.
 */
export const caseRouteSchema = z.object({
  departmentId: trimmed(1, 64, 'Choose which department this belongs to.'),
  categoryId: trimmed(1, 64, 'Choose what this is about.'),
  subcategoryId: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  /** Why it moved. Becomes a message, so the requester is not left guessing. */
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
});

export type CaseRouteInput = z.infer<typeof caseRouteSchema>;

/** The most people one case message may tag. */
export const CASE_MENTION_MAX = 10;

/** How a tag is written into the message text: `@` and the person's name. */
export function caseMentionToken(name: string): string {
  return `@${name}`;
}

/**
 * The desk's reply, which is two different things behind one form.
 *
 * `internal: false` is an answer to the requester: they see it, and they are
 * notified about it. `internal: true` is a note between colleagues on the same
 * case - never sent, never returned by an employee endpoint, and gated on
 * `case.note.internal` rather than on the grant that lets somebody reply.
 *
 * One schema and one endpoint rather than two, because the two are written in
 * the same box on the same screen about the same case, and the mistake worth
 * engineering against is not "wrong endpoint" but "meant to tick the box".
 * That mistake is addressed where it happens - the UI states which of the two
 * it is about to do, in words, next to the button.
 */
export const caseDeskReplySchema = z.object({
  message: trimmed(1, 5000, 'Write something before sending.'),
  internal: z.boolean().default(false),
  /**
   * The people tagged in it, as user ids picked from the candidate list.
   *
   * Ids rather than names parsed out of the text, so "@Somebody" typed by hand
   * stays text. Every id is re-read on the server, must belong to an active
   * account that can open this message, and must still be named in the text as
   * `@<name>` - a tag deleted from the box before sending is not a tag.
   */
  mentionUserIds: z
    .array(z.string().trim().min(1).max(64))
    .max(CASE_MENTION_MAX, `Tag at most ${CASE_MENTION_MAX} people in one message.`)
    .default([]),
});

export type CaseDeskReplyInput = z.infer<typeof caseDeskReplySchema>;

/**
 * Whether the desk may still write on a case.
 *
 * The same rule as the requester's: everything but CLOSED. A closed case is
 * filed, and the way back in is to reopen it - which is a status change, is
 * audited as one, and puts the case back on a queue rather than adding a
 * message to something nobody is watching.
 */
export function canDeskReply(status: CaseStatus): boolean {
  return status !== 'CLOSED';
}

// --- mentions ----------------------------------------------------------------

/**
 * Tagging somebody in a case message.
 *
 * A TAG tells a person and records that they were named. It is not an
 * assignment - the assignee, the status and the queue are untouched - and it is
 * not a grant: only people who can already open the message may be tagged, and
 * somebody who cannot is refused with a message saying so rather than quietly
 * let in. Routing the case or assigning it is how somebody gains access.
 */
/** The candidate search behind the `@` dropdown. */
export const caseMentionCandidateQuerySchema = z.object({
  q: z.string().trim().max(60).optional().default(''),
  /** Whether the message being written is an internal note. */
  internal: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type CaseMentionCandidateQuery = z.infer<typeof caseMentionCandidateQuerySchema>;

/** One person the `@` dropdown offers. */
export interface CaseMentionCandidate {
  userId: string;
  name: string;
  departmentName: string | null;
  /** Designation, or the free-text job title when there is none. */
  jobTitle: string | null;
  roleNames: string[];
  /**
   * Whether they can open this message. False rows are shown, disabled, with
   * `reason` - so the author learns why rather than wondering where they went.
   */
  canAccess: boolean;
  reason: string | null;
}

/** Somebody tagged in a message, as the conversation renders them. */
export interface CaseMessageMentionRecord {
  userId: string;
  /** The name as written into the text, which is what gets highlighted. */
  name: string;
  /** Their employee record, for a profile link where the reader may follow it. */
  employeeId: string | null;
}

/**
 * One row of the dashboard's "Mentions & follow-ups".
 *
 * Access is re-checked when the list is read, not only when the tag was made: a
 * case that has since been routed away from the reader keeps its row - the
 * reference, who tagged them and when - but loses its subject and preview.
 */
export interface CaseMentionFeedItem {
  id: string;
  caseId: string;
  caseNumber: string;
  caseStatus: CaseStatus;
  /** Null when the reader can no longer open the case. */
  caseSubject: string | null;
  mentionedByName: string | null;
  /** A clipped, single-line excerpt of the message. Null without access. */
  preview: string | null;
  createdAt: string;
  /** From the notification it sent. Null until it is opened. */
  readAt: string | null;
  notificationId: string | null;
  /** Where it opens: the desk's view or the requester's. Null without access. */
  link: string | null;
}

/** How many of the caller's mentions the dashboard reads. */
export const caseMentionFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export interface CaseMentionFeed {
  items: CaseMentionFeedItem[];
  unread: number;
}

/** Somebody a case can be handed to, as the assign control receives them. */
export interface CaseAgentOption {
  userId: string;
  name: string;
  /** The department on their employee record, or null if they have no record. */
  departmentName: string | null;
}

/**
 * What the caller may do to the case in front of them.
 *
 * Sent with the case rather than worked out in the browser from a permission
 * list, because the answer depends on the case's status as well as on the
 * caller's grants - and `nextStatuses` in particular is the workflow, which the
 * browser must not hold a second copy of. Advisory, as ever: every endpoint
 * behind a control re-checks the same thing on what actually arrived.
 */
export interface CaseDeskAbilities {
  canAssign: boolean;
  canUpdate: boolean;
  canRespond: boolean;
  canNote: boolean;
  canRoute: boolean;
  /** Where this case may go from where it is, in the order shown. */
  nextStatuses: CaseStatus[];
}

/** One case as the desk reads it: the whole thread, internal notes included. */
export interface CaseDeskDetail extends CaseDetail {
  abilities: CaseDeskAbilities;
  /** The requester's email, so the desk can reach them outside the case. */
  requesterEmail: string | null;
  requesterDepartmentName: string | null;
}

/**
 * The queue's headline figures.
 *
 * Counted over the caller's own scope, so two people looking at the same screen
 * with different grants see different numbers and both are right.
 */
export interface CaseQueueSummary {
  /** Everything unsettled in scope. */
  live: number;
  /** Live and nobody's. The number that means "somebody should pick these up". */
  unassigned: number;
  /** Live and the caller's own. */
  mine: number;
  /** Live and URGENT or HIGH, whoever holds them. */
  urgent: number;
  counts: Record<CaseStatus, number>;
}

export const EMPTY_CASE_QUEUE_SUMMARY: CaseQueueSummary = {
  live: 0,
  unassigned: 0,
  mine: 0,
  urgent: 0,
  counts: { ...EMPTY_CASE_COUNTS },
};

// --- the catalogue, as its administrator sees it -----------------------------

/**
 * Writing a category or a subcategory.
 *
 * One schema for both levels, because they are one table and differ only in
 * whether a parent is set. What decides the level is `parentCategoryId`, and
 * the server refuses a parent that is itself a subcategory - the tree is two
 * deep by intent, and a third level would appear on no screen that draws it.
 *
 * `departmentId` is required on a top-level category and IGNORED on a
 * subcategory, which inherits its parent's department. Allowing a subcategory
 * to name a different department would let the tree contradict itself.
 */
export const caseCategoryWriteSchema = z.object({
  departmentId: z.string().trim().max(64).optional(),
  parentCategoryId: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  name: trimmed(2, 100, 'Give the queue a name.'),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export type CaseCategoryWriteInput = z.infer<typeof caseCategoryWriteSchema>;

/** Editing one. Every field optional, because a rename is not a re-creation. */
export const caseCategoryUpdateSchema = caseCategoryWriteSchema
  .partial()
  .omit({ parentCategoryId: true, departmentId: true });

export type CaseCategoryUpdateInput = z.infer<typeof caseCategoryUpdateSchema>;

/**
 * One row of the catalogue screen.
 *
 * Carries `caseCount` because the screen's most consequential control is the
 * one that retires a queue, and the only fact that makes that decision
 * answerable is how many cases are already filed behind it.
 */
export interface CaseCategoryAdminRecord {
  id: string;
  departmentId: string;
  departmentName: string;
  parentCategoryId: string | null;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  /** Cases filed directly against this row, as category or as subcategory. */
  caseCount: number;
  children: CaseCategoryAdminRecord[];
}

/** The catalogue as the administrator reads it: every department, retired rows included. */
export interface CaseCatalogueAdminGroup {
  departmentId: string;
  departmentName: string;
  departmentIsActive: boolean;
  categories: CaseCategoryAdminRecord[];
}

/**
 * Why a category cannot simply be deleted once cases point at it.
 *
 * Retiring is the ordinary act and deleting is the exception, so the message
 * says so rather than reporting a foreign key.
 */
export const CASE_CATEGORY_IN_USE_MESSAGE =
  'Cases are already filed under this, so it cannot be deleted. Retire it instead - it disappears from the form and the existing cases keep their history.';

// ------------------------------------------------------------------ routing

const optionalUserId = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

/**
 * Who a new case in one queue goes to.
 *
 * `categoryId` null is the department's default; a category or subcategory id
 * otherwise. One rule per scope: saving again for the same scope replaces it.
 * People are user ids from the company's own accounts - nobody is named in
 * code or configuration files.
 */
export const caseRoutingRuleWriteSchema = z
  .object({
    departmentId: z.string().trim().min(1, 'Choose a department.').max(64),
    categoryId: optionalUserId,
    responsibleUserId: z.string().trim().min(1, 'Choose who is responsible.').max(64),
    backupUserId: optionalUserId,
    escalationUserId: optionalUserId,
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.backupUserId && value.backupUserId === value.responsibleUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backupUserId'],
        message: 'The backup has to be somebody other than the responsible person.',
      });
    }
  });

export type CaseRoutingRuleWriteInput = z.infer<typeof caseRoutingRuleWriteSchema>;

export interface CaseRoutingPerson {
  userId: string;
  name: string;
  /** False when the account is no longer active or can no longer work cases. */
  eligible: boolean;
}

export interface CaseRoutingRuleRecord {
  id: string;
  departmentId: string;
  departmentName: string;
  /** Null for the department default. */
  categoryId: string | null;
  categoryName: string | null;
  /** Set when `categoryId` is a subcategory: the category it sits under. */
  parentCategoryName: string | null;
  responsible: CaseRoutingPerson;
  backup: CaseRoutingPerson | null;
  escalation: CaseRoutingPerson | null;
  isActive: boolean;
  updatedAt: string;
}

/** The routing screen: every rule, and who may be named in one. */
export interface CaseRoutingOverview {
  rules: CaseRoutingRuleRecord[];
  /** Active accounts that can work cases - the only people a case can go to. */
  candidates: CaseAgentOption[];
}
