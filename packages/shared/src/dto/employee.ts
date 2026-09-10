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
  );

export type EmployeeInput = z.infer<typeof employeeInputSchema>;
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

export const EMPLOYEE_SORT_FIELDS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'hireDate',
  'status',
  'createdAt',
] as const;

export const employeeQuerySchema = paginationQuerySchema.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
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
  photoUrl: string | null;
  status: EmployeeStatus;
  employmentType: EmploymentType;
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
  directReports: Array<{ id: string; fullName: string; jobTitle: string | null }>;
  restricted?: {
    nationalId: string | null;
    passportNumber: string | null;
    passportExpiry: string | null;
    visaNumber: string | null;
    visaExpiry: string | null;
    bankAccountNumber: string | null;
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
