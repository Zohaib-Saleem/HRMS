import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

export const EMPLOYEE_STATUSES = [
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'INACTIVE',
  'RESIGNED',
  'TERMINATED',
] as const;

/**
 * Statuses that end the employment.
 *
 * Both keep every attendance, leave and payroll record the person ever had -
 * the row is retained and the status changes, which is the whole reason there
 * is no delete. What they share operationally is that the linked login is
 * switched off and the employee stops appearing in "who works here" lists.
 */
export const EMPLOYEE_EXIT_STATUSES = ['RESIGNED', 'TERMINATED'] as const;

export type EmployeeExitStatus = (typeof EMPLOYEE_EXIT_STATUSES)[number];

export function isExitStatus(status: string): status is EmployeeExitStatus {
  return (EMPLOYEE_EXIT_STATUSES as readonly string[]).includes(status);
}

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'INTERN',
  'TEMPORARY',
] as const;
/**
 * The employment stage. The canonical list, and the only one.
 *
 * Mirrors `enum EmploymentStatus` in schema.prisma exactly. Three separate
 * questions live on an employee record and this is the third of them:
 *
 *   - EMPLOYEE_STATUSES  - is this person employed at all (Active, Resigned...)
 *   - EMPLOYMENT_TYPES   - on what terms (Full time, Part time, Contract...)
 *   - EMPLOYMENT_STATUSES - how far through the arrangement they are
 *
 * None of the three can stand in for another. A part-time permanent employee
 * and a full-time probationer are both ordinary people to employ, and the first
 * two lists cannot express either.
 *
 * Loans and medical both read the employee's value of THIS list. Neither keeps
 * an employment-status field of its own, which is what stops the two benefits
 * disagreeing about the same person.
 */
export const EMPLOYMENT_STATUSES = ['PROBATION', 'PERMANENT', 'INTERNEE'] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  PROBATION: 'Probation',
  PERMANENT: 'Permanent',
  INTERNEE: 'Internee',
};

export const EMPLOYMENT_STATUS_DESCRIPTIONS: Record<EmploymentStatus, string> = {
  PROBATION: 'Serving an initial period; not yet confirmed.',
  PERMANENT: 'Confirmed in post, on the confirmation date held with the record.',
  INTERNEE: 'On an internship. Separate from the Intern employment type, which is the contract.',
};

export function isEmploymentStatus(value: unknown): value is EmploymentStatus {
  return typeof value === 'string' && (EMPLOYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The eligible-statuses half of a benefit policy.
 *
 * Both the loan policy and the medical policy carry these three switches, under
 * these three names, and both engines read them through the one function below.
 * Structural rather than a shared base type on purpose: the two policies are
 * versioned separately and have nothing else in common, and a type that only
 * names what is actually shared cannot drag one policy's fields into the other.
 */
export interface EmploymentStatusPolicy {
  allowProbation: boolean;
  allowPermanent: boolean;
  allowInternee: boolean;
}

/**
 * Whether a policy covers an employment status.
 *
 * The single place the question is answered, for every benefit. Nothing here
 * is hardcoded per status - each one is a switch a company sets, so "interns
 * cannot apply" is a decision on a settings screen rather than a sentence in
 * this file.
 *
 * A null status is eligible. That is the deliberate reading of an unclassified
 * record: it says nothing, and the same doctrine already governs a missing
 * confirmation date. Most of the imported roster carried a status and a few
 * rows did not, and refusing a benefit on the strength of a field nobody filled
 * in would be a worse answer than having no answer. The other rules - service
 * length, salary, attendance - still apply to those people in full.
 */
export function isEmploymentStatusEligible(
  policy: EmploymentStatusPolicy,
  status: EmploymentStatus | null | undefined,
): boolean {
  switch (status) {
    case 'PROBATION':
      return policy.allowProbation;
    case 'PERMANENT':
      return policy.allowPermanent;
    case 'INTERNEE':
      return policy.allowInternee;
    default:
      return true;
  }
}

/** The statuses a policy covers, for a settings screen and for a summary line. */
export function eligibleEmploymentStatuses(policy: EmploymentStatusPolicy): EmploymentStatus[] {
  return EMPLOYMENT_STATUSES.filter((s) => isEmploymentStatusEligible(policy, s));
}

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export const MARITAL_STATUSES = ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'OTHER'] as const;

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  SUSPENDED: 'Suspended',
  INACTIVE: 'Inactive',
  RESIGNED: 'Resigned',
  TERMINATED: 'Terminated',
};

/** What each status actually means, for the form and the profile header. */
export const EMPLOYEE_STATUS_DESCRIPTIONS: Record<EmployeeStatus, string> = {
  ACTIVE: 'Employed and working.',
  ON_LEAVE: 'Employed and on recorded leave.',
  SUSPENDED: 'Employed but stood down; the login is switched off.',
  INACTIVE: 'Employed but not currently working - a sabbatical or a long unpaid break.',
  RESIGNED: 'Left of their own accord. All history is kept.',
  TERMINATED: 'Employment ended by the company. All history is kept.',
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CONTRACT: 'Contract',
  INTERN: 'Intern',
  TEMPORARY: 'Temporary',
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value));

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .nullish()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine((value) => value === null || z.string().email().safeParse(value).success, {
    message: 'Enter a valid email address.',
  });

/** Accepts an ISO date or a yyyy-MM-dd input value; empty becomes null. */
const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
    message: 'Enter a valid date.',
  });

const optionalId = optionalText(64);

const employeeBaseSchema = z
  .object({
    // identity
    employeeNumber: optionalText(32),
    firstName: z.string().trim().min(1, 'First name is required.').max(80),
    middleName: optionalText(80),
    lastName: z.string().trim().min(1, 'Last name is required.').max(80),
    displayName: optionalText(160),
    workEmail: optionalEmail,
    personalEmail: optionalEmail,
    phone: optionalText(40),
    personalPhone: optionalText(40),
    photoUrl: optionalText(500),

    // job
    jobTitle: optionalText(120),
    designationId: optionalId,
    departmentId: optionalId,
    teamId: optionalId,
    locationId: optionalId,
    managerId: optionalId,
    secondaryManagerId: optionalId,
    employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
    status: z.enum(EMPLOYEE_STATUSES).default('ACTIVE'),
    /**
     * Nullish rather than defaulted. A record nobody has classified stays
     * unclassified - defaulting it here would write "Probation" onto every
     * employee the first time anybody saved an unrelated field.
     *
     * `z.enum` is the whole of the validation: an arbitrary string is rejected
     * by the schema before any route sees it, and the column is an enum too, so
     * there is no path by which a free-text value reaches the database.
     */
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).nullish(),
    hireDate: optionalDate,
    confirmationDate: optionalDate,
    // When the next increment falls due, not when the last one happened. The
    // latter is a SalaryRevision; this is a date somebody has to act on.
    nextIncrementDueDate: optionalDate,
    terminationDate: optionalDate,
    resignationDate: optionalDate,
    sourceOfHire: optionalText(120),
    linkedinUrl: optionalText(300),
    priorExperienceMonths: z.coerce.number().int().min(0).max(1200).nullish(),
    /**
     * Somebody who never punches - a partner, a director.
     *
     * Defaulted false rather than nullish: "nobody has said" and "counted
     * normally" are the same answer here, and a tri-state would only invite a
     * screen to render a third thing. It is a job fact rather than a status:
     * the person stays ACTIVE everywhere else, and only attendance stops
     * asking about them.
     */
    excludedFromAttendance: z.boolean().default(false),

    // personal
    dateOfBirth: optionalDate,
    gender: z.enum(GENDERS).nullish(),
    maritalStatus: z.enum(MARITAL_STATUSES).nullish(),
    nationality: optionalText(120),
    bloodGroup: optionalText(8),
    presentAddress: optionalText(500),
    permanentAddress: optionalText(500),
    emergencyContactName: optionalText(160),
    emergencyContactPhone: optionalText(40),
    emergencyContactRelationship: optionalText(80),

    // restricted - requires employee.sensitive.read to see, .manage to write
    nationalId: optionalText(64),
    passportNumber: optionalText(64),
    passportExpiry: optionalDate,
    visaNumber: optionalText(64),
    visaExpiry: optionalDate,
    bankAccountNumber: optionalText(64),

    notes: optionalText(2000),
  });

/** Creating an employee: first and last name are genuinely required. */
export const employeeInputSchema = employeeBaseSchema
  .refine(
    (v) => v.status !== 'TERMINATED' || v.terminationDate !== null,
    { message: 'A termination date is required when the status is Terminated.', path: ['terminationDate'] },
  )
  .refine((v) => v.status !== 'RESIGNED' || v.resignationDate !== null, {
    message: 'A resignation date is required when the status is Resigned.',
    path: ['resignationDate'],
  })
  .refine(
    (v) =>
      v.hireDate === null ||
      v.resignationDate === null ||
      Date.parse(v.resignationDate) >= Date.parse(v.hireDate),
    { message: 'A resignation cannot be before the hire date.', path: ['resignationDate'] },
  )
  .refine(
    (v) =>
      v.hireDate === null ||
      v.terminationDate === null ||
      Date.parse(v.terminationDate) >= Date.parse(v.hireDate),
    { message: 'Termination cannot be before the hire date.', path: ['terminationDate'] },
  )
  .refine((v) => v.managerId === null || v.managerId !== v.secondaryManagerId, {
    message: 'Secondary manager must be different from the primary manager.',
    path: ['secondaryManagerId'],
  })
  /**
   * Confirming somebody means saying when.
   *
   * PERMANENT and a confirmation date are one fact recorded in two columns, and
   * a record carrying the first without the second cannot answer "since when",
   * which is the question every later dispute turns on. The same rule is
   * re-checked against the stored row on update, where the date may already be
   * on the record.
   */
  .refine((v) => v.employmentStatus !== 'PERMANENT' || v.confirmationDate !== null, {
    message: 'A confirmation date is required when the employment status is Permanent.',
    path: ['confirmationDate'],
  });

/**
 * Updating an employee.
 *
 * Every field optional, because PATCH means "change these fields" - it is not
 * a whole-record replace. Sending `{ managerId }` alone used to fail asking for
 * firstName and lastName, which forced every caller to read the record, merge,
 * and send it all back: three round trips to set one field, and a lost update
 * whenever two of them overlapped.
 *
 * The cross-field rules below therefore fire only when the payload actually
 * carries the fields they compare. A rule cannot judge a field that is not
 * being changed, and the route still merges against the stored row.
 */
export const employeeUpdateSchema = employeeBaseSchema
  .partial()
  .refine(
    (v) => v.status !== 'TERMINATED' || (v.terminationDate !== null && v.terminationDate !== undefined),
    {
      message: 'A termination date is required when the status is Terminated.',
      path: ['terminationDate'],
    },
  )
  /**
   * Same rule for a resignation, and the same reason it is conditional: a
   * PATCH that only moves someone's team cannot be judged on a status it is
   * not sending. The route merges against the stored row and re-checks there.
   */
  .refine(
    (v) => v.status !== 'RESIGNED' || (v.resignationDate !== null && v.resignationDate !== undefined),
    {
      message: 'A resignation date is required when the status is Resigned.',
      path: ['resignationDate'],
    },
  )
  .refine(
    (v) =>
      v.hireDate === undefined ||
      v.resignationDate === undefined ||
      v.hireDate === null ||
      v.resignationDate === null ||
      Date.parse(v.resignationDate) >= Date.parse(v.hireDate),
    { message: 'A resignation cannot be before the hire date.', path: ['resignationDate'] },
  )
  .refine(
    (v) =>
      v.hireDate === undefined ||
      v.terminationDate === undefined ||
      v.hireDate === null ||
      v.terminationDate === null ||
      Date.parse(v.terminationDate) >= Date.parse(v.hireDate),
    { message: 'Termination cannot be before the hire date.', path: ['terminationDate'] },
  )
  .refine(
    (v) =>
      v.managerId === undefined ||
      v.secondaryManagerId === undefined ||
      v.managerId === null ||
      v.managerId !== v.secondaryManagerId,
    {
      message: 'Secondary manager must be different from the primary manager.',
      path: ['secondaryManagerId'],
    },
  )
  /**
   * Confirming somebody means saying when - conditional, for the same reason
   * the resignation rule above is.
   *
   * This can only catch a payload that nulls the date while setting PERMANENT.
   * A PATCH that sets PERMANENT alone is legitimate when the record already
   * carries a confirmation date, and the route merges against the stored row to
   * decide - which is also what lets HR send the status and the date in one
   * call, or in either order.
   */
  .refine((v) => v.employmentStatus !== 'PERMANENT' || v.confirmationDate !== null, {
    message: 'A confirmation date is required when the employment status is Permanent.',
    path: ['confirmationDate'],
  });

export type EmployeeInput = z.infer<typeof employeeInputSchema>;
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

export const EMPLOYEE_SORT_FIELDS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'hireDate',
  'status',
  'employmentStatus',
  'createdAt',
] as const;

export const employeeQuerySchema = paginationQuerySchema.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  /** Omitted means every status, including the unclassified. */
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  designationId: z.string().trim().max(64).optional(),
  locationId: z.string().trim().max(64).optional(),
  managerId: z.string().trim().max(64).optional(),
});

export type EmployeeQuery = z.infer<typeof employeeQuerySchema>;

export const workExperienceInputSchema = z.object({
  companyName: z.string().trim().min(1, 'Company name is required.').max(160),
  jobTitle: optionalText(120),
  fromDate: optionalDate,
  toDate: optionalDate,
  description: optionalText(500),
});

export type WorkExperienceInput = z.infer<typeof workExperienceInputSchema>;

/**
 * A qualification, as the Education panel writes one.
 *
 * `level` is free text rather than an enum for the same reason the column is:
 * qualification systems differ by country, and a fixed list would make the
 * roster import discard anything it did not anticipate.
 */
export const educationInputSchema = z.object({
  level: z.string().trim().min(1, 'Give the qualification a level.').max(80),
  degree: optionalText(160),
  institution: optionalText(200),
  yearCompleted: z.coerce
    .number()
    .int()
    .min(1900, 'That year is too early.')
    .max(2100, 'That year is too late.')
    .nullish(),
});

export type EducationInput = z.infer<typeof educationInputSchema>;

export const terminateEmployeeSchema = z.object({
  terminationDate: z.string().trim().min(1, 'Choose a termination date.'),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Recording a resignation.
 *
 * Two dates, because they are two different facts: the day notice was given,
 * and the last day actually worked. Payroll and attendance both read the last
 * working day; only the paperwork cares about the other one. The last working
 * day defaults to the resignation date when the employee left immediately.
 */
export const resignEmployeeSchema = z
  .object({
    resignationDate: z.string().trim().min(1, 'Choose the date the resignation was given.'),
    lastWorkingDate: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v === '' || v === undefined ? null : v)),
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => v.lastWorkingDate === null || Date.parse(v.lastWorkingDate) >= Date.parse(v.resignationDate),
    { message: 'The last working day cannot be before the resignation date.', path: ['lastWorkingDate'] },
  );

export type ResignEmployeeInput = z.infer<typeof resignEmployeeSchema>;

// ------------------------------------------------------------- read shapes

export interface EmployeeListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  fullName: string;
  workEmail: string | null;
  phone: string | null;
  jobTitle: string | null;
  /**
   * What to render in the avatar, or null for initials.
   *
   * Either the API path an uploaded photo is served from, or - when there is no
   * upload - whatever link was typed into the record's Photo URL field. The
   * upload wins; see `resolvePhotoUrl` on the API side, which is the only place
   * that decides between the two.
   */
  photoUrl: string | null;
  /** True when `photoUrl` points at an uploaded photo rather than a typed link. */
  hasPhoto: boolean;
  status: EmployeeStatus;
  employmentType: EmploymentType;
  /** Null when nobody has classified the record. Never a free-text value. */
  employmentStatus: EmploymentStatus | null;
  hireDate: string | null;
  designation: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  manager: { id: string; fullName: string } | null;
  hasLogin: boolean;
}

export interface EmployeeEducationRecord {
  id: string;
  /** "Bachelors", "Masters" and so on - free text, as the source records it. */
  level: string;
  degree: string | null;
  institution: string | null;
  /** Year only. The rosters this comes from do not record a full date. */
  yearCompleted: number | null;
}

export interface EmployeeWorkExperienceRecord {
  id: string;
  companyName: string;
  jobTitle: string | null;
  fromDate: string | null;
  toDate: string | null;
  description: string | null;
}

/**
 * Full record. The restricted block is present only when the caller holds
 * `employee.sensitive.read`; otherwise the API omits it entirely rather than
 * sending nulls, so the UI can tell "hidden" apart from "not set".
 */
export interface EmployeeDetail extends EmployeeListItem {
  middleName: string | null;
  displayName: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  secondaryManager: { id: string; fullName: string } | null;
  confirmationDate: string | null;
  nextIncrementDueDate: string | null;
  terminationDate: string | null;
  resignationDate: string | null;
  sourceOfHire: string | null;
  linkedinUrl: string | null;
  priorExperienceMonths: number | null;
  /**
   * True for somebody who never punches. They stay ACTIVE and appear
   * everywhere else; attendance simply stops asking about them.
   */
  excludedFromAttendance: boolean;
  dateOfBirth: string | null;
  gender: string | null;
  maritalStatus: string | null;
  nationality: string | null;
  bloodGroup: string | null;
  presentAddress: string | null;
  permanentAddress: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelationship: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  workExperience: EmployeeWorkExperienceRecord[];
  education: EmployeeEducationRecord[];
  directReports: Array<{
    id: string;
    fullName: string;
    jobTitle: string | null;
    photoUrl: string | null;
  }>;
  restricted?: {
    nationalId: string | null;
    passportNumber: string | null;
    passportExpiry: string | null;
    visaNumber: string | null;
    visaExpiry: string | null;
    bankAccountNumber: string | null;
  };
}

/**
 * The headline strip on the Employee 360 profile.
 *
 * One request behind the summary cards, so opening a profile does not fan out
 * into five calls that each have to survive their own permission failure. Every
 * block is OPTIONAL and is omitted - never nulled or zeroed - when the caller
 * lacks the permission that block's own module requires. A zero would read as
 * "no loans"; an absent key reads as "not yours to see", which is the truth.
 *
 * Nothing here is calculated by this endpoint. Attendance comes from the
 * central attendance engine, leave from the same balance service the leave
 * screens use, loans from the loan schedule, salary from the salary records.
 * The summary is a projection of those, never a second opinion about them.
 */
export interface EmployeeProfileSummary {
  employeeId: string;

  /**
   * Device PINs currently mapped to this employee, for display only.
   *
   * A list because one person may punch on several terminals under different
   * PINs. Needs `device.read`, which is what the mapping module itself needs;
   * without it the key is absent.
   */
  punchCodes?: string[];

  /** The month the attendance block covers, as yyyy-MM. */
  attendance?: {
    month: string;
    present: number;
    halfDay: number;
    absent: number;
    onLeave: number;
    late: number;
    earlyLeave: number;
    missingPunch: number;
    irregular: number;
    workedMinutes: number;
    expectedMinutes: number;
    overtimeMinutes: number;
    attendancePercentage: number | null;
  };

  /** Totalled across every active leave type for the year. */
  leave?: {
    year: number;
    /** Paid types only - unpaid leave is not leave anybody has. */
    entitlementDays: number;
    /** Approved leave requests. Excludes history imported as a balance debit. */
    usedDays: number;
    /** Days an administrator debited from the balance, e.g. imported history. */
    adjustedDays: number;
    /** Everything spent, however recorded: `usedDays` + `adjustedDays`. */
    consumedDays: number;
    pendingDays: number;
    availableDays: number;
  };

  loans?: {
    activeCount: number;
    /** Still to be repaid across active loans. */
    outstandingAmount: number;
    /** What payroll will collect next month across those loans. */
    monthlyDeduction: number;
    currency: string;
  };

  salary?: {
    amount: number;
    currency: string;
    effectiveFrom: string | null;
    nextIncrementDueDate: string | null;
  };
}

export interface EmployeeTreeNode {
  id: string;
  fullName: string;
  employeeNumber: string;
  jobTitle: string | null;
  departmentName: string | null;
  photoUrl: string | null;
  status: EmployeeStatus;
  reports: EmployeeTreeNode[];
}
