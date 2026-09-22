import { z } from 'zod';
import { paginationQuerySchema } from './common.js';
import type { EmployeeStatus } from './employee.js';

/**
 * Asset management: the things the company owns, and who is holding one.
 *
 * Two sentences decide the shape of everything below.
 *
 * AN ASSET'S STATUS AND ITS CONDITION ARE DIFFERENT QUESTIONS. Status says
 * where the asset is in the company's custody - available, out with somebody,
 * away being fixed, written off. Condition says what state the thing is in -
 * new, fine, scratched, broken. A laptop can perfectly well be ASSIGNED and
 * GOOD, ASSIGNED and DAMAGED, or AVAILABLE and CRITICAL, and collapsing the two
 * into one column is how a company ends up unable to answer "what have we got
 * that still works". They are separate enums and neither is derived from the
 * other.
 *
 * WHO HAS IT IS A HISTORY, NOT A COLUMN. There is deliberately no
 * `currentEmployeeId` on an asset. A laptop goes to Ahmed, comes back, and goes
 * to Sana; a column would record the last of those three facts and silently
 * destroy the first two, which are exactly the facts somebody needs when the
 * machine turns up with a cracked screen. The holder is the ACTIVE row in
 * `asset_assignments`, and the ones before it are still there.
 *
 * Step 1 builds the vocabulary, the records and the register. Assigning,
 * transferring, returning, repairing and disposing arrive in the steps after
 * it, which is why the status transition table below already names those moves
 * and no endpoint here performs one.
 */

// ------------------------------------------------------------------- status

/**
 * Where an asset is in the company's custody.
 *
 * Eight values and no free text, because this column is counted. "Under
 * repair", "under-repair" and "In repair" as three strings is a dashboard that
 * disagrees with itself, and the tiles on the assets page are a GROUP BY on
 * exactly this.
 *
 * RETURNED is worth a word: it is not a synonym for AVAILABLE. An asset that
 * has just come back off somebody's desk has not yet been looked at, and the
 * difference between "nobody has this" and "somebody handed this in and we have
 * not checked it" is the difference between handing it straight out again and
 * discovering the charger is missing. Somebody moves it to AVAILABLE on
 * purpose.
 */
export const ASSET_STATUSES = [
  'AVAILABLE',
  'ASSIGNED',
  'UNDER_REPAIR',
  'LOST',
  'DAMAGED',
  'RETURNED',
  'RETIRED',
  'DISPOSED',
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  AVAILABLE: 'Available',
  ASSIGNED: 'Assigned',
  UNDER_REPAIR: 'Under repair',
  LOST: 'Lost',
  DAMAGED: 'Damaged',
  RETURNED: 'Returned',
  RETIRED: 'Retired',
  DISPOSED: 'Disposed',
};

/** What each status means, written as a consequence rather than as an adjective. */
export const ASSET_STATUS_DESCRIPTIONS: Record<AssetStatus, string> = {
  AVAILABLE: 'In stock and ready to hand to somebody.',
  ASSIGNED: 'Out with an employee. There is an active assignment behind this.',
  UNDER_REPAIR: 'Away being fixed. Not available and not with anybody.',
  LOST: 'Unaccounted for. Still on the register, because writing it off is a decision.',
  DAMAGED: 'Broken and not fit to hand out. May still be repairable.',
  RETURNED: 'Handed back and not yet checked over. Not the same as available.',
  RETIRED: 'Taken out of service and kept. No longer issued to anybody.',
  DISPOSED: 'Gone - sold, scrapped or written off. The end of the record.',
};

/** The statuses where the company still expects to have the thing. */
export const ASSET_LIVE_STATUSES: readonly AssetStatus[] = [
  'AVAILABLE',
  'ASSIGNED',
  'UNDER_REPAIR',
  'DAMAGED',
  'RETURNED',
];

export function isAssetLive(status: AssetStatus): boolean {
  return ASSET_LIVE_STATUSES.includes(status);
}

/** The two endings. Nothing is deleted; an asset reaches one of these. */
export const ASSET_TERMINAL_STATUSES: readonly AssetStatus[] = ['RETIRED', 'DISPOSED'];

/**
 * Which status an asset may be moved to from where.
 *
 * Permissive about the middle of the life - a damaged machine goes for repair,
 * comes back available, gets issued again - and strict about the two things
 * that would produce a register nobody can trust:
 *
 *   - DISPOSED is the end. Nothing comes back from it. An asset that was
 *     scrapped and is then marked available again is either a second asset or
 *     a mistake, and both deserve somebody's attention rather than a silent
 *     edit.
 *   - RETIRED goes only to DISPOSED. Taking something out of service and then
 *     quietly issuing it again defeats the point of having retired it.
 *
 * LOST returns to AVAILABLE on purpose: things turn up.
 */
export const ASSET_STATUS_TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  AVAILABLE: ['ASSIGNED', 'UNDER_REPAIR', 'DAMAGED', 'LOST', 'RETIRED', 'DISPOSED'],
  ASSIGNED: ['RETURNED', 'UNDER_REPAIR', 'DAMAGED', 'LOST'],
  UNDER_REPAIR: ['AVAILABLE', 'ASSIGNED', 'DAMAGED', 'LOST', 'RETIRED', 'DISPOSED'],
  LOST: ['AVAILABLE', 'RETIRED', 'DISPOSED'],
  DAMAGED: ['UNDER_REPAIR', 'AVAILABLE', 'LOST', 'RETIRED', 'DISPOSED'],
  RETURNED: ['AVAILABLE', 'ASSIGNED', 'UNDER_REPAIR', 'DAMAGED', 'LOST', 'RETIRED', 'DISPOSED'],
  RETIRED: ['DISPOSED'],
  DISPOSED: [],
};

export function canTransitionAsset(from: AssetStatus, to: AssetStatus): boolean {
  return from === to || ASSET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The two statuses that are a CONSEQUENCE rather than a choice.
 *
 * An asset is ASSIGNED because there is an active assignment row behind it, and
 * RETURNED because that row was closed. Letting somebody type either one into
 * the edit form would produce an asset marked as being on a desk with no record
 * of whose desk - the exact thing the assignment table exists to prevent. The
 * edit endpoint refuses both; the assign and return endpoints in the next step
 * set them as a side effect of writing the assignment.
 */
export const ASSET_ASSIGNMENT_DRIVEN_STATUSES: readonly AssetStatus[] = ['ASSIGNED', 'RETURNED'];

export function isAssignmentDrivenStatus(status: AssetStatus): boolean {
  return ASSET_ASSIGNMENT_DRIVEN_STATUSES.includes(status);
}

// ---------------------------------------------------------------- condition

/**
 * What state the thing is actually in. Never the same question as its status.
 *
 * DAMAGED appears in both enums and that is not a duplication: the status says
 * "we are not issuing this to anybody", the condition says "the screen is
 * cracked". An asset can be assigned to somebody and in damaged condition,
 * which is how it usually happens.
 */
export const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'DAMAGED', 'CRITICAL'] as const;

export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

export const ASSET_CONDITION_LABELS: Record<AssetCondition, string> = {
  NEW: 'New',
  GOOD: 'Good',
  FAIR: 'Fair',
  DAMAGED: 'Damaged',
  CRITICAL: 'Critical',
};

export const ASSET_CONDITION_DESCRIPTIONS: Record<AssetCondition, string> = {
  NEW: 'Unused, or as good as.',
  GOOD: 'Working normally with ordinary wear.',
  FAIR: 'Working, but showing its age.',
  DAMAGED: 'Something is broken. Usable or not, it needs attention.',
  CRITICAL: 'Barely serviceable. Replace rather than repair.',
};

// --------------------------------------------------------------- assignment

/**
 * How one spell of somebody holding an asset ended - or that it has not.
 *
 * ACTIVE is the only one that means "they have it now", and exactly one
 * assignment per asset may be ACTIVE at a time. The other three are endings,
 * kept apart because the question six months later is not "did it come back"
 * but "what happened to it":
 *
 *   RETURNED    - they handed it in.
 *   TRANSFERRED - it went straight to somebody else without coming back.
 *   WRITTEN_OFF - it never came back: lost, destroyed, or the person left with
 *                 it. The assignment ends; the asset's own status records what
 *                 the company decided about the thing itself.
 */
export const ASSET_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'RETURNED',
  'TRANSFERRED',
  'WRITTEN_OFF',
] as const;

export type AssetAssignmentStatus = (typeof ASSET_ASSIGNMENT_STATUSES)[number];

export const ASSET_ASSIGNMENT_STATUS_LABELS: Record<AssetAssignmentStatus, string> = {
  ACTIVE: 'Currently held',
  RETURNED: 'Returned',
  TRANSFERRED: 'Transferred on',
  WRITTEN_OFF: 'Written off',
};

// ---------------------------------------------------------- default catalogue

/**
 * The categories a company starts with.
 *
 * DATA, not a hard-coded dropdown. Every name below becomes an `asset_categories`
 * row the first time a company is seeded, and from that moment it is the
 * company's to rename, reorder or retire. Nothing in the API or the UI matches
 * on any string in this list, which is the property that makes it a starting
 * point rather than the truth - see `assets.seed.ts`, which is additive and
 * never rewrites a category somebody has edited.
 *
 * Two levels, the same shape the helpdesk catalogue uses: a GROUP that means
 * something to whoever is reading a report ("what are we spending on IT kit"),
 * and the TYPE underneath it that somebody actually picks on a form. An asset
 * may point at either level, because a company that only wants "Vehicles" and
 * never "Car" should not be made to invent a second row.
 */
export interface AssetCategorySeedGroup {
  name: string;
  description?: string;
  types: readonly string[];
}

export const DEFAULT_ASSET_CATEGORY_CATALOGUE: readonly AssetCategorySeedGroup[] = [
  {
    name: 'IT Equipment',
    description: 'Computers, peripherals and anything with a serial number on the back.',
    types: [
      'Laptop',
      'Desktop',
      'Monitor',
      'Keyboard',
      'Mouse',
      'Headset',
      'Mobile Phone',
      'Tablet',
      'Printer',
      'UPS',
      'Router',
      'External Hard Drive',
    ],
  },
  {
    name: 'Office Equipment',
    description: 'Furniture and the fittings of a working desk or room.',
    types: ['Desk', 'Chair', 'Cabinet', 'Meeting Room Equipment'],
  },
  {
    name: 'Vehicles',
    description: 'Company vehicles issued to staff or kept for company use.',
    types: ['Car', 'Bike'],
  },
  {
    name: 'Other',
    description: 'Everything that is still company property and fits nowhere above.',
    types: ['Access Card', 'SIM', 'Other Equipment'],
  },
];

// ------------------------------------------------------------------ payloads

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value));

const optionalId = optionalText(64);

/** An ISO date or a yyyy-MM-dd input value; empty becomes null. */
const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
    message: 'Enter a valid date.',
  });

/**
 * Money, and never below zero.
 *
 * Section 9 asks for this twice - a purchase price and a current value - and
 * the reason it is worth stating in the schema rather than trusting a form is
 * that a negative asset value does not fail loudly anywhere. It quietly
 * subtracts from whatever total somebody is reporting upwards.
 */
const optionalMoney = (message: string) =>
  z.coerce
    .number()
    .min(0, message)
    .max(999_999_999)
    .nullish()
    .transform((value) => (value === undefined ? null : value));

// --- categories ---

export const assetCategoryCreateSchema = z.object({
  name: z.string().trim().min(1, 'A category name is required.').max(120),
  description: optionalText(500),
  /** Null for a group; set to make this a type under that group. */
  parentCategoryId: optionalId,
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

export type AssetCategoryCreateInput = z.infer<typeof assetCategoryCreateSchema>;

/**
 * Editing a category. `isActive: false` is how one is RETIRED.
 *
 * There is no delete endpoint and no `parentCategoryId` here. Assets point at
 * categories, so removing one would orphan them and re-parenting one would
 * silently move every asset filed under it into a different report. Retiring
 * takes it off the create form and leaves every asset that already carries it
 * exactly where it is.
 */
export const assetCategoryUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'A category name is required.').max(120).optional(),
    description: optionalText(500),
    sortOrder: z.coerce.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  })
  // Absent means leave alone. See the note on `jobOpeningUpdateSchema`: without
  // this, the transforms above turn a one-field PATCH into a dozen nulls.
  .partial();

export type AssetCategoryUpdateInput = z.infer<typeof assetCategoryUpdateSchema>;

// --- assets ---

/**
 * The shape of a new asset.
 *
 * Four things are required and the rest is optional, which is deliberate: an
 * asset arrives on somebody's desk long before the invoice and the warranty
 * paperwork catch up, and a form that insists on a purchase price is a form
 * people work around by typing a zero.
 */
const assetFields = {
  /**
   * The label physically stuck on the thing. Unique per company, and the only
   * identifier a person will ever quote out loud.
   */
  assetTag: z.string().trim().min(1, 'An asset tag is required.').max(40),
  name: z.string().trim().min(1, 'A name is required.').max(160),
  categoryId: z.string().trim().min(1, 'Choose a category.').max(64),
  brand: optionalText(80),
  model: optionalText(80),
  /**
   * The manufacturer's serial. Optional, because a chair has none - and unique
   * within the company WHEN PRESENT, which PostgreSQL gives for free: NULLs are
   * distinct, so a hundred chairs with no serial do not collide while two
   * laptops with the same one do.
   */
  serialNumber: optionalText(120),
  purchaseDate: optionalDate,
  purchasePrice: optionalMoney('A purchase price cannot be negative.'),
  currentValue: optionalMoney('A current value cannot be negative.'),
  vendor: optionalText(160),
  warrantyStart: optionalDate,
  warrantyEnd: optionalDate,
  /**
   * Where the thing physically is, in two parts and on purpose.
   *
   * `locationId` is a real organisation Location - which office - so "what is
   * in Lahore" is a join rather than a string comparison. `location` is the
   * free text beneath it: a desk, a room, a shelf. Neither substitutes for the
   * other, and the office is pointed at rather than copied for the reason the
   * rest of this product points at departments.
   */
  locationId: optionalId,
  location: optionalText(160),
  departmentId: optionalId,
  condition: z.enum(ASSET_CONDITIONS).default('GOOD'),
  notes: optionalText(4000),
};

const warrantyOrder = (value: {
  warrantyStart: string | null;
  warrantyEnd: string | null;
}): boolean =>
  value.warrantyStart === null ||
  value.warrantyEnd === null ||
  Date.parse(value.warrantyEnd) >= Date.parse(value.warrantyStart);

export const assetCreateSchema = z
  .object({
    ...assetFields,
    /**
     * A new asset starts AVAILABLE unless it arrived already broken or already
     * away being fixed. ASSIGNED is refused here and in the route: an asset is
     * assigned by assigning it to somebody, which writes an assignment row.
     */
    status: z.enum(ASSET_STATUSES).default('AVAILABLE'),
  })
  .refine(warrantyOrder, {
    path: ['warrantyEnd'],
    message: 'Warranty cannot end before it starts.',
  });

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = z
  .object({
    assetTag: z.string().trim().min(1, 'An asset tag is required.').max(40).optional(),
    name: z.string().trim().min(1, 'A name is required.').max(160).optional(),
    categoryId: z.string().trim().min(1, 'Choose a category.').max(64).optional(),
    brand: assetFields.brand,
    model: assetFields.model,
    serialNumber: assetFields.serialNumber,
    purchaseDate: assetFields.purchaseDate,
    purchasePrice: assetFields.purchasePrice,
    currentValue: assetFields.currentValue,
    vendor: assetFields.vendor,
    warrantyStart: assetFields.warrantyStart,
    warrantyEnd: assetFields.warrantyEnd,
    locationId: assetFields.locationId,
    location: assetFields.location,
    departmentId: assetFields.departmentId,
    condition: z.enum(ASSET_CONDITIONS).optional(),
    status: z.enum(ASSET_STATUSES).optional(),
    notes: assetFields.notes,
  })
  .partial()
  /*
   * Only checkable when the PATCH carries BOTH ends. A request that moves one
   * of them is checked against the stored other by the route, which is the only
   * place that knows it - see `assertWarrantyOrder` in the service.
   */
  .refine(
    (value) =>
      value.warrantyStart === undefined ||
      value.warrantyEnd === undefined ||
      warrantyOrder({ warrantyStart: value.warrantyStart, warrantyEnd: value.warrantyEnd }),
    { path: ['warrantyEnd'], message: 'Warranty cannot end before it starts.' },
  );

export type AssetUpdateInput = z.infer<typeof assetUpdateSchema>;

/** Sortable columns. A client can never sort by a column that is not here. */
export const ASSET_SORT_FIELDS = [
  'assetTag',
  'name',
  'status',
  'condition',
  'purchaseDate',
  'purchasePrice',
  'currentValue',
  'createdAt',
] as const;

/**
 * How a warranty narrows the register.
 *
 * Four answers to one question - "where does this asset stand on warranty" -
 * and they partition the register rather than overlapping: every asset has
 * exactly one of them on any given day. EXPIRING is a slice of the assets still
 * in warranty, so an asset counted there is deliberately NOT counted in ACTIVE;
 * a filter whose options overlap is a filter whose counts cannot be added up.
 */
export const ASSET_WARRANTY_FILTERS = ['ACTIVE', 'EXPIRING', 'EXPIRED', 'NONE'] as const;

export type AssetWarrantyFilter = (typeof ASSET_WARRANTY_FILTERS)[number];

export const ASSET_WARRANTY_FILTER_LABELS: Record<AssetWarrantyFilter, string> = {
  ACTIVE: 'In warranty',
  EXPIRING: 'Expiring soon',
  EXPIRED: 'Out of warranty',
  NONE: 'No warranty recorded',
};

/**
 * How many days ahead counts as "expiring soon".
 *
 * Thirty days by default, and the default is the only thing that is fixed: the
 * window travels as a query parameter, so the dashboard can offer a month, a
 * quarter or half a year without either end hard-coding a number. It is NOT a
 * column on `companies` - that would be a schema change to the company module
 * for a figure two screens read, and the per-view control answers the same
 * question without one.
 */
export const ASSET_WARRANTY_ALERT_DAYS = 30;

/** The windows the dashboard offers. The first is the default. */
export const ASSET_WARRANTY_WINDOWS = [30, 60, 90, 180] as const;

/** A warranty window as a query parameter, clamped to something sensible. */
export const warrantyDaysSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(365)
  .default(ASSET_WARRANTY_ALERT_DAYS);

/**
 * The filters the register accepts, and the ONLY ones it accepts.
 *
 * Every one of them is applied by the database, before the page is cut. That
 * ordering is the whole reason the list endpoint and the count endpoint share a
 * `where` object: a filter applied to the rows AFTER they arrive produces the
 * failure this schema exists to prevent - a footer that says "1 to 20 of 80"
 * above twelve rows, because sixty-eight of the eighty never matched and eight
 * of the twenty were thrown away in the browser.
 */
export const assetQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ASSET_STATUSES).optional(),
  condition: z.enum(ASSET_CONDITIONS).optional(),
  categoryId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  locationId: z.string().trim().max(64).optional(),
  /** Assets currently out with one person. */
  employeeId: z.string().trim().max(64).optional(),
  /** `true` narrows to assets nobody is holding right now. */
  unassigned: z.coerce.boolean().optional(),
  /** Where the asset stands on warranty, as at today. */
  warranty: z.enum(ASSET_WARRANTY_FILTERS).optional(),
  /** What EXPIRING means, in days. Ignored by every other warranty filter. */
  warrantyDays: warrantyDaysSchema,
});

export type AssetQuery = z.infer<typeof assetQuerySchema>;

// ------------------------------------------------------------------- records

export interface AssetCategoryRecord {
  id: string;
  name: string;
  description: string | null;
  parentCategoryId: string | null;
  /** The group this type sits under, for a flat list that still reads sensibly. */
  parentName: string | null;
  sortOrder: number;
  /** Retired rather than deleted. A retired category keeps its assets. */
  isActive: boolean;
  /** Assets filed directly under this category. Why a delete is refused. */
  assetCount: number;
  children: AssetCategoryRecord[];
  createdAt: string;
  updatedAt: string;
}

/** The person holding an asset right now, as much of them as a list needs. */
export interface AssetHolder {
  assignmentId: string;
  employeeId: string;
  employeeNumber: string | null;
  fullName: string;
  departmentName: string | null;
  assignedAt: string;
}

export interface AssetRecord {
  id: string;
  assetTag: string;
  name: string;
  category: { id: string; name: string; parentName: string | null } | null;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  currentValue: number | null;
  vendor: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
  location: string | null;
  site: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  condition: AssetCondition;
  status: AssetStatus;
  notes: string | null;
  /**
   * Who has it now, or null. Read from the ACTIVE assignment rather than from a
   * column on the asset - there is no such column, on purpose.
   */
  holder: AssetHolder | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One asset, with its handover history.
 *
 * The history is served only to a reader who may see the whole register. An
 * employee holding a laptop has no business reading which colleague had it
 * before them or what state they handed it back in, so for them the list is
 * empty - and empty because the rows were never fetched, not because they were
 * fetched and then filtered.
 */
export interface AssetDetailRecord extends AssetRecord {
  assignments: AssetAssignmentRecord[];
  repairs: AssetRepairRecord[];
  incidents: AssetIncidentRecord[];
  retiredOn: string | null;
  retiredReason: string | null;
  disposal: AssetDisposalRecord | null;
  /** What this reader may do with it, decided by the server. See `AssetActions`. */
  can: AssetActions;
}

export interface AssetAssignmentRecord {
  id: string;
  assetId: string;
  employee: { id: string; fullName: string; employeeNumber: string | null } | null;
  assignedAt: string;
  returnedAt: string | null;
  assignedBy: { id: string; fullName: string } | null;
  returnedBy: { id: string; fullName: string } | null;
  conditionAtAssignment: AssetCondition | null;
  conditionAtReturn: AssetCondition | null;
  /** What went out with it, what came back, and what did not. */
  accessoriesIssued: string[];
  accessoriesReturned: string[];
  accessoriesMissing: string[];
  damageDescription: string | null;
  notes: string | null;
  returnNotes: string | null;
  /** Why it moved on, when it was transferred rather than handed back. */
  reason: string | null;
  status: AssetAssignmentStatus;
  acknowledgementStatus: AssetAcknowledgementStatus;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  createdAt: string;
}

/**
 * The four tiles above the register.
 *
 * Computed by one grouped query on the server rather than by counting the
 * current page, so the numbers describe the whole register the reader may see
 * and cannot disagree with the table underneath them.
 */
export interface AssetSummary {
  total: number;
  byStatus: Record<AssetStatus, number>;
  /**
   * What the register cost, and what it is reckoned to be worth now.
   *
   * Summed over the same narrowed WHERE the counts use, so the money and the
   * counts describe the same set of assets. An asset with no price recorded
   * contributes nothing rather than a zero that would be indistinguishable from
   * a laptop somebody was given.
   */
  totalPurchaseValue: number;
  totalCurrentValue: number;
}

export const EMPTY_ASSET_SUMMARY: AssetSummary = {
  total: 0,
  totalPurchaseValue: 0,
  totalCurrentValue: 0,
  byStatus: {
    AVAILABLE: 0,
    ASSIGNED: 0,
    UNDER_REPAIR: 0,
    LOST: 0,
    DAMAGED: 0,
    RETURNED: 0,
    RETIRED: 0,
    DISPOSED: 0,
  },
};

// ===========================================================================
// STEP 2 - the lifecycle: handing an asset over, taking it back, and what
// happens to it in between.
// ===========================================================================

/**
 * The statuses an asset may be handed to somebody FROM.
 *
 * Two, and the shortness is the rule rather than an omission. AVAILABLE is
 * stock. RETURNED is stock that has come back and been looked at - it can go
 * straight out again, which is what actually happens when somebody leaves on
 * Friday and a starter arrives on Monday.
 *
 * Everything else is refused, and each refusal is a business rule section 14
 * asks for by name:
 *
 *   DISPOSED     - it does not exist any more.
 *   RETIRED      - it was taken out of service on purpose. Issuing it again
 *                  would make the retirement meaningless.
 *   LOST         - nobody knows where it is. Assigning it would be a written
 *                  claim that somebody is holding a thing we cannot find. It
 *                  becomes assignable again by being FOUND - an explicit move
 *                  back to AVAILABLE, which is the recovery step.
 *   DAMAGED      - it is broken. Send it for repair first.
 *   UNDER_REPAIR - it is not here.
 *   ASSIGNED     - somebody already has it. This is the one the database
 *                  itself enforces; see `asset_assignments` in the schema.
 */
export const ASSET_ASSIGNABLE_STATUSES: readonly AssetStatus[] = ['AVAILABLE', 'RETURNED'];

export function isAssetAssignable(status: AssetStatus): boolean {
  return ASSET_ASSIGNABLE_STATUSES.includes(status);
}

/** Why an asset in this state cannot be handed to anybody, in a person's words. */
export const ASSET_NOT_ASSIGNABLE_REASON: Record<AssetStatus, string | null> = {
  AVAILABLE: null,
  RETURNED: null,
  ASSIGNED: 'Somebody already has this asset. Return or transfer it first.',
  UNDER_REPAIR: 'This asset is away being repaired.',
  DAMAGED: 'This asset is damaged. Send it for repair before issuing it again.',
  LOST: 'This asset is recorded as lost. Mark it found before issuing it again.',
  RETIRED: 'This asset has been retired from service.',
  DISPOSED: 'This asset has been disposed of.',
};

/**
 * Where an asset can land when it comes back.
 *
 * Not simply AVAILABLE, and the distinction is the one Step 1 drew: something
 * handed in has not necessarily been checked. RETURNED is the honest default -
 * it says a person has it back and nobody has counted the accessories yet.
 * AVAILABLE is a positive claim that it was checked and is fit to go out again,
 * and the server refuses that claim when the same form says the charger is
 * missing or the machine is damaged.
 */
export const ASSET_RETURN_OUTCOMES = ['RETURNED', 'AVAILABLE', 'DAMAGED'] as const;

export type AssetReturnOutcome = (typeof ASSET_RETURN_OUTCOMES)[number];

export const ASSET_RETURN_OUTCOME_LABELS: Record<AssetReturnOutcome, string> = {
  RETURNED: 'Returned - not checked yet',
  AVAILABLE: 'Checked and back in stock',
  DAMAGED: 'Came back damaged',
};

/** The conditions that make "checked and back in stock" a false claim. */
export const ASSET_UNFIT_CONDITIONS: readonly AssetCondition[] = ['DAMAGED', 'CRITICAL'];

// ------------------------------------------------------------- accessories

/**
 * What goes out WITH an asset.
 *
 * A suggestion list, not a closed set, and that is deliberate: accessories are
 * whatever was in the box, and a company that issues a docking station should
 * not need a release to record one. The UI offers these as tick boxes and takes
 * anything else as free text; the column is a string array, so nothing here is
 * load-bearing in the database.
 *
 * Stored on the ASSIGNMENT rather than on the asset, because a charger is part
 * of a handover rather than part of a laptop. The same laptop can go out with a
 * bag in March and without one in September, and only the assignment can say
 * which.
 */
export const ASSET_ACCESSORY_SUGGESTIONS = [
  'Laptop charger',
  'Laptop bag',
  'Mouse',
  'Keyboard',
  'HDMI cable',
  'Power adapter',
  'SIM',
  'Other',
] as const;

/** Tidies a list of accessories: trimmed, de-duplicated, blanks dropped. */
export function normaliseAccessories(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '') continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * What went out and did not come back.
 *
 * Computed rather than typed, so the "missing" list on a return form cannot
 * disagree with the two lists above it. A person may still add something by
 * hand - a cable nobody recorded issuing can still go missing - which is why
 * the server takes the extras and unions them rather than recomputing and
 * discarding.
 */
export function missingAccessories(
  issued: readonly string[],
  returned: readonly string[],
): string[] {
  const back = new Set(returned.map((value) => value.trim().toLowerCase()));
  return issued.filter((value) => !back.has(value.trim().toLowerCase()));
}

// ------------------------------------------------------- acknowledgement

/**
 * Whether the person holding an asset has said they have it.
 *
 * Three states and the third is the point. A handover where the employee says
 * "this arrived with a cracked lid" is not an un-acknowledged handover and it
 * is not an acknowledged one either - it is a disagreement, and a two-state
 * flag would have to round it to one of those. ISSUE_REPORTED keeps it visible
 * until somebody deals with it.
 */
export const ASSET_ACKNOWLEDGEMENT_STATUSES = [
  'PENDING',
  'ACKNOWLEDGED',
  'ISSUE_REPORTED',
] as const;

export type AssetAcknowledgementStatus = (typeof ASSET_ACKNOWLEDGEMENT_STATUSES)[number];

export const ASSET_ACKNOWLEDGEMENT_STATUS_LABELS: Record<AssetAcknowledgementStatus, string> = {
  PENDING: 'Awaiting acknowledgement',
  ACKNOWLEDGED: 'Acknowledged',
  ISSUE_REPORTED: 'Issue reported',
};

// -------------------------------------------------------------- repairs

export const ASSET_REPAIR_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

export type AssetRepairStatus = (typeof ASSET_REPAIR_STATUSES)[number];

export const ASSET_REPAIR_STATUS_LABELS: Record<AssetRepairStatus, string> = {
  IN_PROGRESS: 'Away being repaired',
  COMPLETED: 'Back from repair',
  CANCELLED: 'Repair called off',
};

// ------------------------------------------------------------- incidents

/**
 * Something went wrong with an asset, and here is the record of it.
 *
 * One table for three events that are the same shape - a date, a reason, a
 * description and whoever said so - rather than three. What separates them is
 * WHO writes one and what it does to the asset:
 *
 *   ISSUE_REPORTED - the employee holding it, from their own screen. Changes
 *                    nothing about the asset: an employee cannot alter its
 *                    condition, its value or its status, and saying "the
 *                    charger is buzzing" must not silently do so.
 *   DAMAGED        - somebody with `asset.update`. Moves the asset to DAMAGED.
 *   LOST           - the same grant. Moves the asset to LOST.
 */
export const ASSET_INCIDENT_KINDS = ['ISSUE_REPORTED', 'DAMAGED', 'LOST'] as const;

export type AssetIncidentKind = (typeof ASSET_INCIDENT_KINDS)[number];

export const ASSET_INCIDENT_KIND_LABELS: Record<AssetIncidentKind, string> = {
  ISSUE_REPORTED: 'Issue reported',
  DAMAGED: 'Reported damaged',
  LOST: 'Reported lost',
};

/** The two an administrator files. The third is the employee's own. */
export const ASSET_ADMIN_INCIDENT_KINDS: readonly AssetIncidentKind[] = ['DAMAGED', 'LOST'];

// -------------------------------------------------------------- disposal

export const ASSET_DISPOSAL_METHODS = [
  'SOLD',
  'SCRAPPED',
  'DONATED',
  'RECYCLED',
  'OTHER',
] as const;

export type AssetDisposalMethod = (typeof ASSET_DISPOSAL_METHODS)[number];

export const ASSET_DISPOSAL_METHOD_LABELS: Record<AssetDisposalMethod, string> = {
  SOLD: 'Sold',
  SCRAPPED: 'Scrapped',
  DONATED: 'Donated',
  RECYCLED: 'Recycled',
  OTHER: 'Other',
};

// ------------------------------------------------------------- documents

/**
 * What a file attached to an asset is.
 *
 * Section 13 asks that the EXISTING document infrastructure be used and that no
 * second storage system be built. These are the labels; everything underneath -
 * the object store, the byte sniffing, the size ceiling, the accepted formats -
 * is the case-attachment path the candidate documents already reuse, with a
 * different key prefix and a different permission.
 */
export const ASSET_DOCUMENT_TYPES = [
  'INVOICE',
  'PURCHASE_RECEIPT',
  'WARRANTY',
  'REPAIR_RECEIPT',
  'HANDOVER',
  'OTHER',
] as const;

export type AssetDocumentType = (typeof ASSET_DOCUMENT_TYPES)[number];

export const ASSET_DOCUMENT_TYPE_LABELS: Record<AssetDocumentType, string> = {
  INVOICE: 'Invoice',
  PURCHASE_RECEIPT: 'Purchase receipt',
  WARRANTY: 'Warranty',
  REPAIR_RECEIPT: 'Repair receipt',
  HANDOVER: 'Handover document',
  OTHER: 'Other',
};

export const ASSET_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_DOCUMENT_MAX_PER_ASSET = 20;

export const ASSET_DOCUMENT_TOO_LARGE_MESSAGE =
  'That file is larger than 10 MB. Compress it or attach a smaller copy.';

export const ASSET_DOCUMENT_TOO_MANY_MESSAGE = `An asset can carry ${ASSET_DOCUMENT_MAX_PER_ASSET} documents. Remove one before adding another.`;

// ---------------------------------------------------------------- payloads

const requiredDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.');

const accessoryList = z
  .array(z.string().trim().max(120))
  .max(30, 'That is more accessories than an asset can carry.')
  .default([])
  .transform(normaliseAccessories);

/** Handing an asset to somebody. */
export const assetAssignSchema = z.object({
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  assignedOn: requiredDay,
  /**
   * The state it went out in. Required, and deliberately so: a handover with no
   * recorded condition is a handover nobody can argue about later, which in
   * practice means the employee loses the argument.
   */
  conditionAtAssignment: z.enum(ASSET_CONDITIONS),
  accessories: accessoryList,
  notes: optionalText(2000),
});

export type AssetAssignInput = z.infer<typeof assetAssignSchema>;

/** Taking one back. */
export const assetReturnSchema = z
  .object({
    returnedOn: requiredDay,
    conditionAtReturn: z.enum(ASSET_CONDITIONS),
    /** What actually came back. Anything issued and not listed is missing. */
    accessoriesReturned: accessoryList,
    /** Things that went missing and were never recorded as issued. */
    additionalMissing: accessoryList,
    damageDescription: optionalText(2000),
    notes: optionalText(2000),
    outcome: z.enum(ASSET_RETURN_OUTCOMES).default('RETURNED'),
  })
  /*
   * "Checked and back in stock" is a positive claim, and this refuses it when
   * the same form contradicts it. The alternative is a register where an asset
   * with a cracked screen sits in AVAILABLE waiting to be handed to the next
   * person, which is the failure this whole module exists to prevent.
   */
  .refine(
    (value) =>
      value.outcome !== 'AVAILABLE' || !ASSET_UNFIT_CONDITIONS.includes(value.conditionAtReturn),
    {
      path: ['outcome'],
      message: 'An asset in that condition cannot go straight back into stock.',
    },
  );

export type AssetReturnInput = z.infer<typeof assetReturnSchema>;

/** Moving one straight from one person to another. */
export const assetTransferSchema = z.object({
  toEmployeeId: z.string().trim().min(1, 'Choose who is receiving it.').max(64),
  transferredOn: requiredDay,
  conditionAtTransfer: z.enum(ASSET_CONDITIONS),
  /** A transfer always has a reason - somebody asked for this to happen. */
  reason: z.string().trim().min(1, 'Say why it is being transferred.').max(500),
  /** What goes on with it. Defaults on the form to what went out originally. */
  accessories: accessoryList,
  notes: optionalText(2000),
});

export type AssetTransferInput = z.infer<typeof assetTransferSchema>;

/** The employee saying they have it. Carries nothing about the asset. */
export const assetAcknowledgeSchema = z.object({
  notes: optionalText(1000),
});

/**
 * The employee saying something is wrong with it.
 *
 * Note what this payload cannot carry: a condition, a status, a value, or any
 * other field on the asset. An employee reports what they see; somebody with
 * `asset.update` decides what the register says.
 */
export const assetIssueReportSchema = z.object({
  reason: z.string().trim().min(1, 'Say briefly what is wrong.').max(200),
  description: optionalText(2000),
});

/** Sending an asset away to be fixed. */
export const assetRepairSendSchema = z.object({
  problem: z.string().trim().min(1, 'Say what is wrong with it.').max(500),
  reportedOn: requiredDay,
  sentOn: requiredDay,
  vendor: optionalText(160),
  estimatedCost: optionalMoney('An estimate cannot be negative.'),
  expectedReturnOn: optionalDate,
  notes: optionalText(2000),
});

export type AssetRepairSendInput = z.infer<typeof assetRepairSendSchema>;

/**
 * Recording what happened to it.
 *
 * COMPLETED puts the asset back where it was before it left - ASSIGNED if
 * somebody still has it on paper, AVAILABLE if nobody did. CANCELLED does the
 * same: a repair that never happened must not strand the asset in UNDER_REPAIR
 * forever.
 */
export const assetRepairCompleteSchema = z.object({
  status: z.enum(['COMPLETED', 'CANCELLED']),
  returnedOn: requiredDay,
  actualCost: optionalMoney('A repair cost cannot be negative.'),
  /** What the asset is like now it is back. */
  condition: z.enum(ASSET_CONDITIONS).optional(),
  completionNotes: optionalText(2000),
});

export type AssetRepairCompleteInput = z.infer<typeof assetRepairCompleteSchema>;

/** Marking an asset lost or damaged. Never deletes anything. */
export const assetIncidentSchema = z.object({
  kind: z.enum(['DAMAGED', 'LOST']),
  occurredOn: requiredDay,
  reason: z.string().trim().min(1, 'Say what happened.').max(200),
  description: optionalText(4000),
  notes: optionalText(2000),
});

export type AssetIncidentInput = z.infer<typeof assetIncidentSchema>;

/** Taking an asset out of service while the company still holds it. */
export const assetRetireSchema = z.object({
  retiredOn: requiredDay,
  reason: z.string().trim().min(1, 'Say why it is being retired.').max(500),
  notes: optionalText(2000),
});

export type AssetRetireInput = z.infer<typeof assetRetireSchema>;

/** Writing one off for good. */
export const assetDisposeSchema = z.object({
  disposedOn: requiredDay,
  method: z.enum(ASSET_DISPOSAL_METHODS),
  reason: z.string().trim().min(1, 'Say why it is being disposed of.').max(500),
  /** What it fetched, or nothing. Zero is a real answer; blank is "not stated". */
  finalValue: optionalMoney('A disposal value cannot be negative.'),
  /** Whoever in the company signed it off. An employee, pointed at. */
  approvedByEmployeeId: optionalId,
  notes: optionalText(2000),
});

export type AssetDisposeInput = z.infer<typeof assetDisposeSchema>;

export const assetDocumentUploadQuerySchema = z.object({
  filename: z.string().trim().max(200).optional(),
  type: z.enum(ASSET_DOCUMENT_TYPES).optional(),
  repairId: z.string().trim().max(64).optional(),
});

// ----------------------------------------------------------------- records

export interface AssetRepairRecord {
  id: string;
  assetId: string;
  problem: string;
  reportedOn: string;
  sentOn: string;
  expectedReturnOn: string | null;
  returnedOn: string | null;
  vendor: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  notes: string | null;
  completionNotes: string | null;
  status: AssetRepairStatus;
  /** What the asset goes back to when the repair ends. */
  statusBeforeRepair: AssetStatus;
  sentBy: { id: string; fullName: string } | null;
  completedBy: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface AssetIncidentRecord {
  id: string;
  assetId: string;
  assignmentId: string | null;
  kind: AssetIncidentKind;
  occurredOn: string;
  reason: string;
  description: string | null;
  notes: string | null;
  reportedBy: { id: string; fullName: string } | null;
  reportedByEmployee: { id: string; fullName: string } | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  createdAt: string;
}

export interface AssetDocumentRecord {
  id: string;
  type: AssetDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  repairId: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

/**
 * One line of the asset's story.
 *
 * Read back from `audit_logs` rather than from a table of its own - see the
 * note in the step 1 migration. Every asset action writes one audit row, and
 * this is that trail shaped for a reader: a day, a sentence, and who did it.
 */
export interface AssetActivityEvent {
  id: string;
  action: string;
  summary: string;
  actorName: string | null;
  at: string;
}

/** The disposal block, present only on an asset that has one. */
export interface AssetDisposalRecord {
  disposedOn: string;
  method: AssetDisposalMethod;
  reason: string;
  finalValue: number | null;
  approvedBy: { id: string; fullName: string } | null;
  notes: string | null;
}

/**
 * Which actions the server will actually accept for this asset, from this
 * caller, right now.
 *
 * Computed server-side from the grant AND the asset's state, so a button is
 * offered only when pressing it would work. The alternative - the browser
 * reasoning about statuses - is two copies of the rule that eventually
 * disagree, and the copy a person sees is the wrong one.
 */
export interface AssetActions {
  assign: boolean;
  transfer: boolean;
  returnToStock: boolean;
  repair: boolean;
  markLostOrDamaged: boolean;
  retire: boolean;
  dispose: boolean;
  update: boolean;
  manageDocuments: boolean;
}

// ------------------------------------------------- an employee's own assets

/** One row of somebody's asset list, on their profile or their dashboard. */
export interface EmployeeAssetRow {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  name: string;
  categoryName: string | null;
  serialNumber: string | null;
  assignedAt: string;
  returnedAt: string | null;
  conditionAtAssignment: AssetCondition | null;
  conditionAtReturn: AssetCondition | null;
  accessoriesIssued: string[];
  accessoriesMissing: string[];
  assignmentStatus: AssetAssignmentStatus;
  assetStatus: AssetStatus;
  acknowledgementStatus: AssetAcknowledgementStatus;
  acknowledgedAt: string | null;
  /** What it is reckoned to be worth, for the total below. */
  currentValue: number | null;
}

/**
 * Asset clearance, for somebody on their way out.
 *
 * Counts, never actions. Section 11 is explicit that nothing here marks an
 * asset returned - a clearance screen that could tick its own boxes would be a
 * screen that says the laptop came back when it did not. HR records the real
 * return through the return endpoint, and this counts the result.
 */
export interface EmployeeAssetClearance {
  /** True when the person is on notice or has left: RESIGNED or TERMINATED. */
  applies: boolean;
  assigned: number;
  returned: number;
  pending: number;
  damaged: number;
  lost: number;
  /** Nothing outstanding. The only state in which clearance is complete. */
  cleared: boolean;
  /** The headline, in one word. See `ASSET_CLEARANCE_STATES`. */
  state: AssetClearanceState;
}

/**
 * Clearance in one word, for the badge at the top of the block.
 *
 * Three states rather than the boolean underneath them, because "some of it has
 * come back" is the state an exit interview is actually conducted in and a
 * two-valued flag reports it as PENDING - indistinguishable from somebody who
 * has handed back nothing at all. The distinction is what tells HR whether the
 * conversation is "where is everything" or "we are waiting on the monitor".
 *
 * Derived, never stored, and never an action: nothing anywhere in this module
 * writes a clearance state. It is counted from the handovers, so the only way
 * to move it is to record a real return.
 */
export const ASSET_CLEARANCE_STATES = ['CLEARED', 'PARTIALLY_CLEARED', 'PENDING'] as const;

export type AssetClearanceState = (typeof ASSET_CLEARANCE_STATES)[number];

export const ASSET_CLEARANCE_STATE_LABELS: Record<AssetClearanceState, string> = {
  CLEARED: 'Cleared',
  PARTIALLY_CLEARED: 'Partially cleared',
  PENDING: 'Pending',
};

/**
 * The state a set of handovers adds up to.
 *
 * One function, exported from the shared package, so the API and the browser
 * cannot disagree about what "partially cleared" means. Nothing outstanding is
 * CLEARED; something outstanding with something already back is PARTIALLY
 * CLEARED; something outstanding and nothing back is PENDING.
 */
export function assetClearanceState(counts: {
  returned: number;
  pending: number;
}): AssetClearanceState {
  if (counts.pending === 0) return 'CLEARED';
  return counts.returned > 0 ? 'PARTIALLY_CLEARED' : 'PENDING';
}

export interface EmployeeAssetsRecord {
  employeeId: string;
  assigned: EmployeeAssetRow[];
  history: EmployeeAssetRow[];
  totalAssigned: number;
  /** The summed `currentValue` of what they are holding now. */
  totalCurrentValue: number;
  clearance: EmployeeAssetClearance;
}

/**
 * The employee's own view, for the dashboard card.
 *
 * Deliberately the same rows as above with the clearance block dropped: an
 * employee does not need to be told they are being cleared, and the card exists
 * to answer two questions - what have I got, and is anything waiting on me.
 */
export interface MyAssetsRecord {
  assigned: EmployeeAssetRow[];
  /** Handovers this person has not yet acknowledged or raised an issue on. */
  awaitingAcknowledgement: EmployeeAssetRow[];
  totalAssigned: number;
}

export const EMPTY_MY_ASSETS: MyAssetsRecord = {
  assigned: [],
  awaitingAcknowledgement: [],
  totalAssigned: 0,
};

// ===========================================================================
// STEP 3 - the dashboard, the alerts and the reports. Nothing below adds a
// table, a column or a lifecycle rule; every figure is a question asked of the
// rows steps 1 and 2 already write.
// ===========================================================================

// ---------------------------------------------------------------- dashboard

/**
 * One slice of the register, grouped by something.
 *
 * Carries the money as well as the count because the two answer different
 * questions and a dashboard that only counted would say a department with forty
 * chairs matters more than one with eight laptops. `key` is null for the bucket
 * that means "filed under nothing" - an asset with no category or no
 * department is a real asset and dropping it would make the parts stop summing
 * to the whole.
 */
export interface AssetBreakdownSlice {
  key: string | null;
  label: string;
  count: number;
  purchaseValue: number;
  currentValue: number;
}

/**
 * An asset as an alert names it.
 *
 * The smallest row that lets somebody decide whether to act: what it is, who
 * has it, and the date that put it on the list. Anything more and the alert
 * becomes a second asset register nobody maintains.
 */
export interface AssetAlertRow {
  id: string;
  assetTag: string;
  name: string;
  status: AssetStatus;
  categoryName: string | null;
  holderName: string | null;
  holderEmployeeId: string | null;
  /** The warranty end for a warranty alert, the assignment date otherwise. */
  date: string | null;
  /**
   * Days until that date. Negative means it has passed.
   *
   * Computed on the server against the company's today, so a browser in another
   * timezone cannot report a warranty as expiring tomorrow when it expired
   * yesterday.
   */
  days: number | null;
}

/** An employee who is leaving and still holding something. */
export interface AssetClearanceRow {
  employeeId: string;
  employeeNumber: string | null;
  fullName: string;
  departmentName: string | null;
  employmentStatus: string;
  pending: number;
  returned: number;
  state: AssetClearanceState;
}

/**
 * The six things on an asset register that are somebody's problem today.
 *
 * Counts and rows together, and the split is deliberate. Three of the six -
 * under repair, lost, damaged - are a status on the register, so the count is
 * the alert and the drill-down is the list screen with a filter applied; a
 * second copy of those rows here would be a second thing to keep in step.
 * The other three cannot be reached by filtering a status: a warranty running
 * out is a date arithmetic question, an asset "not returned" is a fact about
 * the HOLDER's employment rather than about the asset, and a person pending
 * clearance is not an asset at all. Those three carry their rows.
 */
export interface AssetAlerts {
  warrantyExpiring: number;
  underRepair: number;
  lost: number;
  damaged: number;
  /** Still out with somebody who has resigned or been terminated. */
  notReturned: number;
  /** People on their way out with at least one handover still open. */
  employeesPendingClearance: number;

  warrantyExpiringRows: AssetAlertRow[];
  notReturnedRows: AssetAlertRow[];
  pendingClearanceRows: AssetClearanceRow[];
}

export const EMPTY_ASSET_ALERTS: AssetAlerts = {
  warrantyExpiring: 0,
  underRepair: 0,
  lost: 0,
  damaged: 0,
  notReturned: 0,
  employeesPendingClearance: 0,
  warrantyExpiringRows: [],
  notReturnedRows: [],
  pendingClearanceRows: [],
};

/**
 * The asset dashboard, entire.
 *
 * ONE ENDPOINT, not nine. Every figure on the screen is a question about the
 * same set of rows as at the same instant, and nine endpoints would answer them
 * at nine instants - which on a busy register produces a page whose tiles do
 * not add up to its own charts. The cost of that is one larger response, which
 * is the right trade for a screen somebody opens to make a decision.
 */
export interface AssetDashboard {
  total: number;
  byStatus: Record<AssetStatus, number>;
  totalPurchaseValue: number;
  totalCurrentValue: number;
  byCategory: AssetBreakdownSlice[];
  byDepartment: AssetBreakdownSlice[];
  alerts: AssetAlerts;
  /** The window "expiring soon" was computed with, echoed back. */
  warrantyDays: number;
  /** Today, in the company's timezone, as `yyyy-MM-dd`. */
  asOf: string;
}

export const assetDashboardQuerySchema = z.object({
  warrantyDays: warrantyDaysSchema,
});

export type AssetDashboardQuery = z.infer<typeof assetDashboardQuerySchema>;

export const EMPTY_ASSET_DASHBOARD: AssetDashboard = {
  total: 0,
  byStatus: { ...EMPTY_ASSET_SUMMARY.byStatus },
  totalPurchaseValue: 0,
  totalCurrentValue: 0,
  byCategory: [],
  byDepartment: [],
  alerts: EMPTY_ASSET_ALERTS,
  warrantyDays: ASSET_WARRANTY_ALERT_DAYS,
  asOf: '',
};

// ------------------------------------------------------------------ reports

/**
 * The two asset reports, and why there are two rather than one.
 *
 * They have DIFFERENT GRAINS, which is the whole distinction. The asset report
 * is one row per ASSET: eighty laptops are eighty rows, whoever has held them,
 * and it answers "what do we own and what is it worth". The employee register
 * is one row per HANDOVER: a person with a laptop, a monitor and an access card
 * is three rows, and it answers "what is this person holding" - which is the
 * question asked at an audit, a transfer, a resignation and a termination.
 *
 * Flattening the second into the first would force one row per asset with a
 * person's name on it, which silently drops everybody who has handed something
 * back and is exactly the list HR cannot afford to be missing from.
 */

/** Which handovers an employee-register row is drawn from. */
export const ASSET_REGISTER_SCOPES = ['CURRENT', 'ALL'] as const;

export type AssetRegisterScope = (typeof ASSET_REGISTER_SCOPES)[number];

export const ASSET_REGISTER_SCOPE_LABELS: Record<AssetRegisterScope, string> = {
  CURRENT: 'Currently held',
  ALL: 'Every handover',
};

/**
 * The filters both reports accept.
 *
 * A superset of the register's, with the date ranges a report needs and the
 * list screen does not. Every one is applied in the database: an export is the
 * place where "filter in the browser" stops being a rendering bug and becomes a
 * spreadsheet with the wrong rows in it, emailed to somebody.
 */
export const assetReportQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  categoryId: z.string().trim().max(64).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  condition: z.enum(ASSET_CONDITIONS).optional(),
  locationId: z.string().trim().max(64).optional(),
  warranty: z.enum(ASSET_WARRANTY_FILTERS).optional(),
  warrantyDays: warrantyDaysSchema,
  /** Purchased on or after / on or before, as `yyyy-MM-dd`. */
  purchasedFrom: optionalDate,
  purchasedTo: optionalDate,
  /** Handed over on or after / on or before. */
  assignedFrom: optionalDate,
  assignedTo: optionalDate,
  /** Employee register only: what is held now, or everything ever held. */
  scope: z.enum(ASSET_REGISTER_SCOPES).default('CURRENT'),
  /** A comma-separated subset of the column keys below. */
  columns: z.string().trim().max(2000).optional(),
});

export type AssetReportQuery = z.infer<typeof assetReportQuerySchema>;

export interface ReportColumn {
  key: string;
  label: string;
}

/**
 * The asset report's columns, in the order section 8 names them.
 *
 * The employee columns come first because that is how the report is read: HR
 * opens it asking about a person far more often than about a serial number, and
 * a spreadsheet's first column is the one it gets sorted by.
 */
export const ASSET_REPORT_COLUMNS: readonly ReportColumn[] = [
  { key: 'employeeName', label: 'Employee' },
  { key: 'employeeNumber', label: 'Employee ID' },
  { key: 'departmentName', label: 'Department' },
  { key: 'assetTag', label: 'Asset Tag' },
  { key: 'assetName', label: 'Asset' },
  { key: 'categoryName', label: 'Asset Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'model', label: 'Model' },
  { key: 'serialNumber', label: 'Serial' },
  { key: 'purchaseDate', label: 'Purchase Date' },
  { key: 'purchasePrice', label: 'Purchase Value' },
  { key: 'currentValue', label: 'Current Value' },
  { key: 'assignedAt', label: 'Assigned Date' },
  { key: 'condition', label: 'Condition' },
  { key: 'status', label: 'Status' },
  { key: 'warrantyEnd', label: 'Warranty End' },
  { key: 'locationName', label: 'Location' },
];

/** One row of the asset report: one asset, with whoever is holding it. */
export interface AssetReportRow {
  assetId: string;
  assetTag: string;
  assetName: string;
  categoryName: string | null;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  currentValue: number | null;
  warrantyEnd: string | null;
  locationName: string | null;
  condition: AssetCondition;
  status: AssetStatus;
  /** The ACTIVE holder, or nulls. Never the last person who had it. */
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  departmentName: string | null;
  assignedAt: string | null;
}

/**
 * The employee asset register's columns.
 *
 * Section 9's list, plus the two an audit asks for the moment it has the sheet
 * in front of it: whether the person has acknowledged the handover, and - for
 * the "every handover" scope - when it came back.
 */
export const EMPLOYEE_ASSET_REGISTER_COLUMNS: readonly ReportColumn[] = [
  { key: 'employeeName', label: 'Employee' },
  { key: 'employeeNumber', label: 'Employee ID' },
  { key: 'departmentName', label: 'Department' },
  { key: 'teamName', label: 'Team' },
  { key: 'assetName', label: 'Asset' },
  { key: 'assetTag', label: 'Tag' },
  { key: 'categoryName', label: 'Category' },
  { key: 'serialNumber', label: 'Serial' },
  { key: 'assignedAt', label: 'Assigned' },
  { key: 'returnedAt', label: 'Returned' },
  { key: 'condition', label: 'Condition' },
  { key: 'status', label: 'Status' },
  { key: 'acknowledgement', label: 'Acknowledged' },
  { key: 'currentValue', label: 'Current Value' },
];

/** One row of the employee register: one handover. */
export interface EmployeeAssetRegisterRow {
  assignmentId: string;
  assetId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string | null;
  departmentName: string | null;
  teamName: string | null;
  assetTag: string;
  assetName: string;
  categoryName: string | null;
  serialNumber: string | null;
  assignedAt: string;
  returnedAt: string | null;
  /** What it went out in, or came back in once it has. */
  condition: AssetCondition | null;
  assignmentStatus: AssetAssignmentStatus;
  assetStatus: AssetStatus;
  acknowledgementStatus: AssetAcknowledgementStatus;
  currentValue: number | null;
}

/**
 * What a report totals to, alongside its rows.
 *
 * Computed over EVERY row the filters match, not over the page on screen - the
 * same rule the register's tiles follow. A footer that totalled the visible
 * twenty would change when somebody pressed next, which is the most quietly
 * wrong thing a report can do.
 */
export interface AssetReportTotals {
  rows: number;
  purchaseValue: number;
  currentValue: number;
}

export const EMPTY_ASSET_REPORT_TOTALS: AssetReportTotals = {
  rows: 0,
  purchaseValue: 0,
  currentValue: 0,
};

// --------------------------------------------------------------- timeline

/**
 * How an audit action reads on the asset's timeline.
 *
 * A presentation map and nothing else: the events themselves are the audit rows
 * the lifecycle already writes, and this file invents none of them. An action
 * with no entry here still renders - it falls back to the audit summary, which
 * is a sentence written for a person - so a lifecycle step added later appears
 * on the timeline the day it ships rather than the day somebody remembers to
 * update a lookup table.
 *
 * `tone` is the same vocabulary the badges use, so an event that means
 * something went wrong looks the same here as it does on the register.
 */
export const ASSET_TIMELINE_TONES = ['neutral', 'primary', 'success', 'warning', 'destructive'] as const;

export type AssetTimelineTone = (typeof ASSET_TIMELINE_TONES)[number];

export interface AssetTimelineStep {
  label: string;
  tone: AssetTimelineTone;
}

export const ASSET_TIMELINE_STEPS: Record<string, AssetTimelineStep> = {
  'asset.created': { label: 'Added to the register', tone: 'primary' },
  'asset.updated': { label: 'Details changed', tone: 'neutral' },
  'asset.assigned': { label: 'Assigned', tone: 'primary' },
  'asset.acknowledged': { label: 'Acknowledged by the holder', tone: 'success' },
  'asset.issue.reported': { label: 'Problem reported', tone: 'warning' },
  'asset.returned': { label: 'Returned', tone: 'success' },
  'asset.transferred': { label: 'Transferred', tone: 'primary' },
  'asset.repair.sent': { label: 'Sent for repair', tone: 'warning' },
  'asset.repaired': { label: 'Back from repair', tone: 'success' },
  'asset.repair.cancelled': { label: 'Repair cancelled', tone: 'neutral' },
  'asset.damaged': { label: 'Marked damaged', tone: 'warning' },
  'asset.lost': { label: 'Marked lost', tone: 'destructive' },
  'asset.retired': { label: 'Retired', tone: 'neutral' },
  'asset.disposed': { label: 'Disposed of', tone: 'destructive' },
  'asset.document.added': { label: 'Document attached', tone: 'neutral' },
  'asset.document.removed': { label: 'Document removed', tone: 'neutral' },
};

/** The step an action maps to, or a neutral fallback carrying the action itself. */
export function assetTimelineStep(action: string): AssetTimelineStep {
  return ASSET_TIMELINE_STEPS[action] ?? { label: action, tone: 'neutral' };
}

// --------------------------------------------------------- employee lookup

/**
 * A person, as the asset module is allowed to see them.
 *
 * Six fields, and the list is a refusal rather than a selection. Handing an
 * asset to somebody means finding them in a search box; it does not mean
 * reading their record. So this shape carries what it takes to be sure you have
 * the right Ahmed - his number, his department, his team, whether he still
 * works here - and refuses everything the employee record holds that an asset
 * manager has no business reading: national ID, bank account, salary, date of
 * birth, home address, personal email and personal phone are not omitted from
 * the mapper, they are absent from the SELECT, so no route can accidentally
 * spread them into a response.
 *
 * `workEmail` is here and `personalEmail` is not, deliberately. Chasing an
 * unreturned laptop is company correspondence and goes to the company address.
 *
 * Note what is NOT here either: `photoUrl`, `phone`, `hireDate`, `manager` and
 * `jobTitle`, all of which `EmployeeListItem` carries. This is not a smaller
 * `EmployeeListItem` and must never become one - it is its own shape precisely
 * so that a field added to the directory does not arrive here as well.
 */
export interface AssetEmployeeLookupItem {
  id: string;
  employeeNumber: string;
  fullName: string;
  departmentName: string | null;
  teamName: string | null;
  /**
   * Whether this person can still be handed equipment.
   *
   * False for the two exit statuses - RESIGNED and TERMINATED - and true for
   * everybody else, read off `isExitStatus` rather than from a second list
   * written here. Published beside the raw status rather than instead of it, so
   * the picker can grey somebody out without having to know the vocabulary, and
   * still say WHY when it does.
   */
  isActive: boolean;
  /** The employee status as stored - ACTIVE, PROBATION, ON_LEAVE and so on. */
  status: EmployeeStatus;
  workEmail: string | null;
}

/**
 * The lookup's query.
 *
 * `q` and a small page, and nothing else. No department filter, no status
 * filter, no sort: this is a search box behind a select, not a second employee
 * list, and every option it does not have is an option nobody can use to
 * enumerate the roster a different way. The limit is capped well below the
 * pagination default's 100 for the same reason - a picker shows what you typed
 * enough of, and a caller asking for a thousand rows is not picking anybody.
 */
export const assetEmployeeLookupQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  /**
   * Include people who have left.
   *
   * Off by default, because the question the picker asks is "who am I giving
   * this to". On, it also returns leavers - which is what the RETURN and
   * DISPOSE dialogs need, since the person handing a laptop back on their last
   * day may already be marked RESIGNED.
   */
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

export type AssetEmployeeLookupQuery = z.infer<typeof assetEmployeeLookupQuerySchema>;
