import type { MedicalClaim, Prisma } from '@prisma/client';
import {
  MEDICAL_CATEGORY_LABELS,
  MEDICAL_CLAIM_AGREED_STATUSES,
  MEDICAL_CONSUMING_CLAIM_STATUSES,
  MEDICAL_RELATIONSHIP_LABELS,
  splitContribution,
  type MedicalCategory,
  type MedicalCategoryUsage,
  type MedicalClaimAssessment,
  type MedicalClaimDetail,
  type MedicalClaimDocumentType,
  type MedicalClaimFailure,
  type MedicalClaimRecord,
  type MedicalClaimRule,
  type MedicalRelationship,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { evaluateMedicalEligibility } from './medical-eligibility.service.js';
import { currentMedicalPolicy, toCategoryRecords, type MedicalPolicyRow } from './medical-policy.service.js';
import { applyCoverage, benefitYearOf } from './medical.service.js';

/**
 * Whether a medical claim may be made, and what it would settle at.
 *
 * The one place the question is answered. The submit form calls it to draw
 * itself and `POST /medical/claims` calls it again to decide - the second call
 * is the gate, and it re-reads the employee, the policy, the dependents and
 * every claim already on file rather than trusting anything in the request.
 * Nothing a claimant can put in a payload reaches a threshold.
 *
 * Not one company rule is written here. Every limit, deadline, percentage and
 * document requirement it compares against is read from the policy version it
 * was handed. Changing any of them is a settings screen, not a deployment.
 *
 * It writes nothing.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const toNumber = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);
const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Whole days between two calendar days, ignoring clocks and time zones. */
export function daysBetween(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00.000Z`);
  const to = Date.parse(`${toDay}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

const format = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** The document types the policy insists on, for any claim. */
export function requiredDocumentsFor(policy: MedicalPolicyRow): MedicalClaimDocumentType[] {
  const required: MedicalClaimDocumentType[] = [];
  if (policy.requireReceipt) required.push('RECEIPT');
  if (policy.requirePrescription) required.push('PRESCRIPTION');
  if (policy.requireDiagnosis) required.push('DIAGNOSIS');
  return required;
}

// --- what has been spent -----------------------------------------------------

export interface YearPosition {
  used: number;
  pending: number;
}

/**
 * An employee's position for one benefit year, in one query.
 *
 * `used` is the company's share of claims that have actually been agreed or
 * paid; `pending` is the company's share of what is still waiting. They are
 * counted separately because they answer different questions - see the comment
 * on MedicalBenefitView.
 *
 * A claim with no treatment date belongs to the year it was SUBMITTED in.
 * Somewhere is better than nowhere: a claim excluded from every year would draw
 * on no limit at all, which is the one answer that is certainly wrong.
 */
export async function yearPosition(input: {
  companyId: string;
  employeeId: string;
  year: number;
  category?: MedicalCategory;
  /** Excluded from the totals, so a claim never blocks itself on re-assessment. */
  excludeClaimId?: string;
}): Promise<YearPosition> {
  const rows = await prisma.medicalClaim.findMany({
    where: {
      companyId: input.companyId,
      employeeId: input.employeeId,
      status: { in: [...MEDICAL_CONSUMING_CLAIM_STATUSES, 'PENDING'] },
      ...(input.category ? { category: input.category } : {}),
      ...(input.excludeClaimId ? { NOT: { id: input.excludeClaimId } } : {}),
    },
    select: {
      status: true,
      companyAmount: true,
      requestedAmount: true,
      treatmentDate: true,
      submittedAt: true,
      policy: { select: { id: true } },
      category: true,
    },
  });

  let used = 0;
  let pending = 0;

  for (const row of rows) {
    const belongsTo = row.treatmentDate
      ? row.treatmentDate.getUTCFullYear()
      : row.submittedAt.getUTCFullYear();
    if (belongsTo !== input.year) continue;

    if (row.status === 'PENDING') {
      /*
       * A pending claim has no company share yet - nobody has decided one.
       * Reserving the whole requested amount is the safe reading: it is the
       * most this claim could possibly cost, so a limit checked against it can
       * be exceeded by a decision but never by a queue.
       */
      pending += toNumber(row.requestedAmount);
    } else {
      used += toNumber(row.companyAmount);
    }
  }

  return { used: round2(used), pending: round2(pending) };
}

/** Per-category consumption, for the employee's own screen. */
export async function categoryUsage(input: {
  companyId: string;
  employeeId: string;
  year: number;
  policy: MedicalPolicyRow;
}): Promise<MedicalCategoryUsage[]> {
  const categories = toCategoryRecords(input.policy);

  return Promise.all(
    categories.map(async (category) => {
      const position = await yearPosition({
        companyId: input.companyId,
        employeeId: input.employeeId,
        year: input.year,
        category: category.category,
      });
      return {
        category: category.category,
        label: MEDICAL_CATEGORY_LABELS[category.category],
        enabled: category.enabled,
        annualLimit: category.annualLimit,
        used: position.used,
        pending: position.pending,
        available:
          category.annualLimit === null
            ? null
            : Math.max(0, round2(category.annualLimit - position.used - position.pending)),
      };
    }),
  );
}

// --- the assessment ----------------------------------------------------------

export interface ClaimAssessmentInput {
  companyId: string;
  employeeId: string;
  category: MedicalCategory;
  dependentId?: string | null;
  treatmentDate?: string | null;
  requestedAmount?: number | null;
  /** Document types actually attached. Empty when the form has none yet. */
  documentTypes?: readonly MedicalClaimDocumentType[];
  providerName?: string | null;
  now?: Date;
  /**
   * The policy to judge against. Passed by the decision path so a claim is
   * re-measured by the version it was SUBMITTED under, not by today's.
   */
  policy?: MedicalPolicyRow;
  /** Excluded from the year's totals, so re-assessing a claim ignores itself. */
  excludeClaimId?: string;
}

export async function assessMedicalClaim(
  input: ClaimAssessmentInput,
): Promise<MedicalClaimAssessment> {
  const now = input.now ?? new Date();
  const failures: MedicalClaimFailure[] = [];
  const warnings: string[] = [];
  const fail = (rule: MedicalClaimRule, message: string) => failures.push({ rule, message });

  const policy = input.policy ?? (await currentMedicalPolicy(input.companyId, now));

  const eligibility = await evaluateMedicalEligibility({
    companyId: input.companyId,
    employeeId: input.employeeId,
    now,
    policy,
  });

  const category = toCategoryRecords(policy).find((c) => c.category === input.category)!;
  const currency = eligibility.currency;
  const requestedAmount = input.requestedAmount ?? 0;

  const split = splitContribution(requestedAmount, category.companyContributionPercent);

  const year = input.treatmentDate
    ? Number(input.treatmentDate.slice(0, 4))
    : benefitYearOf(now);

  const [position, categoryPosition] = await Promise.all([
    yearPosition({
      companyId: input.companyId,
      employeeId: input.employeeId,
      year,
      excludeClaimId: input.excludeClaimId,
    }),
    yearPosition({
      companyId: input.companyId,
      employeeId: input.employeeId,
      year,
      category: input.category,
      excludeClaimId: input.excludeClaimId,
    }),
  ]);

  // The employee's own limit when HR has set one; the eligibility answer
  // already resolved which applies.
  const annualLimit = eligibility.benefitLimit;
  const available = Math.max(0, round2(annualLimit - position.used - position.pending));
  const categoryAvailable =
    category.annualLimit === null
      ? null
      : Math.max(0, round2(category.annualLimit - categoryPosition.used - categoryPosition.pending));

  // --- 1. is the benefit theirs at all -------------------------------------
  //
  // Checked first and reported verbatim. Telling somebody their receipt is
  // missing when the real answer is that they are still in their waiting period
  // sends them to the chemist instead of to HR.
  if (!eligibility.eligible) {
    for (const reason of eligibility.reasons) fail('ELIGIBILITY', reason);
  }

  // --- 2. the category ------------------------------------------------------
  if (!category.enabled) {
    fail(
      'CATEGORY_DISABLED',
      `${MEDICAL_CATEGORY_LABELS[input.category]} is not covered under the current medical policy.`,
    );
  }

  // --- 3. the amount --------------------------------------------------------
  if (input.requestedAmount !== null && input.requestedAmount !== undefined) {
    if (requestedAmount <= 0) {
      fail('AMOUNT', 'Enter an amount greater than zero.');
    } else {
      if (category.maxClaimAmount !== null && requestedAmount > category.maxClaimAmount) {
        fail(
          'MAX_CLAIM_AMOUNT',
          `A single ${MEDICAL_CATEGORY_LABELS[input.category]} claim cannot exceed ${currency} ${format(category.maxClaimAmount)}.`,
        );
      }
      if (categoryAvailable !== null && split.companyAmount > categoryAvailable) {
        fail(
          'CATEGORY_ANNUAL_LIMIT',
          `${MEDICAL_CATEGORY_LABELS[input.category]} has ${currency} ${format(categoryAvailable)} left for ${year}. This claim would draw ${currency} ${format(split.companyAmount)}.`,
        );
      }
      if (split.companyAmount > available) {
        fail(
          'ANNUAL_LIMIT',
          `You have ${currency} ${format(available)} of your ${year} medical benefit available. This claim would draw ${currency} ${format(split.companyAmount)}.`,
        );
      }
    }
  }

  // --- 4. the treatment date -------------------------------------------------
  const today = now.toISOString().slice(0, 10);
  if (!input.treatmentDate) {
    if (policy.requireTreatmentDate) {
      fail('TREATMENT_DATE_REQUIRED', 'Enter the date the treatment happened.');
    }
  } else {
    const treatment = input.treatmentDate;
    const age = daysBetween(treatment, today);

    if (age < 0) {
      fail('TREATMENT_DATE_FUTURE', 'The treatment date cannot be in the future.');
    } else if (age > 0 && !policy.allowBackdatedClaims) {
      fail(
        'BACKDATED_NOT_ALLOWED',
        'The policy only accepts claims for treatment dated today.',
      );
    } else {
      if (age > policy.maxBackdatedDays) {
        fail(
          'BACKDATED_LIMIT',
          `That treatment was ${age} days ago. The policy accepts treatment dated up to ${policy.maxBackdatedDays} day${policy.maxBackdatedDays === 1 ? '' : 's'} back.`,
        );
      }
      /*
       * The deadline and the backdating limit are two settings, and a company
       * can set them apart. Both are reported when both are broken rather than
       * stopping at the first: somebody a hundred days late wants to know it is
       * hopeless, not to fix one rule and meet the other.
       */
      if (policy.claimSubmissionDeadlineDays > 0 && age > policy.claimSubmissionDeadlineDays) {
        fail(
          'SUBMISSION_DEADLINE',
          `Claims have to be submitted within ${policy.claimSubmissionDeadlineDays} day${policy.claimSubmissionDeadlineDays === 1 ? '' : 's'} of treatment. This one is ${age} days old.`,
        );
      }
    }
  }

  // --- 5. what the claim has to carry ---------------------------------------
  if (policy.requireHospitalName && !input.providerName?.trim()) {
    fail('PROVIDER_REQUIRED', 'Enter the hospital or clinic where the treatment happened.');
  }

  const required = requiredDocumentsFor(policy);
  const attached = new Set(input.documentTypes ?? []);
  // Only checked once the caller has started attaching. An empty list on the
  // preview is a form nobody has filled in yet, not a claim missing its
  // receipt - the submit route passes what actually arrived and gets the
  // refusal there.
  if (input.documentTypes) {
    for (const type of required) {
      if (!attached.has(type)) {
        fail(
          'DOCUMENT_REQUIRED',
          type === 'RECEIPT'
            ? 'Attach the receipt number for this claim.'
            : type === 'PRESCRIPTION'
              ? 'Attach the prescription reference for this claim.'
              : 'Attach the diagnosis or treatment document reference for this claim.',
        );
      }
    }
  }

  // --- 6. the dependent ------------------------------------------------------
  if (input.dependentId) {
    const dependents = await prisma.medicalDependent.findMany({
      where: { companyId: input.companyId, employeeId: input.employeeId },
    });
    const resolved = applyCoverage(dependents, policy).find((d) => d.id === input.dependentId);

    if (!resolved) {
      // Not "no such dependent": the id may belong to somebody else's family,
      // and saying which would confirm it exists.
      fail('DEPENDENT_NOT_FOUND', 'That dependent is not on this employee’s record.');
    } else if (!resolved.covered) {
      fail(
        'DEPENDENT_NOT_COVERED',
        resolved.coverageNote ?? 'That dependent is not covered by the current medical policy.',
      );
    }
  }

  // --- warnings, which are true and do not block -----------------------------
  if (
    failures.length === 0 &&
    requestedAmount > 0 &&
    split.employeeAmount > 0
  ) {
    warnings.push(
      `${currency} ${format(split.employeeAmount)} of this claim is your own share and will not be reimbursed.`,
    );
  }
  if (failures.length === 0 && !policy.requireHrApproval) {
    warnings.push('The policy settles claims without a review, so this will be approved on arrival.');
  }

  return {
    allowed: failures.length === 0,
    reasons: failures.map((f) => f.message),
    failedRules: failures.map((f) => f.rule),
    failures,
    warnings,
    policyVersion: eligibility.policyVersion,
    currency,
    requestedAmount,
    companyAmount: split.companyAmount,
    employeeAmount: split.employeeAmount,
    companyContributionPercent: category.companyContributionPercent,
    employeeContributionPercent: category.employeeContributionPercent,
    annualLimit,
    used: position.used,
    pending: position.pending,
    available,
    categoryAnnualLimit: category.annualLimit,
    categoryUsed: categoryPosition.used,
    categoryAvailable,
    maxClaimAmount: category.maxClaimAmount,
    requiredDocuments: required,
    requireProviderName: policy.requireHospitalName,
    requireTreatmentDate: policy.requireTreatmentDate,
    overrideAllowed: policy.allowHrOverride,
    requireOverrideReason: policy.requireOverrideReason,
    requiresApproval: policy.requireHrApproval,
  };
}

// --- claim numbers -----------------------------------------------------------

/**
 * The next claim number, e.g. MED-0007.
 *
 * Derived from the highest existing number rather than from a row count, so
 * deleting a claim cannot cause a collision - the same rule employee numbers
 * use. The unique index on (companyId, claimNumber) is the real guarantee; this
 * only has to be right almost always.
 */
export async function nextClaimNumber(companyId: string): Promise<string> {
  const prefix = 'MED-';
  const existing = await prisma.medicalClaim.findMany({
    where: { companyId, claimNumber: { startsWith: prefix } },
    select: { claimNumber: true },
  });

  let highest = 0;
  for (const { claimNumber } of existing) {
    const suffix = claimNumber.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    highest = Math.max(highest, Number.parseInt(suffix, 10));
  }

  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

// --- read shapes -------------------------------------------------------------

export const CLAIM_INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true } },
  dependent: { select: { id: true, name: true, relationship: true } },
  documents: { orderBy: { createdAt: 'asc' } },
  /*
   * The version the claim is PINNED to, not the live one.
   *
   * Carried so a reviewer can be shown the split that will actually be applied
   * when they decide. Reading the current policy for that would show one figure
   * on the decision screen and record another as soon as the policy had moved -
   * which is the exact failure `policyId` exists to prevent.
   */
  policy: { select: { categories: { select: { category: true, companyContributionPercent: true, employeeContributionPercent: true } } } },
} as const satisfies Prisma.MedicalClaimInclude;

export type ClaimRow = Prisma.MedicalClaimGetPayload<{ include: typeof CLAIM_INCLUDE }>;

export interface ClaimCallerContext {
  employeeId: string | null;
  canDecide: boolean;
  canManage: boolean;
  currency: string;
  /** From the policy in force: whether a claimant may withdraw a pending claim. */
  allowEmployeeCancel: boolean;
}

/**
 * The contribution split for this claim's category, from the version it is
 * pinned to.
 *
 * A category row is expected for every category of every version, because a
 * version is written with a full set. The fallback is for the one case that can
 * still happen - a category added to the product after an old version was
 * written - and it says "the company pays all of it", which is the same default
 * a new category is created with rather than a silent zero.
 */
function pinnedContributionFor(row: ClaimRow): {
  companyContributionPercent: number;
  employeeContributionPercent: number;
} {
  const pinned = row.policy.categories.find((c) => c.category === row.category);
  if (!pinned) return { companyContributionPercent: 100, employeeContributionPercent: 0 };
  return {
    companyContributionPercent: toNumber(pinned.companyContributionPercent),
    employeeContributionPercent: toNumber(pinned.employeeContributionPercent),
  };
}

/**
 * A claim as the API reports it.
 *
 * `canDecide` / `canCancel` / `canMarkPaid` are the server's own answers rather
 * than something the browser works out from a permission list. The endpoints
 * check again regardless - these exist so a screen does not have to reimplement
 * the rules to decide which buttons to draw, and cannot get them subtly wrong.
 *
 * `overrideReason` is withheld from the claimant. An exception made in their
 * favour is a note between the reviewer and the audit trail; showing it back
 * turns a discretionary decision into an expectation.
 */
export function toClaimRecord(row: ClaimRow, caller: ClaimCallerContext): MedicalClaimRecord {
  const isOwn = caller.employeeId !== null && caller.employeeId === row.employeeId;
  const pending = row.status === 'PENDING';
  const pinnedSplit = pinnedContributionFor(row);

  return {
    id: row.id,
    claimNumber: row.claimNumber,
    employeeId: row.employeeId,
    employeeName: row.employee.displayName ?? `${row.employee.firstName} ${row.employee.lastName}`.trim(),
    employeeNumber: row.employee.employeeNumber,

    category: row.category as MedicalCategory,
    categoryLabel: MEDICAL_CATEGORY_LABELS[row.category as MedicalCategory],

    dependentId: row.dependentId,
    dependentName: row.dependent?.name ?? null,
    dependentRelationship: row.dependent
      ? MEDICAL_RELATIONSHIP_LABELS[row.dependent.relationship as MedicalRelationship]
      : null,

    treatmentDate: day(row.treatmentDate),
    providerName: row.providerName,
    notes: row.notes,

    currency: caller.currency,
    requestedAmount: toNumber(row.requestedAmount),
    approvedAmount: row.approvedAmount === null ? null : toNumber(row.approvedAmount),
    companyAmount: row.companyAmount === null ? null : toNumber(row.companyAmount),
    employeeAmount: row.employeeAmount === null ? null : toNumber(row.employeeAmount),

    companyContributionPercent: pinnedSplit.companyContributionPercent,
    employeeContributionPercent: pinnedSplit.employeeContributionPercent,

    status: row.status,
    policyId: row.policyId,

    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,

    reviewedByName: null,
    decisionNote: row.decisionNote,
    rejectionReason: row.rejectionReason,
    overrideReason: caller.canDecide || caller.canManage ? row.overrideReason : null,
    paymentReference: row.paymentReference,

    // A claim is never decided by the person who made it, whatever they hold.
    canDecide: caller.canDecide && pending && !isOwn,
    canCancel:
      pending &&
      ((isOwn && caller.allowEmployeeCancel) || caller.canManage),
    canMarkPaid:
      caller.canManage && (MEDICAL_CLAIM_AGREED_STATUSES as readonly string[]).includes(row.status) && row.status !== 'PAID',
  };
}

export function toClaimDetail(row: ClaimRow, caller: ClaimCallerContext): MedicalClaimDetail {
  return {
    ...toClaimRecord(row, caller),
    documents: row.documents.map((d) => ({
      id: d.id,
      type: d.type,
      reference: d.reference,
      note: d.note,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

/** Reviewer names, resolved in one query and stitched onto the records. */
export async function withReviewerNames<T extends MedicalClaimRecord>(
  records: T[],
  rows: ReadonlyArray<Pick<MedicalClaim, 'id' | 'reviewedByUserId'>>,
): Promise<T[]> {
  const ids = [...new Set(rows.map((r) => r.reviewedByUserId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return records;

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      employee: { select: { firstName: true, lastName: true, displayName: true } },
    },
  });

  const names = new Map(
    users.map((u) => {
      const e = u.employee;
      const employeeName = e ? (e.displayName ?? `${e.firstName} ${e.lastName}`.trim()) : '';
      return [u.id, employeeName || `${u.firstName} ${u.lastName}`.trim() || u.email];
    }),
  );
  const reviewerByClaim = new Map(rows.map((r) => [r.id, r.reviewedByUserId]));

  return records.map((record) => {
    const reviewer = reviewerByClaim.get(record.id);
    return reviewer ? { ...record, reviewedByName: names.get(reviewer) ?? null } : record;
  });
}
