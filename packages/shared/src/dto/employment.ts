import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * Employment paperwork: contracts and policies.
 *
 * Both are history-first. A contract that ends is closed, never edited away; a
 * policy that changes gets a new version row rather than new text under an old
 * signature. The schemas below enforce the shape; the services enforce the
 * "never rewrite what somebody already agreed to" rule.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || /^https?:\/\//i.test(v), {
    message: 'Enter a link starting with http:// or https://.',
  });

const isoDate = z
  .string()
  .trim()
  .refine((v) => v !== '' && !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v))
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), 'Enter a valid date.');

// ------------------------------------------------------------------ contracts

export const CONTRACT_TYPES = [
  'PERMANENT',
  'FIXED_TERM',
  'PROBATION',
  'INTERNSHIP',
  'CONSULTANCY',
  'PART_TIME',
  'TEMPORARY',
] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  PERMANENT: 'Permanent',
  FIXED_TERM: 'Fixed term',
  PROBATION: 'Probation',
  INTERNSHIP: 'Internship',
  CONSULTANCY: 'Consultancy',
  PART_TIME: 'Part time',
  TEMPORARY: 'Temporary',
};

export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'RENEWED'] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  TERMINATED: 'Terminated',
  RENEWED: 'Renewed',
};

/**
 * How close a contract is to running out.
 *
 * Derived from the end date every time it is read rather than stored, so a
 * contract nobody has opened for six months still reports the truth. Contracts
 * with no end date are OPEN_ENDED - not "expiring in a very long time".
 */
export const CONTRACT_EXPIRY_STATES = ['OPEN_ENDED', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED'] as const;

export type ContractExpiryState = (typeof CONTRACT_EXPIRY_STATES)[number];

/** A contract inside this many days of its end date is flagged as expiring. */
export const CONTRACT_EXPIRY_WARNING_DAYS = 30;

/**
 * The expiry state of one contract on one day.
 *
 * Exported and pure so the list screen, the profile tab and the API all reach
 * the same answer - a badge that disagrees with the filter behind it is worse
 * than no badge.
 */
export function contractExpiry(
  endDate: string | null,
  today: string,
  warningDays: number = CONTRACT_EXPIRY_WARNING_DAYS,
): { state: ContractExpiryState; daysRemaining: number | null } {
  if (!endDate) return { state: 'OPEN_ENDED', daysRemaining: null };

  const end = Date.parse(`${endDate.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(end) || Number.isNaN(now)) {
    return { state: 'OPEN_ENDED', daysRemaining: null };
  }

  const days = Math.round((end - now) / 86_400_000);
  if (days < 0) return { state: 'EXPIRED', daysRemaining: days };
  if (days <= warningDays) return { state: 'EXPIRING_SOON', daysRemaining: days };
  return { state: 'ACTIVE', daysRemaining: days };
}

export const contractInputSchema = z
  .object({
    employeeId: z.string().trim().min(1, 'Choose an employee.'),
    contractType: z.enum(CONTRACT_TYPES).default('PERMANENT'),
    status: z.enum(CONTRACT_STATUSES).default('ACTIVE'),
    reference: optionalText(64),
    startDate: isoDate,
    endDate: optionalDate,
    documentUrl: optionalUrl,
    documentName: optionalText(200),
    notes: optionalText(2000),
    /** Set to close the contract this one replaces and mark it RENEWED. */
    previousContractId: optionalText(64),
  })
  .refine((v) => v.endDate === null || Date.parse(v.endDate) >= Date.parse(v.startDate), {
    message: 'A contract cannot end before it starts.',
    path: ['endDate'],
  })
  .refine((v) => v.contractType !== 'FIXED_TERM' || v.endDate !== null, {
    message: 'A fixed-term contract needs an end date.',
    path: ['endDate'],
  });

export type ContractInput = z.infer<typeof contractInputSchema>;

/**
 * PATCH: every field optional, and the employee cannot be moved.
 *
 * Reassigning a contract to a different person would rewrite history rather
 * than correct it, so the employee is fixed at creation. A contract filed
 * against the wrong person is cancelled and re-created.
 */
export const contractPatchSchema = z
  .object({
    contractType: z.enum(CONTRACT_TYPES).optional(),
    status: z.enum(CONTRACT_STATUSES).optional(),
    reference: optionalText(64).optional(),
    startDate: isoDate.optional(),
    endDate: optionalDate.optional(),
    documentUrl: optionalUrl.optional(),
    documentName: optionalText(200).optional(),
    notes: optionalText(2000).optional(),
  })
  .refine(
    (v) =>
      v.startDate === undefined ||
      v.endDate === undefined ||
      v.endDate === null ||
      Date.parse(v.endDate) >= Date.parse(v.startDate),
    { message: 'A contract cannot end before it starts.', path: ['endDate'] },
  );

export type ContractPatchInput = z.infer<typeof contractPatchSchema>;

export const contractQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  contractType: z.enum(CONTRACT_TYPES).optional(),
  /** `expiring` narrows to contracts inside the warning window or already past it. */
  expiry: z.enum(['expiring', 'expired', 'active']).optional(),
});

export interface ContractRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  contractType: ContractType;
  status: ContractStatus;
  reference: string | null;
  startDate: string;
  endDate: string | null;
  documentUrl: string | null;
  documentName: string | null;
  previousContractId: string | null;
  notes: string | null;
  /** Derived from endDate at read time; never stored. */
  expiryState: ContractExpiryState;
  daysRemaining: number | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------- policies

export const POLICY_ACKNOWLEDGEMENT_STATUSES = ['PENDING', 'ACKNOWLEDGED', 'DECLINED'] as const;

export type PolicyAcknowledgementStatus = (typeof POLICY_ACKNOWLEDGEMENT_STATUSES)[number];

export const POLICY_ACKNOWLEDGEMENT_LABELS: Record<PolicyAcknowledgementStatus, string> = {
  PENDING: 'Awaiting acknowledgement',
  ACKNOWLEDGED: 'Acknowledged',
  DECLINED: 'Declined',
};

export const policyInputSchema = z.object({
  name: z.string().trim().min(2, 'Give the policy a name.').max(160),
  version: z.string().trim().min(1, 'Give the version a label.').max(32).default('1.0'),
  category: optionalText(80),
  description: optionalText(2000),
  effectiveDate: isoDate,
  documentUrl: optionalUrl,
  documentName: optionalText(200),
  isActive: z.boolean().default(true),
  /**
   * The version this one replaces. Setting it deactivates the earlier row -
   * which never touches the acknowledgements already recorded against it.
   */
  supersedesId: optionalText(64),
});

export type PolicyInput = z.infer<typeof policyInputSchema>;

export const policyPatchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  category: optionalText(80).optional(),
  description: optionalText(2000).optional(),
  effectiveDate: isoDate.optional(),
  documentUrl: optionalUrl.optional(),
  documentName: optionalText(200).optional(),
  isActive: z.boolean().optional(),
});

export type PolicyPatchInput = z.infer<typeof policyPatchSchema>;

export const policyQuerySchema = paginationQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  category: z.string().trim().max(80).optional(),
});

export interface PolicyRecord {
  id: string;
  name: string;
  version: string;
  category: string | null;
  description: string | null;
  effectiveDate: string;
  documentUrl: string | null;
  documentName: string | null;
  isActive: boolean;
  supersedesId: string | null;
  /** How many employees hold it, and how many have signed it off. */
  assignedCount: number;
  acknowledgedCount: number;
  createdAt: string;
}

export const policyAssignSchema = z.object({
  policyId: z.string().trim().min(1, 'Choose a policy.'),
  /** Empty means every active employee. */
  employeeIds: z.array(z.string().trim().min(1)).max(2000).default([]),
  dueDate: optionalDate,
});

export type PolicyAssignInput = z.infer<typeof policyAssignSchema>;

export const policyAcknowledgeSchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'DECLINED']).default('ACKNOWLEDGED'),
  note: optionalText(1000),
});

export type PolicyAcknowledgeInput = z.infer<typeof policyAcknowledgeSchema>;

export const policyAssignmentQuerySchema = paginationQuerySchema.extend({
  policyId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
  status: z.enum(POLICY_ACKNOWLEDGEMENT_STATUSES).optional(),
  /** `mine` limits the list to the caller's own assignments. */
  view: z.enum(['all', 'mine']).default('all'),
});

export interface PolicyAssignmentRecord {
  id: string;
  policyId: string;
  policyName: string;
  policyVersion: string;
  policyCategory: string | null;
  effectiveDate: string;
  documentUrl: string | null;
  documentName: string | null;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  status: PolicyAcknowledgementStatus;
  assignedAt: string;
  dueDate: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  /** True when the caller is the employee and it is still pending. */
  canAcknowledge: boolean;
}
