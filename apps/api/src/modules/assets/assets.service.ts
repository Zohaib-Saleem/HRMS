import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  canTransitionAsset,
  isAssignmentDrivenStatus,
  type AssetCategoryRecord,
  type AssetCondition,
  type AssetRecord,
  type AssetStatus,
  type AssetAcknowledgementStatus,
  type AssetAssignmentRecord,
  type AssetAssignmentStatus,
  type AssetWarrantyFilter,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { isValidTimeZone, todayInZone } from '../../core/zoned-time.js';
import { employeeScopeFilter } from '../../auth/scope.js';
import type { AuthContext } from '../../auth/session.js';

/**
 * Assets, the parts every route in the module shares.
 *
 * Two things live here and nothing else does: WHO CAN SEE WHAT, and how a row
 * becomes a response. Both are here rather than in the route files because both
 * are the sort of rule that must have exactly one copy - a second opinion about
 * which assets a manager may read is a hole, and a second mapper is how a
 * holder's name ends up present on the detail screen and absent from the list.
 *
 * The access model in one paragraph. There are two read grants and the gap
 * between them is the design: `asset.read.all` is the REGISTER - every asset the
 * company owns, held or not - and `asset.read` on its own is the assets
 * currently out with the people the caller's DATA SCOPE reaches. For an ordinary
 * member of staff on an OWN scope that is the laptop on their own desk; for a
 * manager on REPORTS_AND_OWN it is their team's. Assets nobody is holding are
 * nobody's, so they are absent from the narrow read entirely.
 *
 * Using the data scope here is a deliberate departure from what recruitment
 * does, and the reason the two differ is worth stating: recruitment is narrowed
 * by NAMED INVOLVEMENT because a reporting line is not a reason to read a
 * stranger's CV. "Who is holding this laptop" is a different kind of fact - it
 * is a fact about an EMPLOYEE RECORD, and a reporting line is exactly the reason
 * somebody may read their reports' records. So the existing scope machinery is
 * the right instrument, and it is reused rather than reimplemented.
 */

/** Who the caller is, in the asset module's terms. */
export interface AssetActor {
  auth: AuthContext;
  /** Reads the whole register, including assets nobody is holding. */
  canReadAll: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canManageCategories: boolean;
}

export function resolveAssetActor(auth: AuthContext): AssetActor {
  return {
    auth,
    canReadAll: auth.permissions.has(PERMISSIONS.ASSET_READ_ALL),
    canCreate: auth.permissions.has(PERMISSIONS.ASSET_CREATE),
    canUpdate: auth.permissions.has(PERMISSIONS.ASSET_UPDATE),
    canManageCategories: auth.permissions.has(PERMISSIONS.ASSET_CATEGORY_MANAGE),
  };
}

/**
 * The WHERE fragment narrowing assets to what this caller may read.
 *
 * Returns `null` for "no rows", which callers must treat as no rows rather than
 * as no filter - the same contract `employeeScopeFilter` keeps, and the same
 * expensive mistake to make silently. Here the expensive version hands the whole
 * asset register to somebody who should see one laptop.
 *
 * The narrow clause is a nested `some` on the ACTIVE assignment, so an asset
 * that is not theirs is absent from the query rather than fetched and then
 * withheld. It also means an employee cannot reach the assignment history of an
 * asset they hold today: the filter matches on the active row, and `GET /:id`
 * returns the history only to a reader who may see the whole register.
 */
export async function assetScopeFilter(
  actor: AssetActor,
): Promise<Prisma.AssetWhereInput | null> {
  if (actor.canReadAll) return {};

  const people = await employeeScopeFilter(actor.auth);
  if (people === null) return null;

  return { assignments: { some: { status: 'ACTIVE', employee: people } } };
}

/** Fetches one asset the caller may read, or 404s. */
export async function assetOrThrow(actor: AssetActor, id: string) {
  const scope = await assetScopeFilter(actor);
  /*
   * 404 rather than 403, and the same everywhere in this module: telling
   * somebody "that exists but is not yours" turns a guessed id into a way of
   * confirming what the company owns.
   */
  if (scope === null) throw new NotFoundError('Asset');

  const row = await prisma.asset.findFirst({
    where: { AND: [{ id, companyId: actor.auth.companyId }, scope] },
    include: ASSET_INCLUDE,
  });
  if (!row) throw new NotFoundError('Asset');

  return row;
}

// ------------------------------------------------------------------ includes

/**
 * What a row needs to become an `AssetRecord`.
 *
 * The assignment include is narrowed to the ACTIVE row and taken one at a time,
 * which is the whole reason there is no holder column on the asset: the current
 * holder is a filtered relation rather than a denormalised field, so a handover
 * cannot leave the two disagreeing.
 */
export const ASSET_INCLUDE = {
  category: { select: { id: true, name: true, parent: { select: { name: true } } } },
  site: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  assignments: {
    where: { status: 'ACTIVE' as const },
    orderBy: { assignedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      assignedAt: true,
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.AssetInclude;

export const ASSET_ASSIGNMENT_INCLUDE = {
  employee: { select: { id: true, employeeNumber: true, firstName: true, lastName: true } },
  assignedBy: { select: { id: true, firstName: true, lastName: true } },
  returnedBy: { select: { id: true, firstName: true, lastName: true } },
  acknowledgedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AssetAssignmentInclude;

// ------------------------------------------------------------------- mappers

function toNumber(value: Prisma.Decimal | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/** A `@db.Date` column as `yyyy-MM-dd`, with no timezone in the answer. */
function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

interface PersonName {
  firstName: string;
  lastName: string;
}

function fullName(person: PersonName): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

type AssetRow = Prisma.AssetGetPayload<{ include: typeof ASSET_INCLUDE }>;

export function toAssetRecord(row: AssetRow): AssetRecord {
  const active = row.assignments[0];

  return {
    id: row.id,
    assetTag: row.assetTag,
    name: row.name,
    category: row.category
      ? {
          id: row.category.id,
          name: row.category.name,
          parentName: row.category.parent?.name ?? null,
        }
      : null,
    brand: row.brand,
    model: row.model,
    serialNumber: row.serialNumber,
    purchaseDate: toDateOnly(row.purchaseDate),
    purchasePrice: toNumber(row.purchasePrice),
    currentValue: toNumber(row.currentValue),
    vendor: row.vendor,
    warrantyStart: toDateOnly(row.warrantyStart),
    warrantyEnd: toDateOnly(row.warrantyEnd),
    location: row.location,
    site: row.site ? { id: row.site.id, name: row.site.name } : null,
    department: row.department ? { id: row.department.id, name: row.department.name } : null,
    condition: row.condition as AssetCondition,
    status: row.status as AssetStatus,
    notes: row.notes,
    holder:
      active && active.employee
        ? {
            assignmentId: active.id,
            employeeId: active.employee.id,
            employeeNumber: active.employee.employeeNumber,
            fullName: fullName(active.employee),
            departmentName: active.employee.department?.name ?? null,
            assignedAt: active.assignedAt.toISOString(),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type AssignmentRow = Prisma.AssetAssignmentGetPayload<{
  include: typeof ASSET_ASSIGNMENT_INCLUDE;
}>;

export function toAssetAssignmentRecord(row: AssignmentRow): AssetAssignmentRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    employee: row.employee
      ? {
          id: row.employee.id,
          fullName: fullName(row.employee),
          employeeNumber: row.employee.employeeNumber,
        }
      : null,
    assignedAt: row.assignedAt.toISOString(),
    returnedAt: row.returnedAt?.toISOString() ?? null,
    assignedBy: row.assignedBy
      ? { id: row.assignedBy.id, fullName: fullName(row.assignedBy) }
      : null,
    returnedBy: row.returnedBy
      ? { id: row.returnedBy.id, fullName: fullName(row.returnedBy) }
      : null,
    conditionAtAssignment: (row.conditionAtAssignment as AssetCondition | null) ?? null,
    conditionAtReturn: (row.conditionAtReturn as AssetCondition | null) ?? null,
    accessoriesIssued: row.accessoriesIssued,
    accessoriesReturned: row.accessoriesReturned,
    accessoriesMissing: row.accessoriesMissing,
    damageDescription: row.damageDescription,
    notes: row.notes,
    returnNotes: row.returnNotes,
    reason: row.reason,
    status: row.status as AssetAssignmentStatus,
    acknowledgementStatus: row.acknowledgementStatus as AssetAcknowledgementStatus,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgedByName: row.acknowledgedBy ? fullName(row.acknowledgedBy) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  parentCategoryId: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  parent?: { name: string } | null;
  _count?: { assets: number };
}

export function toAssetCategoryRecord(
  row: CategoryRow,
  children: AssetCategoryRecord[] = [],
): AssetCategoryRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parentCategoryId: row.parentCategoryId,
    parentName: row.parent?.name ?? null,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    assetCount: row._count?.assets ?? 0,
    children,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The catalogue as a tree: groups in order, each with its types in order. */
export function toCategoryTree(rows: CategoryRow[]): AssetCategoryRecord[] {
  const byParent = new Map<string, CategoryRow[]>();
  for (const row of rows) {
    if (!row.parentCategoryId) continue;
    const siblings = byParent.get(row.parentCategoryId) ?? [];
    siblings.push(row);
    byParent.set(row.parentCategoryId, siblings);
  }

  return rows
    .filter((row) => !row.parentCategoryId)
    .map((group) =>
      toAssetCategoryRecord(
        group,
        (byParent.get(group.id) ?? []).map((child) => toAssetCategoryRecord(child)),
      ),
    );
}

// ---------------------------------------------------------------- validation

/**
 * Refuses an asset tag this company already uses.
 *
 * The unique index is what actually holds; this exists so the answer is a field
 * error on the form rather than a 500 from a constraint. Case-insensitive on
 * purpose: `IT-LAP-0042` and `it-lap-0042` on two different laptops is a
 * stock-take that never reconciles.
 */
export async function assertAssetTagIsFree(
  companyId: string,
  assetTag: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await prisma.asset.findFirst({
    where: {
      companyId,
      assetTag: { equals: assetTag, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw new ValidationError({ assetTag: ['An asset already carries that tag.'] });
  }
}

/**
 * Refuses a serial number this company already uses - WHEN ONE IS SUPPLIED.
 *
 * A null serial is not a duplicate of another null serial, which is both what
 * PostgreSQL does with the unique index and what is true about chairs.
 */
export async function assertSerialIsFree(
  companyId: string,
  serialNumber: string | null,
  exceptId: string | null,
): Promise<void> {
  if (serialNumber === null || serialNumber === '') return;

  const clash = await prisma.asset.findFirst({
    where: {
      companyId,
      serialNumber: { equals: serialNumber, mode: 'insensitive' },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw new ValidationError({
      serialNumber: ['Another asset already has that serial number.'],
    });
  }
}

/**
 * Proves the ids on a payload belong to this company before anything is written.
 *
 * A field error rather than a 500 from a foreign key, and - more to the point -
 * a company boundary: without this, a caller could file their asset under
 * another company's department by quoting its id.
 *
 * The category is checked for being ACTIVE as well on create. A retired category
 * keeps every asset already filed under it and takes no new ones; that is the
 * entire difference between retiring and deleting.
 */
export async function assertAssetReferences(
  companyId: string,
  input: {
    categoryId?: string;
    departmentId?: string | null;
    locationId?: string | null;
  },
  options: { requireActiveCategory: boolean },
): Promise<void> {
  const details: Record<string, string[]> = {};

  if (input.categoryId !== undefined) {
    const category = await prisma.assetCategory.findFirst({
      where: { id: input.categoryId, companyId },
      select: { id: true, isActive: true },
    });
    if (!category) {
      details.categoryId = ['That category does not exist.'];
    } else if (options.requireActiveCategory && !category.isActive) {
      details.categoryId = ['That category has been retired. Choose a live one.'];
    }
  }

  if (input.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: input.departmentId, companyId },
      select: { id: true },
    });
    if (!department) details.departmentId = ['That department does not exist.'];
  }

  if (input.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: input.locationId, companyId },
      select: { id: true },
    });
    if (!location) details.locationId = ['That location does not exist.'];
  }

  if (Object.keys(details).length > 0) throw new ValidationError(details);
}

/**
 * Warranty cannot end before it starts, checked against the STORED value.
 *
 * The schema refuses a payload carrying both ends out of order. It cannot refuse
 * a PATCH that moves one of them, because it has never seen the other - so this
 * runs on the merged pair, which is the only place the real answer exists.
 */
export function assertWarrantyOrder(start: Date | null, end: Date | null): void {
  if (start === null || end === null) return;
  if (end.getTime() < start.getTime()) {
    throw new ValidationError({ warrantyEnd: ['Warranty cannot end before it starts.'] });
  }
}

/**
 * Refuses a status move the lifecycle does not allow.
 *
 * Two separate refusals, and they fail for different reasons:
 *
 *   - ASSIGNED and RETURNED are CONSEQUENCES. They are written by assigning and
 *     returning, which also write the assignment row that says whose desk the
 *     thing is on. Typing either into the edit form would produce an asset
 *     marked as being with somebody, with no record of who - the exact state the
 *     assignment table exists to make impossible.
 *   - everything else is checked against `ASSET_STATUS_TRANSITIONS`, which is
 *     permissive about the middle of an asset's life and strict about its end:
 *     nothing comes back from DISPOSED.
 */
export function assertStatusTransition(from: AssetStatus, to: AssetStatus): void {
  if (from === to) return;

  if (isAssignmentDrivenStatus(to)) {
    throw new ValidationError({
      status: [
        'An asset becomes assigned or returned by assigning or returning it, not by editing it.',
      ],
    });
  }

  if (!canTransitionAsset(from, to)) {
    throw new ValidationError({
      status: [`An asset cannot go from ${from} to ${to}.`],
    });
  }
}

/** A date-only string as a `@db.Date` column value, pinned to UTC midnight. */
export function dateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

// ===========================================================================
// STEP 3 - filtering, in ONE place.
//
// Every screen that narrows the register - the list, the dashboard's
// drill-downs, both reports and both exports - builds its WHERE from the
// clauses below. That is the whole point of the section: a report whose filters
// were written a second time is a report that disagrees with the screen
// somebody exported it from, and the disagreement is discovered in a meeting.
// ===========================================================================

/**
 * Today, in the COMPANY's timezone.
 *
 * "Expiring within 30 days" is a calendar question and the calendar in question
 * is the office's. A UTC answer would move the boundary by up to a day for
 * every company that is not on UTC, which on a warranty list means an asset
 * appearing or vanishing depending on what time somebody opened the page.
 */
export async function assetToday(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const zone = company?.timezone;
  return todayInZone(zone && isValidTimeZone(zone) ? zone : 'UTC');
}

/** A `yyyy-MM-dd` day, `days` later. Pure, so a test can pin the day. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative once `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Free-text search, across the asset AND the person holding it.
 *
 * Section 11 asks that a search find an asset by tag, serial, name, employee
 * name or employee ID, and the last two are the reason this is not five
 * `contains` on the asset table. "Ahmed" is matched through the ACTIVE
 * assignment - an asset Ahmed handed back last year is not Ahmed's asset, and
 * returning it for his name would be a search that quietly answers a different
 * question from the one asked.
 *
 * `insensitive` `contains` rather than a full-text index, which is the honest
 * shape for a register of this size and matches what the rest of the product
 * does.
 */
export function assetSearchClause(term: string): Prisma.AssetWhereInput {
  const contains = { contains: term, mode: 'insensitive' as const };

  return {
    OR: [
      { assetTag: contains },
      { name: contains },
      { brand: contains },
      { model: contains },
      { serialNumber: contains },
      {
        assignments: {
          some: {
            status: 'ACTIVE',
            employee: {
              OR: [{ firstName: contains }, { lastName: contains }, { employeeNumber: contains }],
            },
          },
        },
      },
    ],
  };
}

/**
 * Where an asset stands on warranty, as a WHERE fragment.
 *
 * The four states partition the register: EXPIRING is a window INSIDE the
 * remaining warranty and ACTIVE deliberately excludes it, so the two counts can
 * be added without double-counting a laptop whose cover runs out a fortnight
 * from now. An asset with no `warrantyEnd` is in exactly one of them - NONE -
 * rather than quietly falling out of all four.
 */
export function assetWarrantyClause(
  filter: AssetWarrantyFilter,
  days: number,
  today: string,
): Prisma.AssetWhereInput {
  const start = dateColumn(today)!;
  const horizon = dateColumn(addDays(today, days))!;

  switch (filter) {
    case 'ACTIVE':
      return { warrantyEnd: { gt: horizon } };
    case 'EXPIRING':
      return { warrantyEnd: { gte: start, lte: horizon } };
    case 'EXPIRED':
      return { warrantyEnd: { lt: start } };
    case 'NONE':
      return { warrantyEnd: null };
    default:
      return {};
  }
}

/** The filters a register-shaped query carries. */
export interface AssetFilterInput {
  q?: string;
  status?: AssetStatus;
  condition?: AssetCondition;
  categoryId?: string;
  departmentId?: string;
  locationId?: string;
  employeeId?: string;
  unassigned?: boolean;
  warranty?: AssetWarrantyFilter;
  warrantyDays?: number;
  purchasedFrom?: string | null;
  purchasedTo?: string | null;
}

/**
 * Every filter, as an array of clauses to AND together.
 *
 * Returned as an array rather than as one object so a caller can add its own -
 * the company boundary, the caller's scope - without either side having to know
 * what the other put in. An absent filter contributes `{}`, which Prisma treats
 * as no constraint at all.
 */
export function assetFilterClauses(
  query: AssetFilterInput,
  today: string,
): Prisma.AssetWhereInput[] {
  return [
    query.status ? { status: query.status } : {},
    query.condition ? { condition: query.condition } : {},
    query.categoryId
      ? {
          // A group matches the types under it as well, so filtering by
          // "IT Equipment" returns the laptops rather than the nothing that is
          // filed directly against the group.
          OR: [
            { categoryId: query.categoryId },
            { category: { parentCategoryId: query.categoryId } },
          ],
        }
      : {},
    query.departmentId ? { departmentId: query.departmentId } : {},
    query.locationId ? { locationId: query.locationId } : {},
    query.employeeId
      ? { assignments: { some: { status: 'ACTIVE', employeeId: query.employeeId } } }
      : {},
    query.unassigned ? { assignments: { none: { status: 'ACTIVE' } } } : {},
    query.warranty ? assetWarrantyClause(query.warranty, query.warrantyDays ?? 30, today) : {},
    query.purchasedFrom ? { purchaseDate: { gte: dateColumn(query.purchasedFrom)! } } : {},
    query.purchasedTo ? { purchaseDate: { lte: dateColumn(query.purchasedTo)! } } : {},
    query.q ? assetSearchClause(query.q) : {},
  ];
}
