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
 * Phase 1 is the foundation plus the employee's whole side of it: raise a case,
 * watch it, reply to it, attach a file to it, reopen it. There is no agent side
 * yet - nothing here assigns, triages or resolves - but every field and every
 * status the full workflow needs is defined below, so Phase 2 adds screens
 * rather than columns.
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
 * Phase 1 exercises exactly one of these edges - an employee reopening their
 * own settled case - and defines the rest, so the Phase 2 agent screens inherit
 * a workflow rather than inventing one per button. A transition absent from
 * this map is refused by the server whoever asks for it.
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
 * catalogue below is a STARTING POINT that the seeder writes once; from Phase 2
 * an administrator edits, adds and retires rows through the UI, and nothing in
 * the web app has an opinion about what the list contains.
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
 * become somebody else. Phase 2's agent-side "raise on behalf of" is a separate
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
 * no payload that turns an employee's reply into a note, and no flag to forget
 * to check when Phase 2 adds the agent-side form.
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

  /** Null until somebody picks it up. Phase 2 does the picking up. */
  assignedUserId: string | null;
  assignedToName: string | null;

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
   * a note is not merely hidden by CSS. Present on the type because Phase 2's
   * agent view reads the same shape.
   */
  internal: boolean;
  attachments: CaseAttachmentRecord[];
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
 * and counting them in the browser. `counts` carries every status so the card
 * can choose what to show without a second round trip when Phase 2 changes its
 * mind about which four matter.
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
