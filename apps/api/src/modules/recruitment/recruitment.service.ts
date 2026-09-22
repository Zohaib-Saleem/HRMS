import type { Prisma } from '@prisma/client';
import {
  CANDIDATE_STAGE_RANK,
  PERMISSIONS,
  deriveCandidateStage,
  type CandidateStage,
  type CandidateApplicationRecord,
  type CandidateRecord,
  type EvaluationRecord,
  type InterviewRecord,
  type InterviewRound,
  type InterviewStatus,
  type InterviewType,
  type JobOpeningRecord,
  type JobOpeningStatus,
  type OfferRecord,
  type OfferStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { instantInZone, isValidTimeZone } from '../../core/zoned-time.js';

/**
 * Recruitment, the parts every route in the module shares.
 *
 * Two things live here and nothing else does: WHO CAN SEE WHAT, and how a row
 * becomes a response. Both are here rather than in the route files because both
 * are the sort of rule that must have exactly one copy - a second opinion about
 * which openings a manager may read is a hole, and a second mapper is how a
 * restricted field ends up stripped on the list and present on the detail.
 *
 * The access model in one paragraph. Recruitment has three READ grants that are
 * narrow on their own and three MANAGE grants that widen them:
 * `recruitment.read` alone returns the openings the caller is NAMED on;
 * `interview.read` alone returns the interviews the caller is ON;
 * `candidate.read` returns candidates but with the restricted block stripped,
 * which `candidate.manage` restores. None of this consults the DataScope, and
 * that is deliberate rather than an oversight - see `resolveRecruiter` below.
 */

/**
 * Who the caller is, in recruitment's terms.
 *
 * `employeeId` is the anchor for every narrowed query: a manager's openings are
 * the ones with their employee id in a column, an interviewer's interviews are
 * the ones with their employee id on a panel seat. A caller with no employee
 * record has no anchor, which is why the narrowed grants return nothing for one
 * - an administrator's login that was never linked to a person is not on
 * anybody's panel.
 */
export interface RecruitmentActor {
  auth: AuthContext;
  employeeId: string | null;
  /** Every opening and every candidate, not just the ones they are named on. */
  canManageRecruitment: boolean;
  canReadCandidates: boolean;
  /** Reads the restricted block: salary now, salary wanted, HR notes. */
  canManageCandidates: boolean;
  /** Every interview in the company, not just their own seats. */
  canManageInterviews: boolean;
  canEvaluate: boolean;
  canManageOffers: boolean;
  canConvert: boolean;
}

/**
 * Resolves the caller into a recruitment actor.
 *
 * Note what is NOT consulted: `auth.dataScope`. A data scope is granted for
 * line-management reasons - it says whose EMPLOYEE RECORDS somebody may read -
 * and a reporting line is not a reason to read the CVs of people who do not
 * work here. Recruitment is narrowed by NAMED INVOLVEMENT instead: you see the
 * opening you are hiring for and the interview you are sitting on. The two
 * questions are different and must be able to disagree, which is the same
 * reasoning the cases module applies to a helpdesk queue.
 */
export async function resolveActor(auth: AuthContext): Promise<RecruitmentActor> {
  const employee = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  return {
    auth,
    employeeId: employee?.id ?? null,
    canManageRecruitment: auth.permissions.has(PERMISSIONS.RECRUITMENT_MANAGE),
    canReadCandidates: auth.permissions.has(PERMISSIONS.CANDIDATE_READ),
    canManageCandidates: auth.permissions.has(PERMISSIONS.CANDIDATE_MANAGE),
    canManageInterviews: auth.permissions.has(PERMISSIONS.INTERVIEW_MANAGE),
    canEvaluate: auth.permissions.has(PERMISSIONS.INTERVIEW_EVALUATE),
    canManageOffers: auth.permissions.has(PERMISSIONS.RECRUITMENT_OFFER_MANAGE),
    canConvert: auth.permissions.has(PERMISSIONS.RECRUITMENT_CONVERT_EMPLOYEE),
  };
}

/**
 * The WHERE fragment narrowing job openings to what this caller may read.
 *
 * Returns `null` for "no rows", which callers must treat as no rows rather than
 * as no filter - the same contract `employeeScopeFilter` keeps, and the same
 * expensive mistake to make silently.
 */
export function jobOpeningFilter(actor: RecruitmentActor): Prisma.JobOpeningWhereInput | null {
  if (actor.canManageRecruitment) return {};
  if (!actor.employeeId) return null;
  return {
    OR: [{ hiringManagerId: actor.employeeId }, { recruiterId: actor.employeeId }],
  };
}

/**
 * The WHERE fragment narrowing interviews to what this caller may read.
 *
 * For a plain `interview.read` holder this is a clause on the PANEL - the
 * interview has a participant row with their employee id - so an interviewer
 * cannot browse the calendar, discover who else is being seen for a role, or
 * open an interview they were not invited to. It is a WHERE clause rather than
 * a filter applied afterwards, so an interview that is not theirs is absent
 * from the query rather than fetched and then withheld.
 */
export function interviewFilter(actor: RecruitmentActor): Prisma.InterviewWhereInput | null {
  if (actor.canManageInterviews) return {};
  if (!actor.employeeId) return null;
  return { participants: { some: { employeeId: actor.employeeId } } };
}

/** Fetches one job opening the caller may read, or 404s. */
export async function jobOpeningOrThrow(
  actor: RecruitmentActor,
  id: string,
): Promise<{ id: string; status: JobOpeningStatus; title: string; reference: string }> {
  const filter = jobOpeningFilter(actor);
  if (filter === null) throw new NotFoundError('Job opening');

  const row = await prisma.jobOpening.findFirst({
    where: { AND: [{ id, companyId: actor.auth.companyId }, filter] },
    select: { id: true, status: true, title: true, reference: true },
  });
  if (!row) throw new NotFoundError('Job opening');

  return { ...row, status: row.status as JobOpeningStatus };
}

/**
 * Fetches one interview the caller may read, or 404s.
 *
 * A 404 rather than a 403 on purpose, and the same everywhere in this module:
 * telling somebody "that exists but is not yours" confirms that a particular
 * candidate is being interviewed, which is precisely what an unauthorised
 * caller was probing for. A guessed id answers the same way a made-up one does.
 */
export async function interviewOrThrow(
  actor: RecruitmentActor,
  id: string,
): Promise<{ id: string; status: InterviewStatus; candidateId: string; startsAt: Date }> {
  const filter = interviewFilter(actor);
  if (filter === null) throw new NotFoundError('Interview');

  const row = await prisma.interview.findFirst({
    where: { AND: [{ id, companyId: actor.auth.companyId }, filter] },
    select: { id: true, status: true, candidateId: true, startsAt: true },
  });
  if (!row) throw new NotFoundError('Interview');

  return { ...row, status: row.status as InterviewStatus };
}

/**
 * Fetches one candidate the caller may read, or 404s.
 *
 * `candidate.read` is the gate, and it is not widened by involvement: an
 * interviewer who holds no candidate grant reaches the candidate's NAME through
 * the interview - which carries it - and reaches this endpoint not at all. That
 * is the section 20 rule, enforced by the route's permission and by this
 * lookup, rather than by hiding a button.
 */
export async function candidateOrThrow(
  actor: RecruitmentActor,
  id: string,
): Promise<{ id: string; fullName: string; reference: string; hiredEmployeeId: string | null }> {
  if (!actor.canReadCandidates) throw new NotFoundError('Candidate');

  const row = await prisma.candidate.findFirst({
    where: { id, companyId: actor.auth.companyId },
    select: { id: true, fullName: true, reference: true, hiredEmployeeId: true },
  });
  if (!row) throw new NotFoundError('Candidate');

  return row;
}

// --------------------------------------------------------------- references

/**
 * The next reference in a per-company sequence, e.g. JOB-0007 or CAN-0042.
 *
 * Derived from the highest number already issued rather than from a row count,
 * so deleting a record cannot cause a collision - the same reasoning
 * `nextEmployeeNumber` applies. The unique index on (companyId, reference) is
 * the real guarantee; callers retry on it.
 */
export async function nextReference(
  companyId: string,
  kind: 'job' | 'candidate',
): Promise<string> {
  const prefix = kind === 'job' ? 'JOB-' : 'CAN-';

  const existing =
    kind === 'job'
      ? await prisma.jobOpening.findMany({
          where: { companyId, reference: { startsWith: prefix } },
          select: { reference: true },
        })
      : await prisma.candidate.findMany({
          where: { companyId, reference: { startsWith: prefix } },
          select: { reference: true },
        });

  let highest = 0;
  for (const { reference } of existing) {
    const suffix = reference.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    highest = Math.max(highest, Number.parseInt(suffix, 10));
  }

  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

// -------------------------------------------------------------------- times

/**
 * Turns a day, two wall-clock times and a zone into two instants.
 *
 * The interview is at ten o'clock in Karachi whoever is looking at it, so the
 * three parts travel from the client and the arithmetic happens here. A zone
 * the runtime does not recognise is refused rather than silently treated as
 * UTC, which would move every interview booked through it.
 */
export function resolveInterviewWindow(input: {
  day: string;
  startTime: string;
  endTime: string;
  timezone: string;
}): { startsAt: Date; endsAt: Date } {
  if (!isValidTimeZone(input.timezone)) {
    throw new ValidationError({ timezone: ['That is not a time zone this server recognises.'] });
  }

  const [startHour, startMinute] = input.startTime.split(':').map(Number);
  const [endHour, endMinute] = input.endTime.split(':').map(Number);

  const startsAt = instantInZone(input.day, startHour!, startMinute!, input.timezone);
  const endsAt = instantInZone(input.day, endHour!, endMinute!, input.timezone);

  // The schema already refuses end <= start as wall-clock strings. This catches
  // the one case it cannot see: a daylight-saving fold that makes the two
  // strings resolve to the same instant or invert them.
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new ValidationError({
      endTime: ['That end time does not come after the start time in this time zone.'],
    });
  }

  return { startsAt, endsAt };
}

/**
 * The company's own timezone, which every "today" in this module is decided in.
 *
 * Falls back to UTC only when a company has none, which the schema makes
 * unlikely; guessing the server's zone would make "interviews today" mean
 * different things on different machines.
 */
export async function companyTimezone(companyId: string): Promise<string> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const zone = company?.timezone;
  return zone && isValidTimeZone(zone) ? zone : 'UTC';
}

// ------------------------------------------------------------------ mappers

const fullName = (first: string, last: string) => `${first} ${last}`.trim();
const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
const money = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));

export const JOB_OPENING_INCLUDE = {
  department: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  hiringManager: { select: { id: true, firstName: true, lastName: true } },
  recruiter: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { applications: true } },
} satisfies Prisma.JobOpeningInclude;

type JobOpeningRow = Prisma.JobOpeningGetPayload<{ include: typeof JOB_OPENING_INCLUDE }>;

export function toJobOpeningRecord(row: JobOpeningRow, hiredCount = 0): JobOpeningRecord {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    department: row.department,
    team: row.team,
    location: row.location,
    employmentType: row.employmentType,
    expectedEmploymentStatus: row.expectedEmploymentStatus,
    vacancies: row.vacancies,
    hiringManager: row.hiringManager
      ? {
          id: row.hiringManager.id,
          fullName: fullName(row.hiringManager.firstName, row.hiringManager.lastName),
        }
      : null,
    recruiter: row.recruiter
      ? {
          id: row.recruiter.id,
          fullName: fullName(row.recruiter.firstName, row.recruiter.lastName),
        }
      : null,
    description: row.description,
    requirements: row.requirements,
    skills: row.skills,
    minExperienceYears: row.minExperienceYears,
    salaryMin: money(row.salaryMin),
    salaryMax: money(row.salaryMax),
    salaryCurrency: row.salaryCurrency,
    openingDate: isoDay(row.openingDate),
    closingDate: isoDay(row.closingDate),
    status: row.status as JobOpeningStatus,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedReason: row.closedReason,
    applicationCount: row._count.applications,
    hiredCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const CANDIDATE_INCLUDE = {
  recruiter: { select: { id: true, firstName: true, lastName: true } },
  applications: {
    orderBy: { appliedAt: 'desc' },
    include: {
      jobOpening: {
        select: {
          id: true,
          title: true,
          reference: true,
          department: { select: { name: true } },
        },
      },
    },
  },
  _count: { select: { documents: true, interviews: true } },
} satisfies Prisma.CandidateInclude;

type CandidateRow = Prisma.CandidateGetPayload<{ include: typeof CANDIDATE_INCLUDE }>;

/**
 * Builds a candidate response.
 *
 * `includeRestricted` attaches the salary-and-notes block or OMITS it - never
 * nulls it. The distinction matters for exactly the reason it matters on the
 * employee record: a client that sees `restricted: { currentSalary: null }`
 * reads "we do not know what they earn", and a client that sees no `restricted`
 * key at all reads "you may not be told", which is the true one. It is also
 * what lets the UI hide the section rather than render five blanks.
 *
 * The document count is NOT filtered by confidentiality here; the documents
 * endpoint is what decides which files a caller may list, and a count that
 * changed meaning between callers would be a worse lie than a number.
 */
export function toCandidateRecord(row: CandidateRow, includeRestricted: boolean): CandidateRecord {
  const applications: CandidateApplicationRecord[] = row.applications.map((application) => ({
    id: application.id,
    jobOpeningId: application.jobOpeningId,
    jobTitle: application.jobOpening.title,
    jobReference: application.jobOpening.reference,
    departmentName: application.jobOpening.department?.name ?? null,
    stage: application.stage as CandidateStage,
    stageChangedAt: application.stageChangedAt.toISOString(),
    outcomeReason: application.outcomeReason,
    appliedAt: application.appliedAt.toISOString(),
  }));

  const record: CandidateRecord = {
    id: row.id,
    reference: row.reference,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    currentLocation: row.currentLocation,
    linkedinUrl: row.linkedinUrl,
    portfolioUrl: row.portfolioUrl,
    skills: row.skills,
    experienceYears: row.experienceYears,
    currentCompany: row.currentCompany,
    currentTitle: row.currentTitle,
    noticePeriodDays: row.noticePeriodDays,
    source: row.source,
    recruiter: row.recruiter
      ? {
          id: row.recruiter.id,
          fullName: fullName(row.recruiter.firstName, row.recruiter.lastName),
        }
      : null,
    stage: row.stage as CandidateStage,
    applications,
    documentCount: row._count.documents,
    interviewCount: row._count.interviews,
    hiredEmployeeId: row.hiredEmployeeId,
    hiredAt: row.hiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  if (includeRestricted) {
    record.restricted = {
      currentSalary: money(row.currentSalary),
      expectedSalary: money(row.expectedSalary),
      salaryCurrency: row.salaryCurrency,
      notes: row.notes,
    };
  }

  return record;
}

export const INTERVIEW_INCLUDE = {
  candidate: { select: { id: true, fullName: true, reference: true } },
  jobOpening: {
    select: { id: true, title: true, department: { select: { name: true } } },
  },
  participants: {
    orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
    include: {
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          jobTitle: true,
          designation: { select: { name: true } },
        },
      },
      evaluation: { select: { id: true } },
    },
  },
} satisfies Prisma.InterviewInclude;

type InterviewRow = Prisma.InterviewGetPayload<{ include: typeof INTERVIEW_INCLUDE }>;

export function toInterviewRecord(row: InterviewRow): InterviewRecord {
  const interviewers = row.participants.map((participant) => ({
    employeeId: participant.employeeId,
    fullName: fullName(participant.employee.firstName, participant.employee.lastName),
    jobTitle: participant.employee.designation?.name ?? participant.employee.jobTitle,
    isLead: participant.isLead,
    confirmedAt: participant.confirmedAt?.toISOString() ?? null,
    hasEvaluation: participant.evaluation !== null,
  }));

  const evaluationCount = interviewers.filter((i) => i.hasEvaluation).length;

  return {
    id: row.id,
    candidateId: row.candidateId,
    candidateName: row.candidate.fullName,
    candidateReference: row.candidate.reference,
    jobOpeningId: row.jobOpeningId,
    jobTitle: row.jobOpening?.title ?? null,
    departmentName: row.jobOpening?.department?.name ?? null,
    applicationId: row.applicationId,
    type: row.type as InterviewType,
    round: row.round as InterviewRound,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timezone: row.timezone,
    location: row.location,
    meetingLink: row.meetingLink,
    notes: row.notes,
    status: row.status as InterviewStatus,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
    interviewers,
    evaluationCount,
    evaluationsPending: interviewers.length - evaluationCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const OFFER_INCLUDE = {
  candidate: { select: { id: true, fullName: true } },
  jobOpening: { select: { id: true, title: true } },
  designation: { select: { id: true, name: true } },
} satisfies Prisma.OfferInclude;

type OfferRow = Prisma.OfferGetPayload<{ include: typeof OFFER_INCLUDE }>;

export function toOfferRecord(row: OfferRow): OfferRecord {
  return {
    id: row.id,
    candidateId: row.candidateId,
    candidateName: row.candidate.fullName,
    jobOpeningId: row.jobOpeningId,
    jobTitle: row.jobOpening?.title ?? null,
    applicationId: row.applicationId,
    designation: row.designation,
    proposedTitle: row.proposedTitle,
    employmentType: row.employmentType,
    employmentStatus: row.employmentStatus,
    proposedSalary: money(row.proposedSalary),
    salaryCurrency: row.salaryCurrency,
    expectedJoiningDate: isoDay(row.expectedJoiningDate),
    status: row.status as OfferStatus,
    sentAt: row.sentAt?.toISOString() ?? null,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    expiresAt: isoDay(row.expiresAt),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const EVALUATION_INCLUDE = {
  participant: {
    include: {
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.InterviewEvaluationInclude;

type EvaluationRow = Prisma.InterviewEvaluationGetPayload<{ include: typeof EVALUATION_INCLUDE }>;

export function toEvaluationRecord(
  row: EvaluationRow,
  callerEmployeeId: string | null,
): EvaluationRecord {
  return {
    id: row.id,
    interviewId: row.interviewId,
    interviewerEmployeeId: row.participant.employeeId,
    interviewerName: fullName(
      row.participant.employee.firstName,
      row.participant.employee.lastName,
    ),
    technicalScore: row.technicalScore,
    problemSolvingScore: row.problemSolvingScore,
    communicationScore: row.communicationScore,
    experienceScore: row.experienceScore,
    cultureFitScore: row.cultureFitScore,
    recommendation: row.recommendation,
    comments: row.comments,
    submittedAt: row.submittedAt.toISOString(),
    isMine: callerEmployeeId !== null && row.participant.employeeId === callerEmployeeId,
  };
}

// ------------------------------------------------------------ derived stage

/**
 * Recomputes the candidate's summary stage from their applications.
 *
 * Called after every application stage change. It writes ONE column on the
 * candidate and touches nothing else - no employee row, no notification, no
 * audit entry of its own, because the audit entry belongs to the stage change
 * that caused it.
 *
 * The derivation itself lives in the shared package so the board, the list and
 * this cannot come to different conclusions about the same person.
 */
export async function refreshCandidateStage(candidateId: string): Promise<CandidateStage> {
  const applications = await prisma.candidateApplication.findMany({
    where: { candidateId },
    select: { stage: true },
  });

  const current = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { stage: true },
  });

  const derived = deriveCandidateStage(
    applications.map((a) => a.stage as CandidateStage),
    (current?.stage as CandidateStage | undefined) ?? 'NEW',
  );

  if (current && current.stage !== derived) {
    await prisma.candidate.update({ where: { id: candidateId }, data: { stage: derived } });
  }

  return derived;
}

/** Highest-ranked stage of the two. Used when summarising a job's pipeline. */
export function furtherStage(a: CandidateStage, b: CandidateStage): CandidateStage {
  return CANDIDATE_STAGE_RANK[a] >= CANDIDATE_STAGE_RANK[b] ? a : b;
}

// ------------------------------------------------------ reference integrity

/**
 * Proves every organisation id on a job opening belongs to this company.
 *
 * One pass, so the form gets all its bad references at once. The company check
 * in each WHERE is the part that matters for security rather than for
 * usability: without it, a department id from another installation would be
 * accepted and the opening would join across a tenant boundary.
 */
export async function assertOpeningReferences(
  companyId: string,
  input: {
    departmentId?: string | null;
    teamId?: string | null;
    locationId?: string | null;
    hiringManagerId?: string | null;
    recruiterId?: string | null;
  },
): Promise<void> {
  const details: Record<string, string[]> = {};

  const [department, team, location, hiringManager, recruiter] = await Promise.all([
    input.departmentId
      ? prisma.department.findFirst({
          where: { id: input.departmentId, companyId },
          select: { id: true },
        })
      : null,
    input.teamId
      ? prisma.team.findFirst({ where: { id: input.teamId, companyId }, select: { id: true } })
      : null,
    input.locationId
      ? prisma.location.findFirst({
          where: { id: input.locationId, companyId },
          select: { id: true },
        })
      : null,
    input.hiringManagerId
      ? prisma.employee.findFirst({
          where: { id: input.hiringManagerId, companyId },
          select: { id: true },
        })
      : null,
    input.recruiterId
      ? prisma.employee.findFirst({
          where: { id: input.recruiterId, companyId },
          select: { id: true },
        })
      : null,
  ]);

  if (input.departmentId && !department) details.departmentId = ['That department does not exist.'];
  if (input.teamId && !team) details.teamId = ['That team does not exist.'];
  if (input.locationId && !location) details.locationId = ['That location does not exist.'];
  if (input.hiringManagerId && !hiringManager) {
    details.hiringManagerId = ['That employee does not exist.'];
  }
  if (input.recruiterId && !recruiter) details.recruiterId = ['That employee does not exist.'];

  // No department/team cross-check: a team is not a sub-unit of a department,
  // so a vacancy may name either, both or neither. Same rule as the employee
  // form - see `validateEmployeeRelations`.

  if (Object.keys(details).length > 0) throw new ValidationError(details);
}

/**
 * Proves every named interviewer is an employee of this company.
 *
 * Returns them in the order asked for, with their names, because the caller
 * needs both to create the seats and to notify the people in them. An id that
 * is not an employee here - a user id, an employee from another company, a
 * guess - is a validation error rather than a silently dropped seat, which is
 * the failure mode that produces an interview with an empty panel.
 */
export async function resolveInterviewers(
  companyId: string,
  employeeIds: readonly string[],
): Promise<Array<{ id: string; fullName: string; userId: string | null; workEmail: string | null }>> {
  const unique = [...new Set(employeeIds)];

  const rows = await prisma.employee.findMany({
    where: { id: { in: unique }, companyId },
    select: { id: true, firstName: true, lastName: true, userId: true, workEmail: true },
  });

  if (rows.length !== unique.length) {
    throw new ValidationError({
      interviewerIds: ['One of those interviewers is not an employee of this company.'],
    });
  }

  const byId = new Map(rows.map((row) => [row.id, row]));

  return unique.map((id) => {
    const row = byId.get(id)!;
    return {
      id: row.id,
      fullName: fullName(row.firstName, row.lastName),
      userId: row.userId,
      workEmail: row.workEmail,
    };
  });
}

/**
 * The caller's own seat on an interview, or a refusal.
 *
 * The single check behind every evaluation write. It is what makes
 * `interview.evaluate` reach the holder's OWN opinion and nothing else: the
 * participant row is looked up by (interviewId, the caller's employee id), so
 * there is no request shape that files feedback in somebody else's name or
 * overwrites theirs. A caller with no employee record has no seat anywhere.
 */
export async function ownParticipantOrThrow(
  actor: RecruitmentActor,
  interviewId: string,
): Promise<{ id: string; employeeId: string }> {
  if (!actor.employeeId) {
    throw new ForbiddenError('Only somebody on the panel can submit an evaluation.');
  }

  const participant = await prisma.interviewParticipant.findFirst({
    where: {
      interviewId,
      employeeId: actor.employeeId,
      companyId: actor.auth.companyId,
    },
    select: { id: true, employeeId: true },
  });

  if (!participant) {
    throw new ForbiddenError('You were not on the panel for that interview.');
  }

  return participant;
}
