import type { Prisma } from '@prisma/client';
import {
  CASE_LIVE_STATUSES,
  EMPTY_CASE_COUNTS,
  PERMISSIONS,
  caseNumberYearPrefix,
  canRequesterReopen,
  canRequesterReply,
  formatCaseNumber,
  parseCaseNumberSequence,
  type CaseAttachmentContentType,
  type CaseAttachmentRecord,
  type CaseDepartmentCatalogue,
  type CaseDetail,
  type CaseMessageRecord,
  type CaseRecord,
  type CaseStatus,
  type CaseSummary,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { seedCaseCatalogue, type CaseCatalogueSeedResult } from './case-catalogue.seed.js';

/**
 * The cases module's data layer.
 *
 * Every function here that reaches a case takes a REQUESTER, not a case id on
 * its own. That is the shape of the phase 1 security story: an employee's side
 * of this module is the set of rows whose `requesterEmployeeId` is their own
 * employee record, resolved from the session cookie and from nothing in the
 * request, and a query that could be written without that column is a query
 * that will eventually be written without it. When phase 2 adds the agent side
 * it adds its own lookups with its own permissions rather than relaxing these.
 */

// --- who is asking -----------------------------------------------------------

export interface CaseRequester {
  employeeId: string;
  userId: string;
  companyId: string;
}

/**
 * The caller's own employee record, which is what a case hangs off.
 *
 * A login with no employee record behind it has no cases and can raise none:
 * a case is about somebody's working life, and there is nothing to attach one
 * to. Returned as null rather than thrown, so a list can answer "none" while
 * a create answers with a message that names the problem.
 */
export async function resolveRequester(auth: AuthContext): Promise<CaseRequester | null> {
  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  if (!employee) return null;
  return { employeeId: employee.id, userId: auth.userId, companyId: auth.companyId };
}

/** The message for a caller with no employee record. Used by every write path. */
export const NO_EMPLOYEE_RECORD_MESSAGE =
  'Your login is not linked to an employee record yet, so you cannot raise a case. Ask an administrator to link it.';

/**
 * One of the caller's OWN cases, or a 404.
 *
 * The whole IDOR defence, in one query and one place. `requesterEmployeeId` is
 * in the WHERE clause rather than checked after the read, so there is no
 * moment at which this function is holding somebody else's case, and no branch
 * anybody can add later that forgets to check. The company id is in there too:
 * a tenant boundary is not a permission question and is not left to one.
 *
 * A case belonging to somebody else is reported as NOT FOUND rather than as
 * forbidden, deliberately. A 403 on a guessed id confirms that the id exists,
 * which is exactly the fact the guesser was after.
 */
export async function ownCaseOrThrow(
  requester: CaseRequester,
  caseId: string,
): Promise<CaseRow> {
  const row = await prisma.case.findFirst({
    where: {
      id: caseId,
      companyId: requester.companyId,
      requesterEmployeeId: requester.employeeId,
    },
    include: CASE_INCLUDE,
  });

  if (!row) throw new NotFoundError('Case');
  return row;
}

// --- the case number ---------------------------------------------------------

/**
 * The next case number for a company, in a given year.
 *
 * Reads the highest number issued this year and adds one, exactly as employee
 * numbers and claim numbers are generated. The read is not the guarantee - two
 * people clicking Submit in the same second both read the same highest - so the
 * unique index on (companyId, caseNumber) is, and the caller retries on it.
 * See `createCaseWithNumber`.
 *
 * Scanning the year's numbers rather than counting rows is what makes a deleted
 * or renumbered case harmless: the sequence only ever moves forward, so a
 * number is never reissued to a second case.
 */
export async function nextCaseNumber(companyId: string, year: number): Promise<string> {
  const prefix = caseNumberYearPrefix(year);

  const existing = await prisma.case.findMany({
    where: { companyId, caseNumber: { startsWith: prefix } },
    select: { caseNumber: true },
  });

  let highest = 0;
  for (const { caseNumber } of existing) {
    const sequence = parseCaseNumberSequence(caseNumber, year);
    if (sequence !== null) highest = Math.max(highest, sequence);
  }

  return formatCaseNumber(year, highest + 1);
}

/** Raised by `createCaseWithNumber` when the retries are exhausted. */
export class CaseNumberExhaustedError extends Error {
  constructor() {
    super('Could not allocate a case number after several attempts.');
    this.name = 'CaseNumberExhaustedError';
  }
}

/**
 * Creates a case, retrying if somebody else took the number first.
 *
 * The retry is the point. `nextCaseNumber` reads the highest so far, and
 * between that read and the insert another request can have used it; the unique
 * index turns that into a P2002 rather than into two cases sharing a number,
 * and the right response to a P2002 here is to read again and try again, not to
 * fail somebody's case with a conflict they did not cause.
 *
 * Five attempts, because the window is a single round trip and a company that
 * loses five in a row has a problem no amount of retrying will fix.
 */
export async function createCaseWithNumber(
  data: Omit<Prisma.CaseUncheckedCreateInput, 'caseNumber'>,
  now = new Date(),
): Promise<CaseRow> {
  const year = now.getUTCFullYear();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const caseNumber = await nextCaseNumber(data.companyId, year);
    try {
      return await prisma.case.create({
        data: { ...data, caseNumber },
        include: CASE_INCLUDE,
      });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }

  throw new CaseNumberExhaustedError();
}

/**
 * A Prisma unique-constraint failure, recognised without importing the runtime
 * error class - which is a value import that would drag the client into every
 * test that mocks it.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

// --- the category catalogue --------------------------------------------------

/**
 * Proves a department/category/subcategory selection is real and consistent.
 *
 * Four things are checked and all four are checked HERE, because the browser's
 * dropdowns are a convenience and this is the gate:
 *
 *   - the department belongs to this company and is active;
 *   - the category exists, is active, and belongs to THAT department;
 *   - the category is a top-level one, not a subcategory promoted by a
 *     hand-built request;
 *   - the subcategory, if given, is a child of that exact category.
 *
 * The third and fourth are the ones a UI would never produce and a curl command
 * would: without them a case could be filed against the Finance queue while
 * claiming to be an IT case, and the department shown on it would be a lie.
 */
export async function resolveCategorySelection(
  companyId: string,
  input: { departmentId: string; categoryId: string; subcategoryId: string | null },
): Promise<{ departmentId: string; categoryId: string; subcategoryId: string | null }> {
  const department = await prisma.department.findFirst({
    where: { id: input.departmentId, companyId, isActive: true },
    select: { id: true },
  });
  if (!department) {
    throw new ValidationError({ departmentId: ['Choose a department from the list.'] });
  }

  const category = await prisma.caseCategory.findFirst({
    where: {
      id: input.categoryId,
      companyId,
      departmentId: department.id,
      parentCategoryId: null,
      isActive: true,
    },
    select: { id: true },
  });
  if (!category) {
    throw new ValidationError({
      categoryId: ['Choose a category that belongs to that department.'],
    });
  }

  if (!input.subcategoryId) {
    return { departmentId: department.id, categoryId: category.id, subcategoryId: null };
  }

  const subcategory = await prisma.caseCategory.findFirst({
    where: {
      id: input.subcategoryId,
      companyId,
      parentCategoryId: category.id,
      isActive: true,
    },
    select: { id: true },
  });
  if (!subcategory) {
    throw new ValidationError({
      subcategoryId: ['Choose a subcategory that belongs to that category.'],
    });
  }

  return {
    departmentId: department.id,
    categoryId: category.id,
    subcategoryId: subcategory.id,
  };
}

/**
 * The whole create-form vocabulary for a company, as a tree.
 *
 * Only departments with at least one live category appear. A department nobody
 * has given a queue to cannot receive a case - the category is mandatory - so
 * offering it would draw a form that fails on submit, which is a worse answer
 * than not offering it.
 *
 * One query, assembled in memory. A catalogue is tens of rows, not thousands,
 * and a company that grows one big enough to matter has a different problem.
 */
export async function caseCatalogue(companyId: string): Promise<CaseDepartmentCatalogue[]> {
  const rows = await prisma.caseCategory.findMany({
    where: { companyId, isActive: true, department: { isActive: true } },
    select: {
      id: true,
      name: true,
      description: true,
      sortOrder: true,
      parentCategoryId: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  const departments = new Map<string, CaseDepartmentCatalogue>();
  const categoryIndex = new Map<string, CaseDepartmentCatalogue['categories'][number]>();

  // Top level first, so a subcategory always finds its parent already placed.
  for (const row of rows) {
    if (row.parentCategoryId !== null) continue;

    let department = departments.get(row.departmentId);
    if (!department) {
      department = {
        departmentId: row.department.id,
        departmentName: row.department.name,
        categories: [],
      };
      departments.set(row.departmentId, department);
    }

    const category = {
      id: row.id,
      name: row.name,
      description: row.description,
      subcategories: [],
    };
    department.categories.push(category);
    categoryIndex.set(row.id, category);
  }

  for (const row of rows) {
    if (row.parentCategoryId === null) continue;
    // A subcategory whose parent is retired has no route onto the form. It is
    // skipped rather than promoted: promoting it would invent a queue nobody
    // configured.
    const parent = categoryIndex.get(row.parentCategoryId);
    if (!parent) continue;
    parent.subcategories.push({ id: row.id, name: row.name, description: row.description });
  }

  return [...departments.values()].sort((a, b) =>
    a.departmentName.localeCompare(b.departmentName),
  );
}

/**
 * Writes the starting catalogue for a company, matching its OWN departments.
 *
 * A thin binding of `seedCaseCatalogue` to the application's Prisma client. The
 * implementation lives next door because `prisma/seed.ts` needs the same
 * routine with its own client, and one shared function is the only arrangement
 * where the seeder and the application cannot drift apart.
 */
export function seedDefaultCaseCatalogue(companyId: string): Promise<CaseCatalogueSeedResult> {
  return seedCaseCatalogue(prisma, companyId);
}


// --- read shapes -------------------------------------------------------------

/**
 * What every case read carries with it.
 *
 * Names, not ids, because a list shows names and a second round trip per row to
 * fetch them is how a list becomes slow. The counts are done by the database
 * with `isInternal: false` baked in, so the number an employee is shown is the
 * number of messages they can actually open - a count that included staff notes
 * would tell them a note exists, which is the one thing a note must not do.
 */
export const CASE_INCLUDE = {
  requester: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
    },
  },
  department: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  subcategory: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  _count: {
    select: {
      messages: { where: { isInternal: false } },
      attachments: { where: { isInternal: false } },
    },
  },
} as const satisfies Prisma.CaseInclude;

export type CaseRow = Prisma.CaseGetPayload<{ include: typeof CASE_INCLUDE }>;

/** What the caller may do with a case, decided from permissions plus status. */
export interface CaseCallerContext {
  permissions: ReadonlySet<string>;
}

export function callerContext(auth: AuthContext): CaseCallerContext {
  return { permissions: auth.permissions };
}

const personName = (p: { firstName: string; lastName: string; displayName?: string | null }) =>
  p.displayName ?? `${p.firstName} ${p.lastName}`.trim();

export function toCaseRecord(row: CaseRow, caller: CaseCallerContext): CaseRecord {
  const status = row.status as CaseStatus;

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    subject: row.subject,

    departmentId: row.departmentId,
    departmentName: row.department.name,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    subcategoryId: row.subcategoryId,
    subcategoryName: row.subcategory?.name ?? null,

    priority: row.priority,
    status,

    requesterEmployeeId: row.requesterEmployeeId,
    requesterName: personName(row.requester),
    requesterEmployeeNumber: row.requester.employeeNumber,

    assignedUserId: row.assignedUserId,
    assignedToName: row.assignedTo ? personName(row.assignedTo) : null,

    messageCount: row._count.messages,
    attachmentCount: row._count.attachments,

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,

    /*
     * Advisory. The buttons a browser draws come from these, and every endpoint
     * behind them re-checks the same permission and the same status on what
     * actually arrived - so a flag flipped in a debugger buys nothing.
     */
    canReply: caller.permissions.has(PERMISSIONS.CASE_REPLY_OWN) && canRequesterReply(status),
    canReopen: caller.permissions.has(PERMISSIONS.CASE_REOPEN_OWN) && canRequesterReopen(status),
    canAttach: caller.permissions.has(PERMISSIONS.CASE_REPLY_OWN) && canRequesterReply(status),
  };
}

type AttachmentRow = {
  id: string;
  messageId: string | null;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  uploadedBy: { firstName: string; lastName: string } | null;
};

export function toAttachmentRecord(row: AttachmentRow): CaseAttachmentRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    fileName: row.fileName,
    contentType: row.contentType as CaseAttachmentContentType,
    sizeBytes: row.sizeBytes,
    uploadedByName: row.uploadedBy ? personName(row.uploadedBy) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

type MessageRow = {
  id: string;
  senderUserId: string | null;
  message: string;
  isInternal: boolean;
  createdAt: Date;
  sender: { id: string; firstName: string; lastName: string } | null;
  attachments: AttachmentRow[];
};

/**
 * One message, and whose side of the conversation it sits on.
 *
 * `fromRequester` is derived from the sender's USER id against the requester's
 * own, rather than from a column on the message. A column would be a second
 * place for the same fact to be recorded and therefore a second place for it to
 * be wrong, and getting it wrong here puts an agent's words in the employee's
 * own speech bubble.
 */
export function toMessageRecord(row: MessageRow, requesterUserId: string | null): CaseMessageRecord {
  return {
    id: row.id,
    senderUserId: row.senderUserId,
    senderName: row.sender ? personName(row.sender) : null,
    fromRequester: row.senderUserId !== null && row.senderUserId === requesterUserId,
    message: row.message,
    internal: row.isInternal,
    attachments: row.attachments.map(toAttachmentRecord),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCaseDetail(
  row: CaseRow,
  caller: CaseCallerContext,
  parts: {
    messages: MessageRow[];
    attachments: AttachmentRow[];
    requesterUserId: string | null;
  },
): CaseDetail {
  return {
    ...toCaseRecord(row, caller),
    description: row.description,
    messages: parts.messages.map((m) => toMessageRecord(m, parts.requesterUserId)),
    attachments: parts.attachments.map(toAttachmentRecord),
  };
}

// --- the dashboard's figures -------------------------------------------------

/**
 * The caller's own cases, counted by status.
 *
 * A grouped count rather than a page of rows the browser tallies. A dashboard
 * card that fetched cases to count them would be wrong the moment somebody had
 * more of them than the page size, and would be wrong quietly.
 */
export async function caseSummaryFor(requester: CaseRequester): Promise<CaseSummary> {
  const grouped = await prisma.case.groupBy({
    by: ['status'],
    where: {
      companyId: requester.companyId,
      requesterEmployeeId: requester.employeeId,
    },
    _count: { _all: true },
  });

  const counts = { ...EMPTY_CASE_COUNTS };
  for (const group of grouped) {
    counts[group.status as CaseStatus] = group._count._all;
  }

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const live = CASE_LIVE_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  return { counts, live, total };
}

/** The empty answer, for a login with no employee record behind it. */
export const EMPTY_CASE_SUMMARY: CaseSummary = {
  counts: { ...EMPTY_CASE_COUNTS },
  live: 0,
  total: 0,
};

/** Guards a write against a caller with no employee record. */
export function requireRequester(requester: CaseRequester | null): CaseRequester {
  if (!requester) throw new ForbiddenError(NO_EMPLOYEE_RECORD_MESSAGE);
  return requester;
}
