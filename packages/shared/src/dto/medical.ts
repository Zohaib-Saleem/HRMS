import { z } from 'zod';
import type { MedicalCategory } from './medical-policy.js';

/**
 * An employee's side of the medical benefit: whether it reaches them, how much
 * of it is left, and who else it covers.
 *
 * Medical information is the most sensitive data this product holds, so the
 * shapes below are deliberately thin. A benefit summary carries limits and
 * totals; a dependent carries a name, a relationship and a date of birth. There
 * is no diagnosis, no condition, no treatment note anywhere in this file, and
 * nothing that is not needed to answer "what am I entitled to".
 *
 * Every figure here is computed on the server from the policy in force. None of
 * it is accepted from the browser: the eligibility engine re-reads the employee
 * and the policy on every call, so a forged response changes nothing.
 */

// --- dependents --------------------------------------------------------------

export const MEDICAL_RELATIONSHIPS = ['SPOUSE', 'CHILD', 'PARENT'] as const;
export type MedicalRelationship = (typeof MEDICAL_RELATIONSHIPS)[number];

export const MEDICAL_RELATIONSHIP_LABELS: Record<MedicalRelationship, string> = {
  SPOUSE: 'Spouse',
  CHILD: 'Child',
  PARENT: 'Parent',
};

export const MEDICAL_DEPENDENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MedicalDependentStatus = (typeof MEDICAL_DEPENDENT_STATUSES)[number];

export const MEDICAL_DEPENDENT_STATUS_LABELS: Record<MedicalDependentStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

export const MEDICAL_GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export type MedicalGender = (typeof MEDICAL_GENDERS)[number];

const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-MM-dd date.')
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

export const medicalDependentCreateSchema = z.object({
  /**
   * Whose dependent. Omitted means the caller's own employee record. Naming
   * somebody else needs `medical.manage`; the route, not this schema, is what
   * enforces that.
   */
  employeeId: z.string().trim().max(64).optional(),
  name: z
    .string()
    .trim()
    .min(1, 'Enter the name.')
    .max(160, 'Keep the name under 160 characters.'),
  relationship: z.enum(MEDICAL_RELATIONSHIPS, {
    errorMap: () => ({ message: 'Choose spouse, child or parent.' }),
  }),
  dateOfBirth: optionalDate,
  gender: z.enum(MEDICAL_GENDERS).nullish().transform((v) => v ?? null),
  status: z.enum(MEDICAL_DEPENDENT_STATUSES).default('ACTIVE'),
});

export type MedicalDependentCreateInput = z.infer<typeof medicalDependentCreateSchema>;

/** The same fields, all optional, minus the employee - a dependent never moves. */
export const medicalDependentUpdateSchema = medicalDependentCreateSchema
  .omit({ employeeId: true })
  .partial();

export type MedicalDependentUpdateInput = z.infer<typeof medicalDependentUpdateSchema>;

export const medicalDependentQuerySchema = z.object({
  employeeId: z.string().trim().max(64).optional(),
});

/**
 * A dependent, and whether the policy in force actually covers them.
 *
 * `covered` is derived on every read rather than stored. The policy decides how
 * many children are covered, and that number can change - a stored flag would
 * still be describing the policy as it was on the day the record was created.
 * Recording a dependent and covering one are two different things, which is why
 * a fourth child under a three-child policy can be registered and simply is not
 * covered.
 */
export interface MedicalDependentRecord {
  id: string;
  employeeId: string;
  name: string;
  relationship: MedicalRelationship;
  dateOfBirth: string | null;
  gender: MedicalGender | null;
  status: MedicalDependentStatus;
  covered: boolean;
  /** Why not, when `covered` is false. Null when they are covered. */
  coverageNote: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- eligibility -------------------------------------------------------------

/**
 * Which rule an employee failed.
 *
 * A machine-readable key beside every human sentence, so the UI can highlight
 * the setting a failure belongs to without parsing English, and so a test can
 * assert the rule rather than its wording.
 */
export const MEDICAL_ELIGIBILITY_RULES = [
  'EMPLOYEE_RECORD',
  'BENEFIT_DISABLED',
  'EMPLOYMENT_STATUS',
  'MIN_EMPLOYMENT',
  'PROBATION',
  'PERMANENT_NOT_ALLOWED',
] as const;

export type MedicalEligibilityRule = (typeof MEDICAL_ELIGIBILITY_RULES)[number];

export interface MedicalEligibilityFailure {
  rule: MedicalEligibilityRule;
  /**
   * What the employee is told. Written for the person who has to act on it, and
   * carrying only facts about themselves that they can already see on their own
   * profile - never another employee's, and never an internal id.
   */
  message: string;
}

/** A category's limits, as they apply to one employee under the live policy. */
export interface MedicalCategoryEntitlement {
  category: MedicalCategory;
  label: string;
  enabled: boolean;
  annualLimit: number | null;
  maxClaimAmount: number | null;
  companyContributionPercent: number;
  employeeContributionPercent: number;
}

/** Which version decided this answer. Quoted back so an answer is explicable. */
export interface MedicalPolicyVersionRef {
  id: string;
  name: string;
  effectiveFrom: string;
}

/**
 * The server's answer, and the only answer that counts.
 *
 * Advisory to the browser and authoritative on the server: `POST
 * /medical/claims` runs the same function again and decides on its own result,
 * so a forged response changes nothing.
 */
export interface MedicalEligibilityResult {
  eligible: boolean;
  reasons: string[];
  failedRules: MedicalEligibilityRule[];
  failures: MedicalEligibilityFailure[];
  /** Things worth saying that do not block anything. */
  warnings: string[];
  policyVersion: MedicalPolicyVersionRef;
  /** The annual limit this employee is measured against, under that version. */
  benefitLimit: number;
  categoryLimits: MedicalCategoryEntitlement[];
  currency: string;
  /** What the rules were measured against, so a refusal can be explained. */
  employment: {
    status: string;
    monthsServed: number | null;
    onProbation: boolean;
  };
}

// --- the benefit summary -----------------------------------------------------

/**
 * How dependents are funded, resolved from the policy so the screen does not
 * have to work it out from two separate settings.
 */
export interface MedicalDependentCoverage {
  spouseCovered: boolean;
  childrenCovered: boolean;
  maxChildren: number;
  parentsCovered: boolean;
  maxParents: number;
  sharesEmployeeLimit: boolean;
  /** Null when dependents share the employee's limit rather than having one. */
  separateAnnualLimit: number | null;
}

/** How much of one category's own cap has gone, for one employee, one year. */
export interface MedicalCategoryUsage {
  category: MedicalCategory;
  label: string;
  enabled: boolean;
  /** Null: the category has no cap of its own and only the annual limit binds. */
  annualLimit: number | null;
  used: number;
  pending: number;
  /** Null wherever `annualLimit` is null - there is nothing to be left of. */
  available: number | null;
}

/**
 * What the employee's Medical screen shows.
 *
 * Every figure is a real aggregate over claim rows, not an estimate.
 *
 * The four money figures answer four different questions and are deliberately
 * not collapsed into two:
 *
 *   used       what has actually been agreed or paid, company share only
 *   pending    the company share of claims nobody has decided yet
 *   remaining  limit - used: what the year has actually cost so far
 *   available  limit - used - pending: what a NEW claim can draw on
 *
 * `remaining` is what an employee is told they have left, and it deliberately
 * ignores pending claims: being quoted a smaller balance because of a claim
 * that may yet be refused is a figure people plan around and then have to be
 * talked out of. `available` is what the claim gate actually enforces, because
 * a limit that ignored pending claims could be spent several times over while
 * the first one waited.
 */
export interface MedicalBenefitView {
  employeeId: string;
  employeeName: string;
  currency: string;
  benefitYear: number;
  eligibility: MedicalEligibilityResult;
  annualLimit: number;
  used: number;
  pending: number;
  remaining: number;
  available: number;
  categoryUsage: MedicalCategoryUsage[];
  /** Whether the caller may maintain the dependents listed below. */
  canManageDependents: boolean;
  /** Whether the caller may submit a claim against this benefit. */
  canSubmitClaim: boolean;
  dependentCoverage: MedicalDependentCoverage;
  dependents: MedicalDependentRecord[];
}

export const medicalBenefitQuerySchema = z.object({
  /**
   * Whose benefit. Omitted means the caller's own, which is the only value an
   * employee can use - the route refuses anything else without `medical.manage`
   * AND the data scope to reach that employee.
   */
  employeeId: z.string().trim().max(64).optional(),
});

// --- claim statuses ----------------------------------------------------------

/**
 * Where a medical claim can be.
 *
 * Declared here rather than in `medical-claims.ts` because the benefit summary
 * in this file is an aggregate over claims and has to name the statuses it
 * counts - see `MEDICAL_CONSUMING_CLAIM_STATUSES` below. The claim shapes
 * themselves import these.
 */
export const MEDICAL_CLAIM_STATUSES = [
  'PENDING',
  'APPROVED',
  'PARTIALLY_APPROVED',
  'REJECTED',
  'CANCELLED',
  'PAID',
] as const;

export type MedicalClaimStatus = (typeof MEDICAL_CLAIM_STATUSES)[number];

export const MEDICAL_CLAIM_STATUS_LABELS: Record<MedicalClaimStatus, string> = {
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  PARTIALLY_APPROVED: 'Partially approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  PAID: 'Paid',
};

/**
 * The statuses that have consumed part of the annual limit.
 *
 * A pending claim has cost the company nothing and must not reduce what the
 * employee is told they have left - being quoted a smaller remaining balance
 * because of a claim that may yet be refused is the kind of figure people plan
 * around and then have to be talked out of.
 */
export const MEDICAL_CONSUMING_CLAIM_STATUSES: readonly MedicalClaimStatus[] = [
  'APPROVED',
  'PARTIALLY_APPROVED',
  'PAID',
];
