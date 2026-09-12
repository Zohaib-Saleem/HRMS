import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/**
 * The company-wide medical policy: what the benefit covers, who it reaches and
 * what a claim has to look like.
 *
 * Everything here is configuration. No limit, percentage or deadline in this
 * file appears as a literal anywhere in the eligibility engine - the engine
 * reads a policy row and compares, and a company that wants a 250,000 annual
 * limit changes a number on a settings screen rather than waiting for a
 * deployment.
 *
 * Policies are VERSIONED rather than edited, exactly as the loan policy is.
 * Each save writes a new row with its own `effectiveFrom`, and the row in force
 * at an instant is the newest one whose `effectiveFrom` is at or before it. Two
 * things follow, and both are the point:
 *
 *   - A claim stays explicable. The policy that governed a claim is the version
 *     in force when it was submitted, and that version still exists, unedited,
 *     however many times the rules have moved since. A claim already decided is
 *     never re-judged by rules written after it.
 *   - History needs no second table. The change log IS the sequence of
 *     versions, and a field-level diff between neighbours is derived on read,
 *     so it cannot drift from the values it describes.
 *
 * Currency is deliberately absent from every field below. Amounts are plain
 * numbers in the company's own currency, read from `Company.currency` the same
 * way payroll, loans and payslips read it - nothing here assumes PKR.
 */

// --- categories --------------------------------------------------------------

/**
 * What a claim can be made against.
 *
 * A fixed list rather than free text: a category carries its own limits and
 * contribution split, so it has to be something the policy can be configured
 * for. Each one is independently switched on or off, so a company that does not
 * offer dental turns dental off rather than pretending it does not exist.
 */
export const MEDICAL_CATEGORIES = [
  'OPD',
  'HOSPITALIZATION',
  'MEDICINES',
  'DIAGNOSTICS',
  'DENTAL',
  'OPTICAL',
  'EMERGENCY',
] as const;

export type MedicalCategory = (typeof MEDICAL_CATEGORIES)[number];

export const MEDICAL_CATEGORY_LABELS: Record<MedicalCategory, string> = {
  OPD: 'OPD',
  HOSPITALIZATION: 'Hospitalization',
  MEDICINES: 'Medicines',
  DIAGNOSTICS: 'Diagnostics / Laboratory',
  DENTAL: 'Dental',
  OPTICAL: 'Optical',
  EMERGENCY: 'Emergency',
};

export const MEDICAL_CATEGORY_DESCRIPTIONS: Record<MedicalCategory, string> = {
  OPD: 'Outpatient consultations and clinic visits.',
  HOSPITALIZATION: 'Admission, surgery and inpatient treatment.',
  MEDICINES: 'Prescribed medication.',
  DIAGNOSTICS: 'Laboratory tests, imaging and pathology.',
  DENTAL: 'Dental treatment.',
  OPTICAL: 'Eye tests, lenses and frames.',
  EMERGENCY: 'Accident and emergency treatment.',
};

// --- validation helpers ------------------------------------------------------

/**
 * A money ceiling that may be left unset.
 *
 * Null means "no separate cap here", which is a different statement from zero -
 * zero is a cap of nothing, and a category capped at nothing pays out nothing.
 * A number input sends an empty string when it is cleared, so that is folded to
 * null before the number is parsed rather than becoming NaN.
 */
const optionalAmount = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? null : v),
    z.coerce
      .number({ invalid_type_error: 'Enter an amount, or leave it blank for no cap.' })
      .min(0, 'An amount cannot be negative.')
      .max(max, 'That is larger than this field allows.')
      .nullable(),
  );

const amount = (max: number) =>
  z.coerce
    .number({ invalid_type_error: 'Enter an amount.' })
    .min(0, 'An amount cannot be negative.')
    .max(max, 'That is larger than this field allows.');

const percent = () =>
  z.coerce
    .number({ invalid_type_error: 'Enter a percentage.' })
    .min(0, 'A percentage cannot be below 0.')
    .max(100, 'A percentage cannot be above 100.');

const wholeCount = (max: number) =>
  z.coerce
    .number({ invalid_type_error: 'Enter a whole number.' })
    .int('Enter a whole number.')
    .min(0, 'This cannot be negative.')
    .max(max);

/** The largest amount any single money field accepts. A sanity rail, not policy. */
const MAX_AMOUNT = 1_000_000_000;

// --- category settings -------------------------------------------------------

export interface MedicalCategoryLimitInput {
  category: MedicalCategory;
  enabled: boolean;
  /** Null: this category has no cap of its own and only the annual limit binds. */
  annualLimit: number | null;
  /** Null: no ceiling on one claim. */
  maxClaimAmount: number | null;
  companyContributionPercent: number;
  employeeContributionPercent: number;
}

export const medicalCategoryLimitSchema = z
  .object({
    category: z.enum(MEDICAL_CATEGORIES),
    enabled: z.boolean(),
    annualLimit: optionalAmount(MAX_AMOUNT),
    maxClaimAmount: optionalAmount(MAX_AMOUNT),
    companyContributionPercent: percent(),
    employeeContributionPercent: percent(),
  })
  .superRefine((value, ctx) => {
    /*
     * The split has to be a split.
     *
     * The two percentages describe how one claim is divided, so anything other
     * than 100 leaves part of every claim belonging to nobody - and whichever
     * way the code later resolved that would be an invented rule rather than a
     * configured one. Checked on the pair rather than on either field, because
     * neither one is wrong on its own.
     */
    const total = value.companyContributionPercent + value.employeeContributionPercent;
    if (Math.abs(total - 100) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companyContributionPercent'],
        message: `Company and employee contributions have to total 100%. They currently total ${total}%.`,
      });
    }
  });

/**
 * What each category starts as.
 *
 * Every category on, no cap of its own, and the company paying in full. That is
 * the most permissive honest starting point: a company that has not configured
 * anything yet is best served by a benefit that works and can be tightened,
 * rather than one that silently refuses claims because a limit nobody set
 * defaulted to zero.
 */
export const MEDICAL_CATEGORY_DEFAULTS: Record<MedicalCategory, Omit<MedicalCategoryLimitInput, 'category'>> = {
  OPD: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  HOSPITALIZATION: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  MEDICINES: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  DIAGNOSTICS: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  DENTAL: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  OPTICAL: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
  EMERGENCY: { enabled: true, annualLimit: null, maxClaimAmount: null, companyContributionPercent: 100, employeeContributionPercent: 0 },
};

export const defaultCategoryLimits = (): MedicalCategoryLimitInput[] =>
  MEDICAL_CATEGORIES.map((category) => ({ category, ...MEDICAL_CATEGORY_DEFAULTS[category] }));

// --- the policy itself -------------------------------------------------------

/**
 * The defaults a company starts with, and the values the first policy version
 * is created from.
 *
 * Held here rather than only as Prisma column defaults so the API, the settings
 * screen and the tests all read one list. The database carries the same
 * defaults so a row inserted by hand is still a valid policy.
 *
 * These are DEFAULTS, not company rules. Every one of them is editable on
 * Settings -> Medical -> Medical Policy without a deployment.
 */
export const MEDICAL_POLICY_DEFAULTS = {
  // general
  enabled: true,
  policyName: 'Company Medical Benefit',
  description: '',

  // eligibility
  minEmploymentMonths: 3,
  allowProbation: false,
  allowPermanent: true,
  blockResigned: true,
  blockTerminated: true,

  // annual benefit
  annualLimitPerEmployee: 100_000,

  // dependents
  spouseCovered: true,
  childrenCovered: true,
  maxChildren: 4,
  parentsCovered: false,
  maxParents: 2,
  dependentsShareEmployeeLimit: true,
  /** Read only when dependents do NOT share the employee's limit. */
  dependentAnnualLimit: 0,

  // documents
  requireReceipt: true,
  requirePrescription: false,
  requireDiagnosis: false,
  requireHospitalName: true,
  requireTreatmentDate: true,

  // claim rules
  claimSubmissionDeadlineDays: 30,
  allowBackdatedClaims: true,
  maxBackdatedDays: 30,
  requireHrApproval: true,
  allowPartialApproval: true,
  allowEmployeeCancelPending: true,
  allowHrOverride: true,
  requireOverrideReason: true,

  // carry forward
  allowCarryForward: false,
  maxCarryForwardAmount: 0,
} as const;

/**
 * The editable policy.
 *
 * Bounds are sanity rails, not policy: they stop a typo becoming a rule (a
 * 4,000-month waiting period, a negative limit) and otherwise stay out of the
 * way. Where a real company might plausibly want the value, it is allowed.
 */
export const medicalPolicySchema = z
  .object({
    // --- general -------------------------------------------------------------
    enabled: z.boolean(),
    policyName: z
      .string()
      .trim()
      .min(1, 'Give the policy a name.')
      .max(160, 'Keep the name under 160 characters.'),
    description: z
      .string()
      .trim()
      .max(2000, 'Keep the description under 2000 characters.')
      .default(''),

    // --- eligibility ---------------------------------------------------------
    minEmploymentMonths: wholeCount(240),
    allowProbation: z.boolean(),
    allowPermanent: z.boolean(),
    blockResigned: z.boolean(),
    blockTerminated: z.boolean(),

    // --- annual benefit ------------------------------------------------------
    annualLimitPerEmployee: amount(MAX_AMOUNT),

    // --- categories ----------------------------------------------------------
    /**
     * One entry per category, all of them, every time.
     *
     * A partial list would leave the categories it omits to be filled in from
     * somewhere, and "somewhere" is how a company ends up with a dental limit
     * nobody set. The screen always sends the full set.
     */
    categories: z
      .array(medicalCategoryLimitSchema)
      .length(MEDICAL_CATEGORIES.length, 'Every category has to be supplied.')
      .refine(
        (list) => new Set(list.map((c) => c.category)).size === list.length,
        'A category cannot appear twice.',
      )
      .refine(
        (list) => MEDICAL_CATEGORIES.every((c) => list.some((entry) => entry.category === c)),
        'Every category has to be supplied.',
      ),

    // --- dependents ----------------------------------------------------------
    spouseCovered: z.boolean(),
    childrenCovered: z.boolean(),
    maxChildren: wholeCount(20),
    parentsCovered: z.boolean(),
    maxParents: wholeCount(10),
    dependentsShareEmployeeLimit: z.boolean(),
    dependentAnnualLimit: amount(MAX_AMOUNT),

    // --- documents -----------------------------------------------------------
    requireReceipt: z.boolean(),
    requirePrescription: z.boolean(),
    requireDiagnosis: z.boolean(),
    requireHospitalName: z.boolean(),
    requireTreatmentDate: z.boolean(),

    // --- claim rules ---------------------------------------------------------
    claimSubmissionDeadlineDays: wholeCount(3650),
    allowBackdatedClaims: z.boolean(),
    maxBackdatedDays: wholeCount(3650),
    requireHrApproval: z.boolean(),
    allowPartialApproval: z.boolean(),
    allowEmployeeCancelPending: z.boolean(),
    allowHrOverride: z.boolean(),
    requireOverrideReason: z.boolean(),

    // --- carry forward -------------------------------------------------------
    allowCarryForward: z.boolean(),
    maxCarryForwardAmount: amount(MAX_AMOUNT),

    /**
     * When the new version takes effect. Defaults to the moment it is saved.
     * A future date lets a company announce a change before it bites; the
     * version in force is still whichever one has already started.
     *
     * An empty string means "now", not "invalid". The settings screen offers a
     * date field that is blank until somebody fills it in, and a browser sends
     * an untouched date input as `''` - so rejecting the empty string would
     * refuse every save that did not schedule one, which is almost all of them.
     */
    effectiveFrom: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v === '' ? undefined : v)),
  })
  .superRefine((value, ctx) => {
    // A carry-forward ceiling of zero with carry-forward switched on carries
    // nothing forward, which is not what the person who switched it on meant.
    if (value.allowCarryForward && value.maxCarryForwardAmount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxCarryForwardAmount'],
        message: 'Carry-forward is on, so set the most that may be carried.',
      });
    }
    // Same shape of mistake: separate dependent limits, set to nothing.
    if (!value.dependentsShareEmployeeLimit && value.dependentAnnualLimit <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependentAnnualLimit'],
        message: 'Dependents have a limit of their own, so it has to be more than zero.',
      });
    }
  });

export type MedicalPolicyInput = z.infer<typeof medicalPolicySchema>;

/** The scalar policy fields - everything except the category rows and the date. */
export type MedicalPolicyValues = Omit<MedicalPolicyInput, 'categories' | 'effectiveFrom'>;

/** One stored version, as the API reports it. */
export interface MedicalPolicyRecord extends MedicalPolicyValues {
  id: string;
  categories: MedicalCategoryLimitInput[];
  effectiveFrom: string;
  createdAt: string;
  /** Null for the seeded default, which nobody authored. */
  createdByName: string | null;
  /** True for the version currently in force. */
  isCurrent: boolean;
}

/** What the policy screen needs: the live policy plus whether you may edit it. */
export interface MedicalPolicyView {
  policy: MedicalPolicyRecord;
  canManage: boolean;
  currency: string;
  /** Present only when a version has been saved with a future effective date. */
  scheduled: MedicalPolicyRecord | null;
}

// --- history -----------------------------------------------------------------

/** One field that moved between two consecutive versions. */
export interface MedicalPolicyFieldChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

/**
 * One entry in the change history: a version, and how it differs from the one
 * it replaced. The first version has no predecessor and so no changes.
 */
export interface MedicalPolicyHistoryEntry {
  id: string;
  effectiveFrom: string;
  changedAt: string;
  changedByName: string | null;
  changes: MedicalPolicyFieldChange[];
}

export const medicalPolicyHistoryQuerySchema = paginationQuerySchema;

/** Field labels, shared by the settings form, the confirmation and the history. */
export const MEDICAL_POLICY_LABELS: Record<keyof MedicalPolicyValues | 'effectiveFrom', string> = {
  enabled: 'Medical benefit enabled',
  policyName: 'Policy name',
  description: 'Policy description',
  minEmploymentMonths: 'Minimum employment period',
  allowProbation: 'Allow probation employees',
  allowPermanent: 'Allow permanent employees',
  blockResigned: 'Block resigned employees',
  blockTerminated: 'Block terminated employees',
  annualLimitPerEmployee: 'Annual medical limit per employee',
  spouseCovered: 'Spouse covered',
  childrenCovered: 'Children covered',
  maxChildren: 'Maximum number of children',
  parentsCovered: 'Parents covered',
  maxParents: 'Maximum number of parents',
  dependentsShareEmployeeLimit: 'Dependents share the employee limit',
  dependentAnnualLimit: 'Separate dependent annual limit',
  requireReceipt: 'Require receipt',
  requirePrescription: 'Require prescription',
  requireDiagnosis: 'Require diagnosis document',
  requireHospitalName: 'Require hospital / clinic name',
  requireTreatmentDate: 'Require treatment date',
  claimSubmissionDeadlineDays: 'Claim submission deadline',
  allowBackdatedClaims: 'Allow claims for previous treatment dates',
  maxBackdatedDays: 'Maximum backdated claim days',
  requireHrApproval: 'Require HR approval',
  allowPartialApproval: 'Allow partial approval',
  allowEmployeeCancelPending: 'Allow employee to cancel a pending claim',
  allowHrOverride: 'Allow HR override',
  requireOverrideReason: 'Require an override reason',
  allowCarryForward: 'Allow unused benefit to carry forward',
  maxCarryForwardAmount: 'Maximum carry-forward amount',
  effectiveFrom: 'Effective from',
};

/** The category settings, labelled for the same three places. */
export const MEDICAL_CATEGORY_FIELD_LABELS: Record<
  keyof Omit<MedicalCategoryLimitInput, 'category'>,
  string
> = {
  enabled: 'Enabled',
  annualLimit: 'Annual limit',
  maxClaimAmount: 'Maximum claim',
  companyContributionPercent: 'Company contribution',
  employeeContributionPercent: 'Employee contribution',
};
