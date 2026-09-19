import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { vi } from 'vitest';
import { PERMISSIONS, type DataScope, type Permission } from '@hrms/shared';

/**
 * Shared scaffolding for the recruitment tests.
 *
 * Two things live here: the cast of people every test needs, and the one
 * function that mounts a plugin behind a chosen set of grants. Both exist
 * because the interesting claims in this module are almost all claims about
 * WHO CAN SEE WHAT, and a test of that has to be able to say "the same request,
 * from somebody holding these permissions" without twenty lines of setup each
 * time.
 *
 * The grant sets below are the roles as `DEFAULT_ROLE_PERMISSIONS` actually
 * defines them, restated here on purpose rather than imported: a test that read
 * the same constant the code reads would still pass if somebody handed the
 * Interviewer role `candidate.manage` tomorrow, which is precisely the change
 * that must fail loudly.
 */

export const COMPANY = 'company-1';
export const OTHER_COMPANY = 'company-2';
export const TIMEZONE = 'Asia/Karachi';

/** HR: runs recruitment, sees everything, and can convert a hire. */
export const HR: Permission[] = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.CANDIDATE_READ,
  PERMISSIONS.CANDIDATE_MANAGE,
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_MANAGE,
  PERMISSIONS.INTERVIEW_EVALUATE,
  PERMISSIONS.RECRUITMENT_OFFER_MANAGE,
  PERMISSIONS.RECRUITMENT_CONVERT_EMPLOYEE,
];

/**
 * A hiring manager: reads recruitment and interviews, manages neither.
 *
 * Note what is absent - `candidate.read`. A manager interviewing somebody is
 * shown that person through the INTERVIEW, and cannot open the candidate list.
 */
export const MANAGER: Permission[] = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_EVALUATE,
];

/** The Interviewer role, entire. Two grants and nothing else. */
export const INTERVIEWER: Permission[] = [
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_EVALUATE,
];

/**
 * Everything an ordinary member of staff holds, including every EMPLOYEE grant.
 *
 * Deliberately generous: the point of this set is that it contains the widest
 * employee-facing permissions in the product and still opens nothing in
 * recruitment. `employee.read` must never reach a candidate.
 */
export const EMPLOYEE: Permission[] = [
  PERMISSIONS.EMPLOYEE_READ,
  PERMISSIONS.EMPLOYEE_MANAGE,
  PERMISSIONS.EMPLOYEE_SENSITIVE_READ,
  PERMISSIONS.LEAVE_READ,
  PERMISSIONS.ATTENDANCE_READ,
  PERMISSIONS.PAYROLL_READ,
  PERMISSIONS.AUDIT_READ,
];

export interface Person {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
}

export const HR_USER: Person = {
  id: 'emp-hr',
  userId: 'user-hr',
  firstName: 'Sana',
  lastName: 'Iqbal',
  workEmail: 'sana@example.com',
};

export const AHMED: Person = {
  id: 'emp-ahmed',
  userId: 'user-ahmed',
  firstName: 'Ahmed',
  lastName: 'Khan',
  workEmail: 'ahmed@example.com',
};

export const ZOHAIB: Person = {
  id: 'emp-zohaib',
  userId: 'user-zohaib',
  firstName: 'Muhammad',
  lastName: 'Zohaib',
  workEmail: 'zohaib@example.com',
};

/** A panellist with no login account, so notification has nowhere to go. */
export const NO_LOGIN: Person = {
  id: 'emp-nologin',
  userId: '',
  firstName: 'Bilal',
  lastName: 'Aslam',
  workEmail: null,
};

export const PEOPLE: Person[] = [HR_USER, AHMED, ZOHAIB, NO_LOGIN];

export function personByUser(userId: string): Person | undefined {
  return PEOPLE.find((person) => person.userId === userId);
}

/**
 * Mounts one plugin behind a chosen session.
 *
 * The auth context is written directly rather than going through the real
 * session resolver, which is what lets a test ask "what does this endpoint do
 * for somebody holding exactly these two grants" - the question the whole
 * module's design turns on.
 *
 * `dataScope` defaults to ALL deliberately, and that is itself an assertion:
 * recruitment is narrowed by NAMED INVOLVEMENT rather than by data scope, so a
 * caller with the widest possible scope and the narrow grants must still see
 * only their own openings and their own interviews. A test that handed narrow
 * callers a narrow scope would prove nothing about which of the two is doing
 * the work.
 */
export async function appAs(
  plugin: FastifyPluginAsync,
  options: {
    prefix: string;
    permissions?: Permission[];
    userId?: string;
    companyId?: string;
    dataScope?: DataScope;
  },
): Promise<FastifyInstance> {
  const { registerErrorHandler } = await import('../../core/error-handler.js');

  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: options.userId ?? HR_USER.userId,
      companyId: options.companyId ?? COMPANY,
      email: 'someone@example.com',
      permissions: new Set(options.permissions ?? HR),
      dataScope: options.dataScope ?? 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(plugin, { prefix: options.prefix });
  await app.ready();
  return app;
}

/**
 * The slice of Prisma the recruitment module touches.
 *
 * Hoisted so `vi.mock` can close over it, in the style the lunch and cases
 * tests already use. Every method is a bare `vi.fn`: each test wires up only
 * the calls its own route makes, which keeps a test readable as a statement
 * about one endpoint rather than as a database fixture.
 */
export function recruitmentDb() {
  return {
    company: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    /*
     * The lookup tables the write paths prove ids against before they write.
     * Bare `vi.fn()`s like everything else: a test that does not wire them is
     * a test whose route never asked, which is itself worth knowing.
     */
    department: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    location: { findFirst: vi.fn() },
    designation: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    employee: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    jobOpening: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
    },
    candidate: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    candidateApplication: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
    candidateDocument: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    interview: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    interviewParticipant: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    interviewEvaluation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    interviewScheduleChange: { findMany: vi.fn(), create: vi.fn() },
    offer: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    notification: { create: vi.fn() },
    /**
     * Runs the callback against the same mock, which models the only property
     * of a transaction these tests care about: that the writes inside one are
     * the writes that happen. Atomicity is the database's job and is asserted
     * by the migration, not here.
     */
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(recruitmentDbRef)),
  };
}

/**
 * The live mock, so `$transaction` can hand itself back.
 *
 * Set by `useRecruitmentDb` in each test file's `beforeEach`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recruitmentDbRef: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useRecruitmentDb(db: any): void {
  recruitmentDbRef = db;
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
}

/**
 * Wires the two lookups EVERY route in this module performs before it does
 * anything interesting: the caller's own employee row, and the company.
 *
 * `resolveActor` runs on every request - it is what turns a session into "this
 * person's employee id" - and `companyTimezone` runs on everything that says
 * "today". Wiring them by hand in sixty tests would bury the one line each test
 * is actually about, so they are wired once from the cast in `PEOPLE`.
 *
 * Note what this does NOT do: it does not decide who may see what. Every
 * employee lookup here answers truthfully for anybody in the cast, so a test
 * that ends in "and they saw nothing" got that answer from the route's own
 * filter rather than from a lookup that quietly failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wirePeople(db: any): void {
  const company = {
    id: COMPANY,
    timezone: TIMEZONE,
    employeeNumberPrefix: 'EMP-',
  };
  db.company.findUnique.mockResolvedValue(company);
  db.company.findUniqueOrThrow.mockResolvedValue(company);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.employee.findFirst.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (typeof where.userId === 'string') {
      const person = personByUser(where.userId);
      return person ? { id: person.id } : null;
    }
    if (typeof where.id === 'string') {
      const person = PEOPLE.find((candidate) => candidate.id === where.id);
      return person ? { id: person.id } : null;
    }
    return null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.employee.findMany.mockImplementation(async (args: any) => {
    const ids: string[] = args?.where?.id?.in ?? [];
    return PEOPLE.filter((person) => ids.includes(person.id)).map((person) => ({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      userId: person.userId === '' ? null : person.userId,
      workEmail: person.workEmail,
    }));
  });
}

/** The audit actions recorded during one test, in order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function auditActions(db: any): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db.auditLog.create.mock.calls.map((call: any[]) => call[0].data.action as string);
}


// ------------------------------------------------------------------ fixtures

/**
 * Rows as Prisma would hand them back, with the includes the service asks for.
 *
 * Written as builders with overrides rather than as constants because every
 * interesting test differs from the last by one field - a status, a stage, a
 * panel - and a fixture that has to be deep-copied by hand is a fixture that
 * gets mutated by the test before it.
 *
 * Dates are `Date` objects and not strings, because that is what Prisma
 * returns and because `toInterviewRecord` calls `.toISOString()` on them: a
 * string fixture would pass a test that the real route would crash on.
 */

export const NOW = new Date('2026-09-18T05:00:00.000Z');

type Overrides = Record<string, unknown>;

export function jobOpeningRow(overrides: Overrides = {}) {
  return {
    id: 'job-1',
    companyId: COMPANY,
    reference: 'JOB-0001',
    title: 'Senior Unity Developer',
    departmentId: 'dept-dev',
    teamId: null,
    locationId: null,
    employmentType: 'FULL_TIME',
    expectedEmploymentStatus: null,
    vacancies: 2,
    hiringManagerId: AHMED.id,
    recruiterId: HR_USER.id,
    description: null,
    requirements: null,
    skills: 'Unity, C#',
    minExperienceYears: 3,
    salaryMin: 250000,
    salaryMax: 400000,
    salaryCurrency: 'PKR',
    openingDate: new Date('2026-09-01T00:00:00.000Z'),
    closingDate: null,
    status: 'OPEN',
    closedAt: null,
    closedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    department: { id: 'dept-dev', name: 'Development' },
    team: null,
    location: null,
    hiringManager: { id: AHMED.id, firstName: AHMED.firstName, lastName: AHMED.lastName },
    recruiter: { id: HR_USER.id, firstName: HR_USER.firstName, lastName: HR_USER.lastName },
    _count: { applications: 3 },
    ...overrides,
  };
}

export function applicationRow(overrides: Overrides = {}) {
  return {
    id: 'app-1',
    companyId: COMPANY,
    candidateId: 'cand-1',
    jobOpeningId: 'job-1',
    stage: 'INTERVIEW',
    stageChangedAt: NOW,
    stageChangedBy: HR_USER.userId,
    outcomeReason: null,
    appliedAt: NOW,
    jobOpening: {
      id: 'job-1',
      title: 'Senior Unity Developer',
      reference: 'JOB-0001',
      department: { name: 'Development' },
    },
    ...overrides,
  };
}

export function candidateRow(overrides: Overrides = {}) {
  const applications = (overrides.applications as unknown[]) ?? [applicationRow()];
  return {
    id: 'cand-1',
    companyId: COMPANY,
    reference: 'CAN-0001',
    fullName: 'Muhammad Ali',
    email: 'muhammad.ali@example.com',
    phone: '+92 300 1234567',
    currentLocation: 'Lahore',
    linkedinUrl: null,
    portfolioUrl: null,
    skills: 'Unity, C#',
    experienceYears: 5,
    currentCompany: 'Another Studio',
    currentTitle: 'Unity Developer',
    currentSalary: 300000,
    expectedSalary: 450000,
    salaryCurrency: 'PKR',
    noticePeriodDays: 30,
    source: 'Referral',
    notes: 'Strong portfolio. Asking above band.',
    recruiterId: HR_USER.id,
    stage: 'INTERVIEW',
    hiredEmployeeId: null,
    hiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    recruiter: { id: HR_USER.id, firstName: HR_USER.firstName, lastName: HR_USER.lastName },
    _count: { documents: 2, interviews: 1 },
    ...overrides,
    applications,
  };
}

export function participantRow(person: Person, overrides: Overrides = {}) {
  return {
    id: `part-${person.id}`,
    companyId: COMPANY,
    interviewId: 'int-1',
    employeeId: person.id,
    isLead: false,
    confirmedAt: null,
    createdAt: NOW,
    employee: {
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      jobTitle: 'Engineer',
      designation: null,
    },
    evaluation: null,
    ...overrides,
  };
}

export function interviewRow(overrides: Overrides = {}) {
  const participants = (overrides.participants as unknown[]) ?? [participantRow(AHMED)];
  return {
    id: 'int-1',
    companyId: COMPANY,
    candidateId: 'cand-1',
    jobOpeningId: 'job-1',
    applicationId: 'app-1',
    type: 'TECHNICAL',
    round: 'ROUND_1',
    // 10:00 to 11:00 in Karachi, which is 05:00 to 06:00 UTC.
    startsAt: new Date('2026-09-18T05:00:00.000Z'),
    endsAt: new Date('2026-09-18T06:00:00.000Z'),
    timezone: TIMEZONE,
    location: 'Meeting room 2',
    meetingLink: null,
    notes: null,
    status: 'SCHEDULED',
    completedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    candidate: { id: 'cand-1', fullName: 'Muhammad Ali', reference: 'CAN-0001' },
    jobOpening: {
      id: 'job-1',
      title: 'Senior Unity Developer',
      department: { name: 'Development' },
    },
    ...overrides,
    participants,
  };
}

export function evaluationRow(person: Person, overrides: Overrides = {}) {
  return {
    id: `eval-${person.id}`,
    companyId: COMPANY,
    interviewId: 'int-1',
    participantId: `part-${person.id}`,
    technicalScore: 8,
    problemSolvingScore: 7,
    communicationScore: null,
    experienceScore: 8,
    cultureFitScore: 9,
    recommendation: 'YES',
    comments: 'Solid on gameplay code.',
    submittedAt: NOW,
    participant: {
      id: `part-${person.id}`,
      employeeId: person.id,
      employee: { id: person.id, firstName: person.firstName, lastName: person.lastName },
    },
    ...overrides,
  };
}

export function offerRow(overrides: Overrides = {}) {
  return {
    id: 'offer-1',
    companyId: COMPANY,
    candidateId: 'cand-1',
    jobOpeningId: 'job-1',
    applicationId: 'app-1',
    designationId: null,
    proposedTitle: 'Senior Unity Developer',
    employmentType: 'FULL_TIME',
    employmentStatus: 'PROBATION',
    proposedSalary: 380000,
    salaryCurrency: 'PKR',
    expectedJoiningDate: new Date('2026-10-01T00:00:00.000Z'),
    status: 'DRAFT',
    sentAt: null,
    respondedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    candidate: { id: 'cand-1', fullName: 'Muhammad Ali' },
    jobOpening: { id: 'job-1', title: 'Senior Unity Developer' },
    designation: null,
    ...overrides,
  };
}

export function documentRow(overrides: Overrides = {}) {
  return {
    id: 'doc-1',
    companyId: COMPANY,
    candidateId: 'cand-1',
    type: 'RESUME',
    fileName: 'muhammad-ali-cv.pdf',
    contentType: 'application/pdf',
    sizeBytes: 250_000,
    objectKey: 'candidates/cand-1/doc-1',
    isConfidential: false,
    uploadedById: HR_USER.id,
    createdAt: NOW,
    uploadedBy: { firstName: HR_USER.firstName, lastName: HR_USER.lastName },
    ...overrides,
  };
}
