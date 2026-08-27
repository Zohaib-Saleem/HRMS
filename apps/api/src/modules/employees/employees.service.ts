import type { Prisma } from '@prisma/client';
import type {
  EmployeeDetail,
  EmployeeListItem,
  EmployeeStatus,
  EmploymentType,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ValidationError } from '../../core/errors.js';

export const LIST_INCLUDE = {
  designation: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
  user: { select: { id: true } },
} satisfies Prisma.EmployeeInclude;

export const DETAIL_INCLUDE = {
  ...LIST_INCLUDE,
  secondaryManager: { select: { id: true, firstName: true, lastName: true } },
  workExperience: { orderBy: { fromDate: 'desc' } },
  reports: {
    where: { status: { not: 'TERMINATED' } },
    orderBy: [{ firstName: 'asc' }],
    select: { id: true, firstName: true, lastName: true, jobTitle: true },
  },
} satisfies Prisma.EmployeeInclude;

type ListRow = Prisma.EmployeeGetPayload<{ include: typeof LIST_INCLUDE }>;
type DetailRow = Prisma.EmployeeGetPayload<{ include: typeof DETAIL_INCLUDE }>;

const fullName = (first: string, last: string) => `${first} ${last}`.trim();
const isoDate = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export function toListItem(row: ListRow): EmployeeListItem {
  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: row.displayName ?? fullName(row.firstName, row.lastName),
    workEmail: row.workEmail,
    phone: row.phone,
    jobTitle: row.designation?.name ?? row.jobTitle,
    photoUrl: row.photoUrl,
    status: row.status as EmployeeStatus,
    employmentType: row.employmentType as EmploymentType,
    hireDate: isoDate(row.hireDate),
    designation: row.designation,
    department: row.department,
    team: row.team,
    location: row.location,
    manager: row.manager
      ? { id: row.manager.id, fullName: fullName(row.manager.firstName, row.manager.lastName) }
      : null,
    hasLogin: row.user !== null,
  };
}

/**
 * Builds the detail payload.
 *
 * The restricted block is attached only when `includeRestricted` is true. It is
 * omitted entirely rather than nulled, so the client can distinguish "you may
 * not see this" from "this is not set" and render accordingly.
 */
export function toDetail(row: DetailRow, includeRestricted: boolean): EmployeeDetail {
  const detail: EmployeeDetail = {
    ...toListItem(row),
    middleName: row.middleName,
    displayName: row.displayName,
    personalEmail: row.personalEmail,
    personalPhone: row.personalPhone,
    secondaryManager: row.secondaryManager
      ? {
          id: row.secondaryManager.id,
          fullName: fullName(row.secondaryManager.firstName, row.secondaryManager.lastName),
        }
      : null,
    confirmationDate: isoDate(row.confirmationDate),
    terminationDate: isoDate(row.terminationDate),
    sourceOfHire: row.sourceOfHire,
    linkedinUrl: row.linkedinUrl,
    priorExperienceMonths: row.priorExperienceMonths,
    dateOfBirth: isoDate(row.dateOfBirth),
    gender: row.gender,
    maritalStatus: row.maritalStatus,
    nationality: row.nationality,
    bloodGroup: row.bloodGroup,
    presentAddress: row.presentAddress,
    permanentAddress: row.permanentAddress,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    emergencyContactRelationship: row.emergencyContactRelationship,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workExperience: row.workExperience.map((w) => ({
      id: w.id,
      companyName: w.companyName,
      jobTitle: w.jobTitle,
      fromDate: isoDate(w.fromDate),
      toDate: isoDate(w.toDate),
      description: w.description,
    })),
    directReports: row.reports.map((r) => ({
      id: r.id,
      fullName: fullName(r.firstName, r.lastName),
      jobTitle: r.jobTitle,
    })),
  };

  if (includeRestricted) {
    detail.restricted = {
      nationalId: row.nationalId,
      passportNumber: row.passportNumber,
      passportExpiry: isoDate(row.passportExpiry),
      visaNumber: row.visaNumber,
      visaExpiry: isoDate(row.visaExpiry),
      bankAccountNumber: row.bankAccountNumber,
    };
  }

  return detail;
}

/**
 * Next employee number, e.g. EMP-0007.
 *
 * Derives the sequence from existing numbers sharing the company prefix rather
 * than from row count, so deleting a record cannot cause a collision. The
 * unique constraint on (companyId, employeeNumber) is the real guarantee.
 */
export async function nextEmployeeNumber(companyId: string): Promise<string> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { employeeNumberPrefix: true },
  });
  const prefix = company.employeeNumberPrefix;

  const existing = await prisma.employee.findMany({
    where: { companyId, employeeNumber: { startsWith: prefix } },
    select: { employeeNumber: true },
  });

  let highest = 0;
  for (const { employeeNumber } of existing) {
    const suffix = employeeNumber.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    highest = Math.max(highest, Number.parseInt(suffix, 10));
  }

  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

/**
 * Validates every foreign key on the employee form in one pass, so the user
 * gets all the bad references at once instead of one 500 per attempt.
 */
export async function assertReferencesExist(
  companyId: string,
  input: {
    departmentId?: string | null;
    teamId?: string | null;
    designationId?: string | null;
    locationId?: string | null;
    managerId?: string | null;
    secondaryManagerId?: string | null;
  },
  selfId?: string,
): Promise<void> {
  const details: Record<string, string[]> = {};

  const [department, team, designation, location, manager, secondary] = await Promise.all([
    input.departmentId
      ? prisma.department.findFirst({ where: { id: input.departmentId, companyId }, select: { id: true } })
      : null,
    input.teamId
      ? prisma.team.findFirst({
          where: { id: input.teamId, companyId },
          select: { id: true, departmentId: true },
        })
      : null,
    input.designationId
      ? prisma.designation.findFirst({ where: { id: input.designationId, companyId }, select: { id: true } })
      : null,
    input.locationId
      ? prisma.location.findFirst({ where: { id: input.locationId, companyId }, select: { id: true } })
      : null,
    input.managerId
      ? prisma.employee.findFirst({ where: { id: input.managerId, companyId }, select: { id: true } })
      : null,
    input.secondaryManagerId
      ? prisma.employee.findFirst({ where: { id: input.secondaryManagerId, companyId }, select: { id: true } })
      : null,
  ]);

  if (input.departmentId && !department) details.departmentId = ['That department does not exist.'];
  if (input.teamId && !team) details.teamId = ['That team does not exist.'];
  if (input.designationId && !designation) details.designationId = ['That designation does not exist.'];
  if (input.locationId && !location) details.locationId = ['That location does not exist.'];
  if (input.managerId && !manager) details.managerId = ['That employee does not exist.'];
  if (input.secondaryManagerId && !secondary) {
    details.secondaryManagerId = ['That employee does not exist.'];
  }

  // A team belongs to exactly one department; allowing a mismatch would make
  // department-scoped queries disagree with the org chart.
  if (team && input.departmentId && team.departmentId !== input.departmentId) {
    details.teamId = ['That team belongs to a different department.'];
  }
  if (team && !input.departmentId) {
    details.teamId = ['Choose the team’s department as well.'];
  }

  if (selfId) {
    if (input.managerId === selfId) details.managerId = ['An employee cannot report to themselves.'];
    if (input.secondaryManagerId === selfId) {
      details.secondaryManagerId = ['An employee cannot report to themselves.'];
    }
  }

  if (Object.keys(details).length > 0) throw new ValidationError(details);
}

/**
 * Rejects a manager assignment that would close a loop in the reporting line.
 * Same reasoning as the department hierarchy: the tree endpoints would recurse
 * forever otherwise.
 */
export async function assertNoReportingCycle(
  companyId: string,
  employeeId: string,
  managerId: string,
): Promise<void> {
  let cursor: string | null = managerId;
  const seen = new Set<string>();

  while (cursor) {
    if (cursor === employeeId) {
      throw new ValidationError({
        managerId: ['That would create a loop in the reporting line.'],
      });
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);

    const next: { managerId: string | null } | null = await prisma.employee.findFirst({
      where: { id: cursor, companyId },
      select: { managerId: true },
    });
    cursor = next?.managerId ?? null;
  }
}

/** Converts validated form input into Prisma data, parsing date strings. */
export function toPrismaData(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const dateFields = [
    'hireDate',
    'confirmationDate',
    'terminationDate',
    'dateOfBirth',
    'passportExpiry',
    'visaExpiry',
  ];

  const data: Record<string, unknown> = { ...input };
  for (const field of dateFields) {
    const value = data[field];
    data[field] = typeof value === 'string' && value !== '' ? new Date(value) : null;
  }
  return data;
}

/** Fields the caller may not write without `employee.sensitive.read`. */
export const RESTRICTED_FIELDS = [
  'nationalId',
  'passportNumber',
  'passportExpiry',
  'visaNumber',
  'visaExpiry',
  'bankAccountNumber',
] as const;

export function stripRestricted(data: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...data };
  for (const field of RESTRICTED_FIELDS) delete copy[field];
  return copy;
}
