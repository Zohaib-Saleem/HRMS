import { z } from 'zod';
import { paginationQuerySchema } from './common.js';
import { EMPLOYMENT_STATUSES } from './employee.js';
import { MEDICAL_CATEGORIES, type MedicalCategory } from './medical-policy.js';
import {
  MEDICAL_CLAIM_STATUSES,
  type MedicalClaimStatus,
  type MedicalPolicyVersionRef,
} from './medical.js';

/**
 * Medical claims: asking to be reimbursed, and being told yes, partly or no.
 *
 * Two rules shape everything in this file.
 *
 * The first is that a claim is measured by the policy version in force WHEN IT
 * WAS SUBMITTED, and that version stays pinned to it for the rest of its life.
 * A claim approved in March is still a March claim after the annual limit moves
 * in April - the split it was decided on, the category cap it was measured
 * against and the rules it had to satisfy are all read from the version on
 * file. Nothing re-judges a decided claim.
 *
 * The second is that a claim is decided by HR, not by a line manager. Every
 * other request in this product runs through the ordinary approval chain, which
 * starts at the requester's manager. A medical claim carries a category, a
 * provider and an amount, and a manager has no business seeing what treatment
 * somebody had - so claims have their own decision path, gated on
 * `medical.claim.approve`. That is a deliberate departure from the house
 * pattern and the only one in this module.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

/** A calendar day, or nothing. An empty date input sends ''. */
const optionalDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-MM-dd date.')
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

// --- supporting documents ----------------------------------------------------

export const MEDICAL_CLAIM_DOCUMENT_TYPES = [
  'RECEIPT',
  'PRESCRIPTION',
  'DIAGNOSIS',
  'OTHER',
] as const;

export type MedicalClaimDocumentType = (typeof MEDICAL_CLAIM_DOCUMENT_TYPES)[number];

export const MEDICAL_CLAIM_DOCUMENT_LABELS: Record<MedicalClaimDocumentType, string> = {
  RECEIPT: 'Receipt',
  PRESCRIPTION: 'Prescription',
  DIAGNOSIS: 'Diagnosis / treatment document',
  OTHER: 'Other document',
};

/**
 * A document, recorded as its reference rather than as a file.
 *
 * This product has no file storage. Holding the number printed on the paper is
 * what makes the policy's document requirements enforceable today and what lets
 * a payment be reconciled against paperwork kept elsewhere; when a file store
 * lands, a file reference joins this shape without changing it.
 */
export const medicalClaimDocumentSchema = z.object({
  type: z.enum(MEDICAL_CLAIM_DOCUMENT_TYPES, {
    errorMap: () => ({ message: 'Choose what kind of document this is.' }),
  }),
  reference: z
    .string()
    .trim()
    .min(1, 'Enter the number printed on the document.')
    .max(120, 'Keep the reference under 120 characters.'),
  note: optionalText(500),
});

export type MedicalClaimDocumentInput = z.infer<typeof medicalClaimDocumentSchema>;

export interface MedicalClaimDocumentRecord {
  id: string;
  type: MedicalClaimDocumentType;
  reference: string;
  note: string | null;
  createdAt: string;
}

// --- statuses ----------------------------------------------------------------

export const MEDICAL_CLAIM_STATUS_DESCRIPTIONS: Record<MedicalClaimStatus, string> = {
  PENDING: 'Submitted and waiting for a decision. Nothing has been paid.',
  APPROVED: 'Agreed in full. Awaiting payment.',
  PARTIALLY_APPROVED: 'Agreed for less than was claimed. Awaiting payment.',
  REJECTED: 'Declined. Nothing is paid and nothing is drawn from the limit.',
  CANCELLED: 'Withdrawn by the claimant before a decision.',
  PAID: 'Paid out.',
};

/** Statuses that can still change. Everything else is history. */
export const MEDICAL_CLAIM_OPEN_STATUSES: readonly MedicalClaimStatus[] = [
  'PENDING',
  'APPROVED',
  'PARTIALLY_APPROVED',
];

/** Statuses a decision has been made on, in the claimant's favour. */
export const MEDICAL_CLAIM_AGREED_STATUSES: readonly MedicalClaimStatus[] = [
  'APPROVED',
  'PARTIALLY_APPROVED',
  'PAID',
];

// --- the contribution split --------------------------------------------------

/**
 * How one settled amount divides between the company and the employee.
 *
 * Shared so the submission preview, the decision screen and the stored figures
 * are produced by the same function. The employee's share is the remainder
 * rather than a second rounded percentage, so the two always add back up to the
 * amount exactly - two independent roundings would leave a stray unit that has
 * to belong to somebody.
 */
export function splitContribution(
  amount: number,
  companyPercent: number,
): { companyAmount: number; employeeAmount: number } {
  const company = Math.round(amount * companyPercent) / 100;
  const rounded = Math.round(company * 100) / 100;
  return {
    companyAmount: rounded,
    employeeAmount: Math.round((amount - rounded) * 100) / 100,
  };
}

// --- submitting --------------------------------------------------------------

export const medicalClaimSubmitSchema = z.object({
  /**
   * Whose claim. Omitted means the caller's own, which is the only value an
   * employee can use - recording a claim for somebody else needs
   * `medical.manage` and the data scope to reach them.
   */
  employeeId: z.string().trim().max(64).optional(),
  category: z.enum(MEDICAL_CATEGORIES, {
    errorMap: () => ({ message: 'Choose what the treatment was.' }),
  }),
  /** Null when the claim is for the employee themselves. */
  dependentId: z.string().trim().max(64).nullish().transform((v) => (v === '' || v === undefined ? null : v)),
  treatmentDate: optionalDay,
  providerName: optionalText(200),
  requestedAmount: z.coerce
    .number({ invalid_type_error: 'Enter the amount you paid.' })
    .positive('Enter an amount greater than zero.')
    .max(1_000_000_000, 'That is larger than this field allows.'),
  notes: optionalText(2000),
  documents: z.array(medicalClaimDocumentSchema).max(20, 'That is more documents than a claim can carry.').default([]),
  /**
   * An authorised user recording a claim the rules refuse.
   *
   * Present only on the administrative route. Never available to a claimant for
   * their own claim: an employee waving themselves past the rules is not an
   * override, it is the absence of a rule.
   */
  overrideReason: optionalText(1000),
});

export type MedicalClaimSubmitInput = z.infer<typeof medicalClaimSubmitSchema>;

/**
 * Deciding a claim.
 *
 * `approvedAmount` absent means "all of it". Present and lower means a partial
 * approval, which the policy has to permit; present and higher is refused,
 * because approving more than was claimed is not a decision about this claim.
 */
export const medicalClaimDecisionSchema = z.object({
  approvedAmount: z.coerce.number().min(0).max(1_000_000_000).optional(),
  note: optionalText(1000),
  /** Allows a decision the rules refuse, when the policy permits overrides. */
  overrideReason: optionalText(1000),
});

export type MedicalClaimDecisionInput = z.infer<typeof medicalClaimDecisionSchema>;

export const medicalClaimRejectSchema = z.object({
  reason: z.string().trim().min(3, 'Say why it was declined.').max(1000),
});

export const medicalClaimCancelSchema = z.object({
  reason: optionalText(1000),
});

export const medicalClaimPaySchema = z.object({
  paymentReference: optionalText(120),
  paidAt: optionalDay,
});

export const medicalClaimQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(MEDICAL_CLAIM_STATUSES).optional(),
  category: z.enum(MEDICAL_CATEGORIES).optional(),
  /** The claimant's employment status - the employee's own field, by relation. */
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  /** `mine` limits the list to the caller's own claims. */
  view: z.enum(['all', 'mine']).default('all'),
  /** Benefit year, as a calendar year. Omitted means every year. */
  year: z.coerce.number().int().min(2000).max(2200).optional(),
});

export type MedicalClaimQuery = z.infer<typeof medicalClaimQuerySchema>;

/** What the submit form needs to preview a claim before anybody sends it. */
export const medicalClaimAssessmentQuerySchema = z.object({
  employeeId: z.string().trim().max(64).optional(),
  category: z.enum(MEDICAL_CATEGORIES),
  dependentId: z.string().trim().max(64).optional(),
  treatmentDate: z.string().trim().max(10).optional(),
  requestedAmount: z.coerce.number().min(0).max(1_000_000_000).optional(),
});

// --- assessment --------------------------------------------------------------

/**
 * Which rule a claim failed.
 *
 * A machine-readable key beside every human sentence, so the form can highlight
 * the field a failure belongs to without parsing English, and so a test can
 * assert the rule rather than its wording.
 */
export const MEDICAL_CLAIM_RULES = [
  'ELIGIBILITY',
  'CATEGORY_DISABLED',
  'AMOUNT',
  'TREATMENT_DATE_REQUIRED',
  'TREATMENT_DATE_FUTURE',
  'BACKDATED_NOT_ALLOWED',
  'BACKDATED_LIMIT',
  'SUBMISSION_DEADLINE',
  'PROVIDER_REQUIRED',
  'DOCUMENT_REQUIRED',
  'MAX_CLAIM_AMOUNT',
  'CATEGORY_ANNUAL_LIMIT',
  'ANNUAL_LIMIT',
  'DEPENDENT_NOT_FOUND',
  'DEPENDENT_NOT_COVERED',
] as const;

export type MedicalClaimRule = (typeof MEDICAL_CLAIM_RULES)[number];

export interface MedicalClaimFailure {
  rule: MedicalClaimRule;
  message: string;
}

/**
 * The server's verdict on a claim, and the only one that counts.
 *
 * Advisory to the browser and authoritative on the server: the submit endpoint
 * runs this again on what actually arrived and refuses on its own result, so a
 * forged preview changes nothing.
 */
export interface MedicalClaimAssessment {
  allowed: boolean;
  reasons: string[];
  failedRules: MedicalClaimRule[];
  failures: MedicalClaimFailure[];
  warnings: string[];

  policyVersion: MedicalPolicyVersionRef;
  currency: string;

  /** The split the amount would settle at, under the policy in force. */
  requestedAmount: number;
  companyAmount: number;
  employeeAmount: number;
  companyContributionPercent: number;
  employeeContributionPercent: number;

  /** The employee's yearly position. */
  annualLimit: number;
  used: number;
  pending: number;
  available: number;

  /** The category's own position. Null limits mean no cap of its own. */
  categoryAnnualLimit: number | null;
  categoryUsed: number;
  categoryAvailable: number | null;
  maxClaimAmount: number | null;

  /** Which documents the policy insists on for this claim. */
  requiredDocuments: MedicalClaimDocumentType[];
  requireProviderName: boolean;
  requireTreatmentDate: boolean;

  /** Whether the policy would let an authorised user allow a refusal through. */
  overrideAllowed: boolean;
  /** Whether that override has to carry a reason. */
  requireOverrideReason: boolean;
  /** Whether a decision is needed at all, or the policy settles it on arrival. */
  requiresApproval: boolean;
}

// --- read shapes -------------------------------------------------------------

export interface MedicalClaimRecord {
  id: string;
  claimNumber: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;

  category: MedicalCategory;
  categoryLabel: string;

  /** Null when the claim is for the employee themselves. */
  dependentId: string | null;
  dependentName: string | null;
  dependentRelationship: string | null;

  treatmentDate: string | null;
  providerName: string | null;
  notes: string | null;

  currency: string;
  requestedAmount: number;
  /** Null while the claim is pending. */
  approvedAmount: number | null;
  companyAmount: number | null;
  employeeAmount: number | null;

  /**
   * The split this claim settles at, read from the policy version it is PINNED
   * to rather than from the live one.
   *
   * Here because a reviewer deciding a claim has to be shown the percentages
   * that will actually be applied to it, and those can have moved since it was
   * submitted. Taking them from the current policy would show one figure on the
   * decision screen and record another - which is the whole failure the pinned
   * `policyId` exists to prevent.
   */
  companyContributionPercent: number;
  employeeContributionPercent: number;

  status: MedicalClaimStatus;

  /** The version the claim was submitted under, and is still measured by. */
  policyId: string;

  submittedAt: string;
  decidedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;

  reviewedByName: string | null;
  decisionNote: string | null;
  rejectionReason: string | null;
  /** Present only for a caller who may see how an exception was made. */
  overrideReason: string | null;
  paymentReference: string | null;

  /** What the caller may do, decided server-side from permissions and scope. */
  canDecide: boolean;
  canCancel: boolean;
  canMarkPaid: boolean;
}

export interface MedicalClaimDetail extends MedicalClaimRecord {
  documents: MedicalClaimDocumentRecord[];
}
