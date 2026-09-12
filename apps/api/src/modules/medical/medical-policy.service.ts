import type { MedicalPolicy, MedicalPolicyCategory, Prisma } from '@prisma/client';
import {
  MEDICAL_CATEGORIES,
  MEDICAL_CATEGORY_FIELD_LABELS,
  MEDICAL_CATEGORY_LABELS,
  MEDICAL_POLICY_DEFAULTS,
  MEDICAL_POLICY_LABELS,
  defaultCategoryLimits,
  type MedicalCategory,
  type MedicalCategoryLimitInput,
  type MedicalPolicyFieldChange,
  type MedicalPolicyHistoryEntry,
  type MedicalPolicyInput,
  type MedicalPolicyRecord,
  type MedicalPolicyValues,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';

/**
 * Reading and writing the medical policy.
 *
 * Versions are immutable. Nothing in this file updates a policy row - saving a
 * change creates a new one, with a new set of category rows - so the rules that
 * governed a claim submitted last March can still be read in full today, and a
 * claim already decided can never be re-judged by rules written after it.
 *
 * The policy in force at an instant is the newest version at or before it. That
 * single sentence is the whole resolution rule, and it is implemented once here
 * so the eligibility engine, the benefit summary, the settings screen and the
 * history all agree.
 *
 * Deliberately the same shape as loan-policy.service.ts. Two policies that
 * version the same way should read the same way; a second, cleverer approach to
 * the same problem is a second thing to get right.
 */

/**
 * The first version starts at the epoch.
 *
 * Not "now": a policy created today with effectiveFrom = today would leave
 * every claim ever submitted with no policy behind it, and "which rules applied
 * to this claim?" would have no answer for the whole existing history. Starting
 * at the epoch means the defaults are, retroactively, what the company had
 * always been operating - which is true, because they are the behaviour the
 * product ships with.
 */
const EPOCH = new Date(0);

const CATEGORY_INCLUDE = { categories: true } as const;

export type MedicalPolicyRow = MedicalPolicy & { categories: MedicalPolicyCategory[] };

const toNumber = (value: Prisma.Decimal | number): number => Number(value);

/** Null survives as null: "no cap here" is not the same statement as zero. */
const toNullableNumber = (value: Prisma.Decimal | number | null): number | null =>
  value === null ? null : Number(value);

/**
 * The policy in force at `at`, creating the seeded default if none exists.
 *
 * The seed is written with `upsert` on the [companyId, effectiveFrom] unique
 * index rather than find-then-create: two requests arriving together on a fresh
 * company would otherwise both find nothing and both insert, and a company
 * would end up with two "first" policies. The upsert makes the loser of that
 * race read the winner's row.
 */
export async function resolveMedicalPolicyAt(
  companyId: string,
  at: Date,
): Promise<MedicalPolicyRow> {
  const inForce = await prisma.medicalPolicy.findFirst({
    where: { companyId, effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
    include: CATEGORY_INCLUDE,
  });
  if (inForce) return inForce;

  return prisma.medicalPolicy.upsert({
    where: { companyId_effectiveFrom: { companyId, effectiveFrom: EPOCH } },
    update: {},
    create: {
      companyId,
      effectiveFrom: EPOCH,
      ...defaultsForCreate(),
      categories: { create: categoryCreateRows(defaultCategoryLimits()) },
    },
    include: CATEGORY_INCLUDE,
  });
}

/** The policy governing anything decided right now. */
export function currentMedicalPolicy(
  companyId: string,
  now = new Date(),
): Promise<MedicalPolicyRow> {
  return resolveMedicalPolicyAt(companyId, now);
}

/**
 * A version saved with a future effective date, if there is one.
 *
 * Shown on the settings screen so an administrator who scheduled a change can
 * see it waiting rather than wondering why the form still reads the old value.
 */
export function scheduledMedicalPolicy(
  companyId: string,
  now = new Date(),
): Promise<MedicalPolicyRow | null> {
  return prisma.medicalPolicy.findFirst({
    where: { companyId, effectiveFrom: { gt: now } },
    orderBy: { effectiveFrom: 'asc' },
    include: CATEGORY_INCLUDE,
  });
}

function defaultsForCreate(): MedicalPolicyValues {
  const d = MEDICAL_POLICY_DEFAULTS;
  return {
    enabled: d.enabled,
    policyName: d.policyName,
    description: d.description,
    minEmploymentMonths: d.minEmploymentMonths,
    allowProbation: d.allowProbation,
    allowPermanent: d.allowPermanent,
    blockResigned: d.blockResigned,
    blockTerminated: d.blockTerminated,
    annualLimitPerEmployee: d.annualLimitPerEmployee,
    spouseCovered: d.spouseCovered,
    childrenCovered: d.childrenCovered,
    maxChildren: d.maxChildren,
    parentsCovered: d.parentsCovered,
    maxParents: d.maxParents,
    dependentsShareEmployeeLimit: d.dependentsShareEmployeeLimit,
    dependentAnnualLimit: d.dependentAnnualLimit,
    requireReceipt: d.requireReceipt,
    requirePrescription: d.requirePrescription,
    requireDiagnosis: d.requireDiagnosis,
    requireHospitalName: d.requireHospitalName,
    requireTreatmentDate: d.requireTreatmentDate,
    claimSubmissionDeadlineDays: d.claimSubmissionDeadlineDays,
    allowBackdatedClaims: d.allowBackdatedClaims,
    maxBackdatedDays: d.maxBackdatedDays,
    requireHrApproval: d.requireHrApproval,
    allowPartialApproval: d.allowPartialApproval,
    allowEmployeeCancelPending: d.allowEmployeeCancelPending,
    allowHrOverride: d.allowHrOverride,
    requireOverrideReason: d.requireOverrideReason,
    allowCarryForward: d.allowCarryForward,
    maxCarryForwardAmount: d.maxCarryForwardAmount,
  };
}

const categoryCreateRows = (
  categories: readonly MedicalCategoryLimitInput[],
): Prisma.MedicalPolicyCategoryCreateWithoutPolicyInput[] =>
  categories.map((c) => ({
    category: c.category,
    enabled: c.enabled,
    annualLimit: c.annualLimit,
    maxClaimAmount: c.maxClaimAmount,
    companyContributionPercent: c.companyContributionPercent,
    employeeContributionPercent: c.employeeContributionPercent,
  }));

/**
 * The category rows of a version, in the product's own order and complete.
 *
 * Ordered by MEDICAL_CATEGORIES rather than by whatever the database returns,
 * so the settings form, the diff and the employee's screen list them the same
 * way every time. A category with no row - possible only for a row written by
 * hand - falls back to its default rather than vanishing from the list, because
 * a category missing from the screen is a setting nobody can find.
 */
export function toCategoryRecords(row: MedicalPolicyRow): MedicalCategoryLimitInput[] {
  const byCategory = new Map<MedicalCategory, MedicalPolicyCategory>(
    row.categories.map((c) => [c.category as MedicalCategory, c]),
  );

  return MEDICAL_CATEGORIES.map((category) => {
    const found = byCategory.get(category);
    if (!found) {
      return { category, ...MEDICAL_POLICY_CATEGORY_FALLBACK[category] };
    }
    return {
      category,
      enabled: found.enabled,
      annualLimit: toNullableNumber(found.annualLimit),
      maxClaimAmount: toNullableNumber(found.maxClaimAmount),
      companyContributionPercent: toNumber(found.companyContributionPercent),
      employeeContributionPercent: toNumber(found.employeeContributionPercent),
    };
  });
}

const MEDICAL_POLICY_CATEGORY_FALLBACK = Object.fromEntries(
  defaultCategoryLimits().map(({ category, ...rest }) => [category, rest]),
) as Record<MedicalCategory, Omit<MedicalCategoryLimitInput, 'category'>>;

/** A stored row as the settings form reads it. */
export function toMedicalPolicyRecord(
  row: MedicalPolicyRow,
  input: { createdByName: string | null; isCurrent: boolean },
): MedicalPolicyRecord {
  return {
    id: row.id,
    enabled: row.enabled,
    policyName: row.policyName,
    description: row.description,
    minEmploymentMonths: row.minEmploymentMonths,
    allowProbation: row.allowProbation,
    allowPermanent: row.allowPermanent,
    blockResigned: row.blockResigned,
    blockTerminated: row.blockTerminated,
    annualLimitPerEmployee: toNumber(row.annualLimitPerEmployee),
    spouseCovered: row.spouseCovered,
    childrenCovered: row.childrenCovered,
    maxChildren: row.maxChildren,
    parentsCovered: row.parentsCovered,
    maxParents: row.maxParents,
    dependentsShareEmployeeLimit: row.dependentsShareEmployeeLimit,
    dependentAnnualLimit: toNumber(row.dependentAnnualLimit),
    requireReceipt: row.requireReceipt,
    requirePrescription: row.requirePrescription,
    requireDiagnosis: row.requireDiagnosis,
    requireHospitalName: row.requireHospitalName,
    requireTreatmentDate: row.requireTreatmentDate,
    claimSubmissionDeadlineDays: row.claimSubmissionDeadlineDays,
    allowBackdatedClaims: row.allowBackdatedClaims,
    maxBackdatedDays: row.maxBackdatedDays,
    requireHrApproval: row.requireHrApproval,
    allowPartialApproval: row.allowPartialApproval,
    allowEmployeeCancelPending: row.allowEmployeeCancelPending,
    allowHrOverride: row.allowHrOverride,
    requireOverrideReason: row.requireOverrideReason,
    allowCarryForward: row.allowCarryForward,
    maxCarryForwardAmount: toNumber(row.maxCarryForwardAmount),
    categories: toCategoryRecords(row),
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdByName: input.createdByName,
    isCurrent: input.isCurrent,
  };
}

/** The scalar policy fields, in the order the settings screen lists them. */
const POLICY_FIELDS = [
  'enabled',
  'policyName',
  'description',
  'minEmploymentMonths',
  'allowProbation',
  'allowPermanent',
  'blockResigned',
  'blockTerminated',
  'annualLimitPerEmployee',
  'spouseCovered',
  'childrenCovered',
  'maxChildren',
  'parentsCovered',
  'maxParents',
  'dependentsShareEmployeeLimit',
  'dependentAnnualLimit',
  'requireReceipt',
  'requirePrescription',
  'requireDiagnosis',
  'requireHospitalName',
  'requireTreatmentDate',
  'claimSubmissionDeadlineDays',
  'allowBackdatedClaims',
  'maxBackdatedDays',
  'requireHrApproval',
  'allowPartialApproval',
  'allowEmployeeCancelPending',
  'allowHrOverride',
  'requireOverrideReason',
  'allowCarryForward',
  'maxCarryForwardAmount',
] as const satisfies ReadonlyArray<keyof MedicalPolicyValues>;

const asText = (value: number | boolean | string | null): string => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null) return 'No cap';
  if (value === '') return '(empty)';
  return String(value);
};

/**
 * What changed between two consecutive versions, categories included.
 *
 * Derived rather than stored. A change log written alongside the values it
 * describes is a second copy of them, and a second copy eventually disagrees -
 * so the history is computed from the versions themselves, which are the only
 * record there is. That is also why the medical module writes no audit table of
 * its own for policy values: this IS the field-level record, and a second one
 * could only ever agree or be wrong.
 */
export function diffMedicalPolicies(
  previous: MedicalPolicyRecord | null,
  next: MedicalPolicyRecord,
): MedicalPolicyFieldChange[] {
  if (!previous) return [];

  const changes: MedicalPolicyFieldChange[] = [];

  for (const field of POLICY_FIELDS) {
    const from = previous[field];
    const to = next[field];
    if (from === to) continue;
    changes.push({
      field,
      label: MEDICAL_POLICY_LABELS[field],
      from: asText(from),
      to: asText(to),
    });
  }

  const previousCategories = new Map(previous.categories.map((c) => [c.category, c]));
  for (const category of next.categories) {
    const before = previousCategories.get(category.category);
    if (!before) continue;
    for (const key of ['enabled', 'annualLimit', 'maxClaimAmount', 'companyContributionPercent', 'employeeContributionPercent'] as const) {
      if (before[key] === category[key]) continue;
      changes.push({
        field: `categories.${category.category}.${key}`,
        label: `${MEDICAL_CATEGORY_LABELS[category.category]} - ${MEDICAL_CATEGORY_FIELD_LABELS[key]}`,
        from: asText(before[key]),
        to: asText(category[key]),
      });
    }
  }

  return changes;
}

/**
 * The change history, newest first.
 *
 * One extra row is read beyond the page so the oldest entry on it can still be
 * diffed against its predecessor. Without it the last row of every page would
 * report every field as unchanged.
 */
export async function medicalPolicyHistory(
  companyId: string,
  page: number,
  limit: number,
): Promise<{ entries: MedicalPolicyHistoryEntry[]; total: number }> {
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.medicalPolicy.count({ where: { companyId } }),
    prisma.medicalPolicy.findMany({
      where: { companyId },
      orderBy: { effectiveFrom: 'desc' },
      skip,
      take: limit + 1,
      include: CATEGORY_INCLUDE,
    }),
  ]);

  const authorNames = await medicalPolicyAuthorNames(rows.map((r) => r.createdBy));

  const entries: MedicalPolicyHistoryEntry[] = [];
  for (let i = 0; i < Math.min(rows.length, limit); i += 1) {
    const row = rows[i]!;
    const previous = rows[i + 1] ?? null;
    const record = toMedicalPolicyRecord(row, { createdByName: null, isCurrent: false });
    const previousRecord = previous
      ? toMedicalPolicyRecord(previous, { createdByName: null, isCurrent: false })
      : null;

    entries.push({
      id: row.id,
      effectiveFrom: row.effectiveFrom.toISOString(),
      changedAt: row.createdAt.toISOString(),
      changedByName: row.createdBy ? (authorNames.get(row.createdBy) ?? null) : null,
      changes: diffMedicalPolicies(previousRecord, record),
    });
  }

  return { entries, total };
}

/**
 * Who saved a version.
 *
 * The employee's name where the user has one, falling back to the account's own
 * name: an administrator is not always on the payroll.
 */
export async function medicalPolicyAuthorNames(
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: wanted } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      employee: { select: { firstName: true, lastName: true, displayName: true } },
    },
  });

  return new Map(
    users.map((u) => {
      const e = u.employee;
      const employeeName = e ? (e.displayName ?? `${e.firstName} ${e.lastName}`.trim()) : '';
      const accountName = `${u.firstName} ${u.lastName}`.trim();
      return [u.id, employeeName || accountName || u.email];
    }),
  );
}

/**
 * Save a new version.
 *
 * Always an insert, and the category rows are inserted with it rather than
 * updated in place. The unique index on [companyId, effectiveFrom] is what
 * stops two administrators saving different rules for the same instant; the
 * route turns that collision into a message rather than a 500.
 *
 * No claim, dependent or employee row is read for writing or written here.
 */
export async function saveMedicalPolicy(input: {
  companyId: string;
  values: MedicalPolicyInput;
  userId: string;
  effectiveFrom: Date;
}): Promise<MedicalPolicyRow> {
  const v = input.values;
  return prisma.medicalPolicy.create({
    data: {
      companyId: input.companyId,
      effectiveFrom: input.effectiveFrom,
      createdBy: input.userId,
      enabled: v.enabled,
      policyName: v.policyName,
      description: v.description,
      minEmploymentMonths: v.minEmploymentMonths,
      allowProbation: v.allowProbation,
      allowPermanent: v.allowPermanent,
      blockResigned: v.blockResigned,
      blockTerminated: v.blockTerminated,
      annualLimitPerEmployee: v.annualLimitPerEmployee,
      spouseCovered: v.spouseCovered,
      childrenCovered: v.childrenCovered,
      maxChildren: v.maxChildren,
      parentsCovered: v.parentsCovered,
      maxParents: v.maxParents,
      dependentsShareEmployeeLimit: v.dependentsShareEmployeeLimit,
      dependentAnnualLimit: v.dependentAnnualLimit,
      requireReceipt: v.requireReceipt,
      requirePrescription: v.requirePrescription,
      requireDiagnosis: v.requireDiagnosis,
      requireHospitalName: v.requireHospitalName,
      requireTreatmentDate: v.requireTreatmentDate,
      claimSubmissionDeadlineDays: v.claimSubmissionDeadlineDays,
      allowBackdatedClaims: v.allowBackdatedClaims,
      maxBackdatedDays: v.maxBackdatedDays,
      requireHrApproval: v.requireHrApproval,
      allowPartialApproval: v.allowPartialApproval,
      allowEmployeeCancelPending: v.allowEmployeeCancelPending,
      allowHrOverride: v.allowHrOverride,
      requireOverrideReason: v.requireOverrideReason,
      allowCarryForward: v.allowCarryForward,
      maxCarryForwardAmount: v.maxCarryForwardAmount,
      categories: { create: categoryCreateRows(v.categories) },
    },
    include: CATEGORY_INCLUDE,
  });
}
