import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ASSET_NOT_ASSIGNABLE_REASON,
  PERMISSIONS,
  isAssetAssignable,
  missingAccessories,
  type AssetAcknowledgementStatus,
  type AssetActions,
  type AssetCondition,
  type AssetDisposalMethod,
  type AssetIncidentKind,
  type AssetRepairRecord,
  type AssetRepairStatus,
  type AssetIncidentRecord,
  type AssetStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import type { AssetActor } from './assets.service.js';

/**
 * The asset lifecycle: handing one over, taking it back, and everything that
 * happens to it in between.
 *
 * ONE IDEA RUNS THROUGH THIS FILE AND IT IS WORTH READING FIRST.
 *
 * Step 1 recorded that "one active assignment per asset" could not be a partial
 * unique index, because Prisma cannot describe one and would drop it on the next
 * migration, and left the rule to the service layer. A rule in a service layer
 * is usually a read followed by a write with a race between them. This module
 * does not have that race, because it never reads to decide - it writes
 * CONDITIONALLY and checks how many rows it hit:
 *
 *   ASSIGNING locks on the ASSET ROW.
 *     UPDATE assets SET status='ASSIGNED' WHERE id=$1 AND status IN
 *     ('AVAILABLE','RETURNED')
 *     An asset that is already out has status ASSIGNED and matches nothing, so
 *     two people assigning the same laptop in the same second produce one
 *     assignment and one 422.
 *
 *   RETURNING and TRANSFERRING lock on the ACTIVE ASSIGNMENT ROW.
 *     UPDATE asset_assignments SET status='RETURNED' WHERE id=$1 AND
 *     status='ACTIVE'
 *     The second caller's update matches nothing, so an asset cannot be both
 *     returned and transferred, and a return cannot be recorded twice.
 *
 * Both are compare-and-swap against a real row, inside a transaction, and both
 * are what section 14 means by enforcing these rules server-side. `updateMany`
 * rather than `update` is deliberate throughout: `update` throws on a miss and
 * `updateMany` reports a count, and the count is the answer we need.
 */

/** The Prisma surface a lifecycle step needs. Satisfied by a client or a tx. */
export type AssetTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// --------------------------------------------------------------- guards

/**
 * Fetches an asset for a WRITE, or 404s.
 *
 * Always the whole-register lookup: every lifecycle action needs a write grant,
 * and nobody holds one without also being able to see the register. A narrowed
 * reader never reaches this function, so it deliberately does not take a scope.
 */
export async function assetForWrite(auth: AuthContext, id: string) {
  const row = await prisma.asset.findFirst({ where: { id, companyId: auth.companyId } });
  if (!row) throw new NotFoundError('Asset');
  return row;
}

/**
 * Refuses an asset that cannot be handed to anybody.
 *
 * Every refusal section 14 names, in one place, with the reason written for the
 * person who will read it on a form. The ASSIGNED case is included and is also
 * the one the conditional update enforces underneath - this exists so the
 * ordinary answer is a sentence rather than a bare count mismatch.
 */
export function assertAssignable(status: AssetStatus): void {
  if (isAssetAssignable(status)) return;
  throw new ValidationError({
    assetId: [ASSET_NOT_ASSIGNABLE_REASON[status] ?? 'That asset cannot be assigned.'],
  });
}

/**
 * Proves an employee is in this company and can hold an asset.
 *
 * A field error rather than a foreign-key crash, and a company boundary: without
 * it a caller could issue their company's laptop to a stranger by quoting an
 * employee id from another tenant.
 */
export async function employeeForAssignment(
  companyId: string,
  employeeId: string,
  field: string,
): Promise<{ id: string; firstName: string; lastName: string; userId: string | null }> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
    select: { id: true, firstName: true, lastName: true, userId: true, status: true },
  });
  if (!employee) throw new ValidationError({ [field]: ['That employee does not exist.'] });

  /*
   * A terminated employee cannot be issued anything. Deliberately NOT extended
   * to RESIGNED: somebody serving notice is still at work, still needs a laptop
   * and is exactly the person whose kit is about to be counted - refusing them
   * would make the clearance screen in section 11 impossible to reach.
   */
  if (employee.status === 'TERMINATED') {
    throw new ValidationError({ [field]: ['That employee has left the company.'] });
  }

  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    userId: employee.userId,
  };
}

/** The active handover for an asset, or null. */
export async function activeAssignment(companyId: string, assetId: string) {
  return prisma.assetAssignment.findFirst({
    where: { assetId, companyId, status: 'ACTIVE' },
    include: { employee: { select: { id: true, firstName: true, lastName: true } } },
  });
}

/** The active handover, or a 422 saying nobody has it. */
export async function activeAssignmentOrThrow(companyId: string, assetId: string) {
  const assignment = await activeAssignment(companyId, assetId);
  if (!assignment) {
    throw new ValidationError({ assetId: ['Nobody is holding that asset.'] });
  }
  return assignment;
}

/**
 * The compare-and-swap that claims an asset for a handover.
 *
 * Returns true when this caller won. See the note at the top of the file: this
 * is the real "one active assignment per asset" constraint, and it lives here
 * rather than in an index only because Prisma cannot express the index.
 */
export async function claimAssetForAssignment(
  tx: AssetTx,
  companyId: string,
  assetId: string,
  condition: AssetCondition,
): Promise<boolean> {
  const claimed = await tx.asset.updateMany({
    where: {
      id: assetId,
      companyId,
      // The lock. An already-assigned asset is not in this set.
      status: { in: ['AVAILABLE', 'RETURNED'] },
    },
    data: { status: 'ASSIGNED', condition },
  });
  return claimed.count === 1;
}

/**
 * The compare-and-swap that closes a handover.
 *
 * Returns true when this caller won. A second return, or a return racing a
 * transfer, hits zero rows and is refused.
 */
export async function closeAssignment(
  tx: AssetTx,
  assignmentId: string,
  /*
   * The UNCHECKED variant, because a close writes `returnedById` - a relation's
   * scalar - and Prisma's checked `UpdateManyMutationInput` omits foreign keys.
   */
  data: Prisma.AssetAssignmentUncheckedUpdateManyInput,
): Promise<boolean> {
  const closed = await tx.assetAssignment.updateMany({
    where: { id: assignmentId, status: 'ACTIVE' },
    data,
  });
  return closed.count === 1;
}

/** The message both compare-and-swaps give when they lose the race. */
export const RACE_LOST_MESSAGE =
  'Somebody changed that asset a moment ago. Reload the page and try again.';

// ------------------------------------------------------------ accessories

/**
 * What did not come back.
 *
 * Computed from the two lists and then STORED, unioned with whatever the person
 * recording the return adds by hand - a cable nobody recorded issuing can still
 * go missing. Stored rather than recomputed on read so the record of what was
 * missing on the day survives somebody later editing what was issued.
 */
export function resolveMissing(
  issued: readonly string[],
  returned: readonly string[],
  additional: readonly string[],
): string[] {
  const derived = missingAccessories(issued, returned);
  const seen = new Set(derived.map((value) => value.toLowerCase()));
  for (const extra of additional) {
    if (seen.has(extra.toLowerCase())) continue;
    seen.add(extra.toLowerCase());
    derived.push(extra);
  }
  return derived;
}

// ---------------------------------------------------------------- actions

/**
 * What this caller may do with this asset, right now.
 *
 * Computed on the server from the GRANT and the asset's STATE together, so a
 * button is offered only when pressing it would work. The alternative - the
 * browser reasoning about statuses - is two copies of the rule that eventually
 * disagree, and the copy a person sees is the wrong one.
 */
export function assetActions(
  auth: AuthContext,
  asset: { status: AssetStatus },
  hasActiveAssignment: boolean,
): AssetActions {
  const has = (permission: string) => auth.permissions.has(permission as never);
  const status = asset.status;
  const terminal = status === 'DISPOSED';

  return {
    assign: has(PERMISSIONS.ASSET_ASSIGN) && isAssetAssignable(status) && !hasActiveAssignment,
    transfer: has(PERMISSIONS.ASSET_TRANSFER) && hasActiveAssignment && status !== 'UNDER_REPAIR',
    returnToStock: has(PERMISSIONS.ASSET_RETURN) && hasActiveAssignment,
    // A repair can start from anywhere the asset is actually here and working
    // or not - including while somebody has it, which is the usual case.
    repair:
      has(PERMISSIONS.ASSET_REPAIR) &&
      ['AVAILABLE', 'ASSIGNED', 'RETURNED', 'DAMAGED'].includes(status),
    markLostOrDamaged: has(PERMISSIONS.ASSET_UPDATE) && !terminal && status !== 'RETIRED',
    retire: has(PERMISSIONS.ASSET_RETIRE) && !terminal && status !== 'RETIRED',
    dispose: has(PERMISSIONS.ASSET_DISPOSE) && !terminal,
    update: has(PERMISSIONS.ASSET_UPDATE) && !terminal,
    manageDocuments: has(PERMISSIONS.ASSET_UPDATE),
  };
}

// ---------------------------------------------------------------- mappers

function toNumber(value: Prisma.Decimal | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function personName(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}`.trim() : null;
}

export const ASSET_REPAIR_INCLUDE = {
  sentBy: { select: { id: true, firstName: true, lastName: true } },
  completedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AssetRepairInclude;

type RepairRow = Prisma.AssetRepairGetPayload<{ include: typeof ASSET_REPAIR_INCLUDE }>;

export function toAssetRepairRecord(row: RepairRow): AssetRepairRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    problem: row.problem,
    reportedOn: toDateOnly(row.reportedOn) ?? '',
    sentOn: toDateOnly(row.sentOn) ?? '',
    expectedReturnOn: toDateOnly(row.expectedReturnOn),
    returnedOn: toDateOnly(row.returnedOn),
    vendor: row.vendor,
    estimatedCost: toNumber(row.estimatedCost),
    actualCost: toNumber(row.actualCost),
    notes: row.notes,
    completionNotes: row.completionNotes,
    status: row.status as AssetRepairStatus,
    statusBeforeRepair: row.statusBeforeRepair as AssetStatus,
    sentBy: row.sentBy ? { id: row.sentBy.id, fullName: personName(row.sentBy) ?? '' } : null,
    completedBy: row.completedBy
      ? { id: row.completedBy.id, fullName: personName(row.completedBy) ?? '' }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const ASSET_INCIDENT_INCLUDE = {
  reportedBy: { select: { id: true, firstName: true, lastName: true } },
  reportedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AssetIncidentInclude;

type IncidentRow = Prisma.AssetIncidentGetPayload<{ include: typeof ASSET_INCIDENT_INCLUDE }>;

export function toAssetIncidentRecord(row: IncidentRow): AssetIncidentRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    assignmentId: row.assignmentId,
    kind: row.kind as AssetIncidentKind,
    occurredOn: toDateOnly(row.occurredOn) ?? '',
    reason: row.reason,
    description: row.description,
    notes: row.notes,
    reportedBy: row.reportedBy
      ? { id: row.reportedBy.id, fullName: personName(row.reportedBy) ?? '' }
      : null,
    reportedByEmployee: row.reportedByEmployee
      ? { id: row.reportedByEmployee.id, fullName: personName(row.reportedByEmployee) ?? '' }
      : null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNotes: row.resolutionNotes,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A `yyyy-MM-dd` string as a `@db.Date` value, pinned to UTC midnight. */
export function dayColumn(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

// ------------------------------------------------- the caller's own record

/**
 * The caller's employee id, or a refusal.
 *
 * Used by the two endpoints an EMPLOYEE may write to - acknowledge and report
 * an issue - which are bound to the caller's own handover row. A login with no
 * employee record holds nobody's asset, so there is nothing for it to
 * acknowledge.
 */
export async function callerEmployeeOrThrow(auth: AuthContext): Promise<string> {
  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });
  if (!employee) {
    throw new ForbiddenError('Your account is not linked to an employee record.');
  }
  return employee.id;
}

/** The acknowledgement states that still want something from the employee. */
export function needsAcknowledgement(status: AssetAcknowledgementStatus): boolean {
  return status === 'PENDING';
}

/**
 * Whether an employee is on their way out, from the records the HRMS already
 * keeps.
 *
 * Section 11 asks for clearance when somebody enters "notice period" or is
 * "terminated". There is no NOTICE_PERIOD status in this product and this module
 * does not add one - inventing an employment state would be a change to the
 * people module, which is out of scope here and would affect payroll, leave and
 * attendance besides. RESIGNED is what notice looks like in these tables: the
 * resignation has been handed in, `resignationDate` is set, and the person is
 * working out their notice until `terminationDate`. TERMINATED is the other
 * half of the question, and the two together are the whole of it.
 */
export function isLeaving(status: string): boolean {
  return status === 'RESIGNED' || status === 'TERMINATED';
}

export type { AssetActor };
