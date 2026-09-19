import { z } from 'zod';
import { paginationQuerySchema } from './common.js';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES } from './employee.js';

/**
 * Recruitment: job openings, candidates, interviews and offers.
 *
 * One sentence decides the shape of everything below, and it is worth stating
 * before the vocabulary: A CANDIDATE IS NOT AN EMPLOYEE.
 *
 * Somebody applying for a job has no employee number, no department, no
 * contract, no attendance and no login. Modelling them as an employee with a
 * "status: APPLICANT" would mean every headcount, payroll run, org chart and
 * attendance report in this product quietly counting people who have never
 * worked here - and the day somebody forgets the filter is the day a payroll
 * run includes a stranger. So candidates are their own record with their own
 * lifecycle, and there is exactly one bridge between the two worlds: Convert to
 * Employee, which a person performs, reviews and confirms.
 *
 * Three more decisions run through this file:
 *
 *   - THE STAGE LIVES ON THE APPLICATION. A person can be shortlisted for one
 *     role and rejected for another on the same afternoon, and one stage column
 *     on the candidate could only ever record one of those. `CandidateRecord`
 *     carries a `stage` as well, and it is a DERIVED summary - the furthest
 *     stage across their applications, for the list screen - never the thing a
 *     decision is made against.
 *   - AN EVALUATION IS ADVICE, NOT ARITHMETIC. Nothing here averages the
 *     scores, ranks candidates by them, or moves anybody's stage because of
 *     one. Three interviewers produce three separate evaluations, none of which
 *     can overwrite another, and a human reads them.
 *   - AN OFFER IS NOT A CONTRACT AND NOT PAYROLL. The proposed salary is a
 *     number on an offer. Accepting one creates no salary row, no payroll
 *     profile and no contract; a new hire's pay is still set in payroll, by a
 *     person, on purpose.
 */

// --------------------------------------------------------------- job openings

export const JOB_OPENING_STATUSES = [
  'DRAFT',
  'OPEN',
  'ON_HOLD',
  'CLOSED',
  'CANCELLED',
] as const;

export type JobOpeningStatus = (typeof JOB_OPENING_STATUSES)[number];

export const JOB_OPENING_STATUS_LABELS: Record<JobOpeningStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  ON_HOLD: 'On hold',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/**
 * What each status means, written as a consequence rather than as an adjective.
 *
 * DRAFT is the one worth being careful about: it is not a quiet OPEN. A draft
 * does not appear on the pipeline, cannot take applications and does not count
 * towards "open positions" - because the difference between "we are hiring" and
 * "somebody started typing" is a number HR reports upwards.
 */
export const JOB_OPENING_STATUS_DESCRIPTIONS: Record<JobOpeningStatus, string> = {
  DRAFT: 'Being written. Takes no applications and counts towards nothing.',
  OPEN: 'Live. Candidates can be put against it and interviews arranged.',
  ON_HOLD: 'Paused - a freeze, a budget question - but not given up on.',
  CLOSED: 'Finished. The seats were filled or the search ended.',
  CANCELLED: 'Called off. The vacancy went away unfilled.',
};

/** The statuses where a vacancy is still a vacancy. */
export const JOB_OPENING_LIVE_STATUSES: readonly JobOpeningStatus[] = ['OPEN', 'ON_HOLD'];

/** Only these take new applications and new interviews. */
export const JOB_OPENING_ACCEPTING_STATUSES: readonly JobOpeningStatus[] = ['OPEN'];

export function isJobOpeningAccepting(status: JobOpeningStatus): boolean {
  return JOB_OPENING_ACCEPTING_STATUSES.includes(status);
}

/**
 * The two endings that need a reason.
 *
 * "Closed" with nothing beside it is the answer nobody can use six months later
 * when the same headcount comes back round, so the API insists on one.
 */
export const JOB_OPENING_TERMINAL_STATUSES: readonly JobOpeningStatus[] = ['CLOSED', 'CANCELLED'];

export function jobOpeningNeedsReason(status: JobOpeningStatus): boolean {
  return JOB_OPENING_TERMINAL_STATUSES.includes(status);
}

// ------------------------------------------------------------------ pipeline

export const CANDIDATE_STAGES = [
  'NEW',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'SELECTED',
  'OFFER',
  'HIRED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

/**
 * The seven stages that are a PROGRESSION, in order, and the two that are not.
 *
 * The board renders this list as its columns. REJECTED and WITHDRAWN are
 * deliberately absent from it: they are terminal states somebody LEAVES the
 * pipeline into, and giving them columns would turn a board that shows a
 * process into a board that mostly shows people who are no longer in it.
 */
export const CANDIDATE_PIPELINE_STAGES: readonly CandidateStage[] = [
  'NEW',
  'SCREENING',
  'SHORTLISTED',
  'INTERVIEW',
  'SELECTED',
  'OFFER',
  'HIRED',
];

/**
 * The two ways out, kept apart on purpose.
 *
 * Who ended it is exactly the question somebody asks when the same CV arrives
 * again next year: a candidate we turned down and a candidate who took another
 * job are not the same candidate, and collapsing them into "closed" loses the
 * one fact that would have been useful.
 */
export const CANDIDATE_TERMINAL_STAGES: readonly CandidateStage[] = ['REJECTED', 'WITHDRAWN'];

export function isCandidateTerminalStage(stage: CandidateStage): boolean {
  return CANDIDATE_TERMINAL_STAGES.includes(stage);
}

export const CANDIDATE_STAGE_LABELS: Record<CandidateStage, string> = {
  NEW: 'New',
  SCREENING: 'Screening',
  SHORTLISTED: 'Shortlisted',
  INTERVIEW: 'Interview',
  SELECTED: 'Selected',
  OFFER: 'Offer',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export const CANDIDATE_STAGE_DESCRIPTIONS: Record<CandidateStage, string> = {
  NEW: 'Applied. Nobody has looked yet.',
  SCREENING: 'Being read - the CV, the basics, the salary expectation.',
  SHORTLISTED: 'Worth meeting.',
  INTERVIEW: 'Interviewing, or booked to.',
  SELECTED: 'The panel wants them. No offer has been made yet.',
  OFFER: 'An offer is with them.',
  HIRED: 'They accepted. Convert them to an employee when they start.',
  REJECTED: 'We said no.',
  WITHDRAWN: 'They said no, or stopped answering.',
};

/**
 * How far through the process each stage is, 0 to 6.
 *
 * Used for exactly two things: ordering the board's columns, and working out a
 * candidate's DERIVED stage - the furthest one reached across their
 * applications. The terminal stages sit at -1 because "rejected for one job" is
 * not progress towards another, and a candidate rejected by Development while
 * shortlisted by Design should summarise as shortlisted.
 */
export const CANDIDATE_STAGE_RANK: Record<CandidateStage, number> = {
  NEW: 0,
  SCREENING: 1,
  SHORTLISTED: 2,
  INTERVIEW: 3,
  SELECTED: 4,
  OFFER: 5,
  HIRED: 6,
  REJECTED: -1,
  WITHDRAWN: -1,
};

/**
 * The candidate-level stage, derived from their applications.
 *
 * The furthest one reached, with the terminal stages counting for nothing
 * unless there is nothing else - somebody whose only application was rejected
 * IS rejected, and somebody rejected once and shortlisted elsewhere is
 * shortlisted. A candidate with no applications at all keeps their own stage,
 * which is how a CV in the database before any vacancy exists stays NEW.
 *
 * Shared rather than written in the service so the board, the list and the
 * server cannot come to different conclusions about the same person.
 */
export function deriveCandidateStage(
  applicationStages: readonly CandidateStage[],
  fallback: CandidateStage = 'NEW',
): CandidateStage {
  if (applicationStages.length === 0) return fallback;

  const live = applicationStages.filter((stage) => !isCandidateTerminalStage(stage));
  if (live.length > 0) {
    return live.reduce((best, stage) =>
      CANDIDATE_STAGE_RANK[stage] > CANDIDATE_STAGE_RANK[best] ? stage : best,
    );
  }

  // Every application ended. WITHDRAWN wins over REJECTED when both happened,
  // because somebody who walked away did so of their own accord and that is
  // the more informative of the two.
  return applicationStages.includes('WITHDRAWN') ? 'WITHDRAWN' : 'REJECTED';
}

/**
 * Which stages a candidate may be moved to from where.
 *
 * Deliberately permissive forwards and backwards between the live stages,
 * because hiring is not a state machine in real life: a candidate shortlisted
 * on Monday goes back to screening on Tuesday when somebody actually reads the
 * CV, and a process that refuses to let HR say so produces a board nobody
 * trusts. What it is NOT permissive about is the two things that matter:
 *
 *   - HIRED is reachable only from OFFER. Somebody is hired because they
 *     accepted an offer; arriving there from SCREENING means an offer was made
 *     that this system has no record of.
 *   - Nothing comes back from HIRED. A hired candidate is converted to an
 *     employee, and undoing that is an employee-record action, not a drag on a
 *     board.
 *
 * REJECTED and WITHDRAWN are reachable from every live stage - people drop out
 * at every point - and reversible back to SCREENING, because candidates are
 * re-opened and refusing to model that would mean a second duplicate record.
 */
export const CANDIDATE_STAGE_TRANSITIONS: Record<CandidateStage, readonly CandidateStage[]> = {
  NEW: ['SCREENING', 'SHORTLISTED', 'REJECTED', 'WITHDRAWN'],
  SCREENING: ['NEW', 'SHORTLISTED', 'INTERVIEW', 'REJECTED', 'WITHDRAWN'],
  SHORTLISTED: ['SCREENING', 'INTERVIEW', 'SELECTED', 'REJECTED', 'WITHDRAWN'],
  INTERVIEW: ['SHORTLISTED', 'SELECTED', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  SELECTED: ['INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'],
  OFFER: ['SELECTED', 'HIRED', 'REJECTED', 'WITHDRAWN'],
  HIRED: [],
  REJECTED: ['SCREENING'],
  WITHDRAWN: ['SCREENING'],
};

export function canTransitionCandidate(from: CandidateStage, to: CandidateStage): boolean {
  return CANDIDATE_STAGE_TRANSITIONS[from].includes(to);
}

/** A move into a terminal stage has to say why. */
export function stageNeedsReason(stage: CandidateStage): boolean {
  return isCandidateTerminalStage(stage);
}

// ---------------------------------------------------------------- interviews

export const INTERVIEW_TYPES = ['HR', 'TECHNICAL', 'MANAGER', 'FINAL', 'OTHER'] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const INTERVIEW_TYPE_LABELS: Record<InterviewType, string> = {
  HR: 'HR Interview',
  TECHNICAL: 'Technical Interview',
  MANAGER: 'Manager Interview',
  FINAL: 'Final Interview',
  OTHER: 'Other',
};

export const INTERVIEW_ROUNDS = ['ROUND_1', 'ROUND_2', 'ROUND_3', 'FINAL'] as const;

export type InterviewRound = (typeof INTERVIEW_ROUNDS)[number];

export const INTERVIEW_ROUND_LABELS: Record<InterviewRound, string> = {
  ROUND_1: 'Round 1',
  ROUND_2: 'Round 2',
  ROUND_3: 'Round 3',
  FINAL: 'Final',
};

export const INTERVIEW_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'COMPLETED',
  'RESCHEDULED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  RESCHEDULED: 'Rescheduled',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

export const INTERVIEW_STATUS_DESCRIPTIONS: Record<InterviewStatus, string> = {
  SCHEDULED: 'Booked. Nobody has confirmed yet.',
  CONFIRMED: 'Everyone has said they will be there.',
  COMPLETED: 'It happened. Evaluations can be filed.',
  RESCHEDULED: 'It moved. The new time is on this same interview.',
  CANCELLED: 'Called off. Kept, because cancelling on somebody is a fact.',
  NO_SHOW: 'The candidate did not turn up.',
};

/** The statuses where the appointment is still going to happen. */
export const INTERVIEW_LIVE_STATUSES: readonly InterviewStatus[] = [
  'SCHEDULED',
  'CONFIRMED',
  'RESCHEDULED',
];

export function isInterviewLive(status: InterviewStatus): boolean {
  return INTERVIEW_LIVE_STATUSES.includes(status);
}

/**
 * Which interviews count as occupying an interviewer's time.
 *
 * The clash check reads exactly this list. A cancelled interview frees the
 * slot; a completed one still occupied it, which matters when somebody is
 * re-scheduling into the past to correct a record.
 */
export const INTERVIEW_BLOCKING_STATUSES: readonly InterviewStatus[] = [
  'SCHEDULED',
  'CONFIRMED',
  'RESCHEDULED',
  'COMPLETED',
];

/**
 * The workflow, as the only statement of it anywhere.
 *
 * COMPLETED is nearly terminal and deliberately not quite: it can still move to
 * NO_SHOW, because "marked complete by mistake, they never arrived" is an
 * ordinary Tuesday. Nothing comes back from CANCELLED - a cancelled interview
 * that is happening after all is a new booking, which keeps the cancellation
 * visible instead of erasing it.
 *
 * RESCHEDULED is a status a reschedule PRODUCES, never one somebody picks: it
 * is absent from every list of allowed manual transitions, and the reschedule
 * endpoint is the only thing that writes it.
 */
export const INTERVIEW_STATUS_TRANSITIONS: Record<InterviewStatus, readonly InterviewStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  RESCHEDULED: ['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: ['NO_SHOW'],
  NO_SHOW: ['COMPLETED'],
  CANCELLED: [],
};

export function canTransitionInterview(from: InterviewStatus, to: InterviewStatus): boolean {
  return INTERVIEW_STATUS_TRANSITIONS[from].includes(to);
}

/** Only a live interview can be moved to a new time. */
export function canRescheduleInterview(status: InterviewStatus): boolean {
  return isInterviewLive(status);
}

/**
 * Whether an evaluation may be filed yet.
 *
 * COMPLETED and NO_SHOW only. An interview that has not happened has nothing to
 * evaluate, and section 11 asks for exactly this rule; NO_SHOW is included
 * because "they did not turn up" is itself feedback worth recording against the
 * candidate, and the alternative is an interviewer with nowhere to put it.
 */
export function canEvaluateInterview(status: InterviewStatus): boolean {
  return status === 'COMPLETED' || status === 'NO_SHOW';
}

export const INTERVIEW_RECOMMENDATIONS = ['STRONG_YES', 'YES', 'MAYBE', 'NO'] as const;

export type InterviewRecommendation = (typeof INTERVIEW_RECOMMENDATIONS)[number];

export const INTERVIEW_RECOMMENDATION_LABELS: Record<InterviewRecommendation, string> = {
  STRONG_YES: 'Strong yes',
  YES: 'Yes',
  MAYBE: 'Maybe',
  NO: 'No',
};

/**
 * The five things an interviewer scores, each out of ten and each optional.
 *
 * Optional is the load-bearing part. An HR interviewer has no business scoring
 * technical skill, and a nulled score says "not assessed" where a zero would
 * say "assessed, and terrible" - which is the difference between an honest
 * panel summary and a libel.
 */
export const EVALUATION_CRITERIA = [
  { key: 'technicalScore', label: 'Technical skills' },
  { key: 'problemSolvingScore', label: 'Problem solving' },
  { key: 'communicationScore', label: 'Communication' },
  { key: 'experienceScore', label: 'Experience' },
  { key: 'cultureFitScore', label: 'Culture / team fit' },
] as const;

export type EvaluationCriterionKey = (typeof EVALUATION_CRITERIA)[number]['key'];

export const EVALUATION_SCORE_MAX = 10;

// -------------------------------------------------------------------- offers

export const OFFER_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;

export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
};

export const OFFER_STATUS_DESCRIPTIONS: Record<OfferStatus, string> = {
  DRAFT: 'Being written. Nothing has been promised to anybody.',
  SENT: 'With the candidate, waiting for an answer.',
  ACCEPTED: 'They said yes. Convert them to an employee when they start.',
  DECLINED: 'They said no.',
  EXPIRED: 'The answer never came and the offer lapsed.',
};

/**
 * An offer that has been answered is finished.
 *
 * No transition leaves ACCEPTED, DECLINED or EXPIRED. Changing the terms after
 * somebody has answered is a NEW offer, which keeps the first one - and what it
 * promised - on the record.
 */
export const OFFER_STATUS_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  DRAFT: ['SENT'],
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED'],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
};

export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  return OFFER_STATUS_TRANSITIONS[from].includes(to);
}

export const OFFER_PENDING_STATUSES: readonly OfferStatus[] = ['DRAFT', 'SENT'];

// ----------------------------------------------------------------- documents

export const CANDIDATE_DOCUMENT_TYPES = [
  'RESUME',
  'COVER_LETTER',
  'PORTFOLIO',
  'CERTIFICATE',
  'OTHER',
] as const;

export type CandidateDocumentType = (typeof CANDIDATE_DOCUMENT_TYPES)[number];

export const CANDIDATE_DOCUMENT_TYPE_LABELS: Record<CandidateDocumentType, string> = {
  RESUME: 'CV / Resume',
  COVER_LETTER: 'Cover letter',
  PORTFOLIO: 'Portfolio',
  CERTIFICATE: 'Certificate',
  OTHER: 'Other',
};

/**
 * The limits on a candidate's document shelf.
 *
 * Deliberately the same 10 MB ceiling a case attachment has, and the same
 * accepted formats, because it is the same object store and the same sniffer.
 * The per-candidate cap exists for the reason the per-case one does: unbounded
 * uploads are a way to fill a disk 10 MB at a time from an ordinary account.
 */
export const CANDIDATE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CANDIDATE_DOCUMENT_MAX_PER_CANDIDATE = 20;

export const CANDIDATE_DOCUMENT_TOO_LARGE_MESSAGE =
  'That file is larger than 10 MB. Please upload a smaller one.';
export const CANDIDATE_DOCUMENT_TOO_MANY_MESSAGE =
  'This candidate already has the maximum of 20 documents.';

// ------------------------------------------------------------------ requests

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' || value === undefined ? null : value));

const optionalId = optionalText(64);

/** An ISO date or a yyyy-MM-dd input value; empty becomes null. */
const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value === '' || value === undefined ? null : value))
  .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
    message: 'Enter a valid date.',
  });

const optionalMoney = z.coerce
  .number()
  .min(0, 'A salary cannot be negative.')
  .max(999_999_999)
  .nullish()
  .transform((value) => (value === undefined ? null : value));

/**
 * `HH:mm` on a 24-hour clock.
 *
 * Interviews are booked as a DAY plus two wall-clock times plus a zone, never
 * as an instant the browser computed, because the browser's zone is the
 * interviewer's laptop and the interview is at ten o'clock in Karachi whoever
 * is looking at it. The server combines the three into an instant.
 */
const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:mm.');

const requiredDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.');

// --- job openings ---

export const jobOpeningInputSchema = z.object({
  title: z.string().trim().min(1, 'A job title is required.').max(160),
  departmentId: optionalId,
  teamId: optionalId,
  locationId: optionalId,
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  /**
   * The canonical `EmploymentStatus`, nullish. Nullish rather than defaulted
   * for the reason the employee record's is: a vacancy that has not decided is
   * not the same as one offering permanence, and defaulting would write an
   * answer nobody gave.
   */
  expectedEmploymentStatus: z.enum(EMPLOYMENT_STATUSES).nullish(),
  vacancies: z.coerce.number().int().min(1, 'At least one vacancy.').max(999).default(1),
  hiringManagerId: optionalId,
  recruiterId: optionalId,
  description: optionalText(8000),
  requirements: optionalText(8000),
  skills: optionalText(1000),
  minExperienceYears: z.coerce.number().int().min(0).max(60).nullish(),
  salaryMin: optionalMoney,
  salaryMax: optionalMoney,
  salaryCurrency: optionalText(8),
  openingDate: optionalDate,
  closingDate: optionalDate,
  status: z.enum(JOB_OPENING_STATUSES).default('DRAFT'),
})
  .refine(
    (v) => v.salaryMin === null || v.salaryMax === null || v.salaryMax >= v.salaryMin,
    { path: ['salaryMax'], message: 'The top of the range cannot be below the bottom.' },
  )
  .refine(
    (v) =>
      v.openingDate === null ||
      v.closingDate === null ||
      Date.parse(v.closingDate) >= Date.parse(v.openingDate),
    { path: ['closingDate'], message: 'Closing cannot be before opening.' },
  );

export type JobOpeningInput = z.infer<typeof jobOpeningInputSchema>;

/**
 * Editing an opening. Every field optional, and the status is NOT among them:
 * moving an opening to CLOSED or CANCELLED needs a reason, so it has its own
 * endpoint rather than riding along on a form save where the reason could be
 * forgotten.
 */
export const jobOpeningUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    departmentId: optionalId,
    teamId: optionalId,
    locationId: optionalId,
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
    expectedEmploymentStatus: z.enum(EMPLOYMENT_STATUSES).nullish(),
    vacancies: z.coerce.number().int().min(1).max(999).optional(),
    hiringManagerId: optionalId,
    recruiterId: optionalId,
    description: optionalText(8000),
    requirements: optionalText(8000),
    skills: optionalText(1000),
    minExperienceYears: z.coerce.number().int().min(0).max(60).nullish(),
    salaryMin: optionalMoney,
    salaryMax: optionalMoney,
    salaryCurrency: optionalText(8),
    openingDate: optionalDate,
    closingDate: optionalDate,
  })
  /*
   * Absent means LEAVE ALONE, and only `.partial()` makes that true.
   *
   * Every optional field above ends in a transform that turns undefined into
   * null - which is what an emptied form control should mean - and without
   * this, zod runs that transform for keys the request never sent. A PATCH
   * carrying one field would then arrive at the route as that field plus a
   * dozen explicit nulls, and renaming a vacancy would silently clear its
   * department, its panel and its salary band.
   */
  .partial();

export const jobOpeningStatusSchema = z.object({
  status: z.enum(JOB_OPENING_STATUSES),
  reason: optionalText(500),
});

export const jobOpeningQuerySchema = paginationQuerySchema.extend({
  status: z.enum(JOB_OPENING_STATUSES).optional(),
  departmentId: z.string().trim().max(64).optional(),
  teamId: z.string().trim().max(64).optional(),
  hiringManagerId: z.string().trim().max(64).optional(),
  recruiterId: z.string().trim().max(64).optional(),
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
});

export const JOB_OPENING_SORT_FIELDS = [
  'createdAt',
  'title',
  'openingDate',
  'closingDate',
  'status',
] as const;

// --- candidates ---

/**
 * An email address is required on a candidate, and it is the only contact
 * detail that is.
 *
 * Not because we need to write to them, but because it is the one thing that
 * identifies a person across applications. It is what
 * `candidates_companyId_email_key` is built on and therefore what stops the
 * same person becoming three records when they apply for three roles - which
 * is the duplicate problem section 5 asks us not to create.
 */
const candidateEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'An email address is required.')
  .max(200)
  .email('Enter a valid email address.');

export const candidateInputSchema = z.object({
  fullName: z.string().trim().min(1, 'A name is required.').max(160),
  email: candidateEmail,
  phone: optionalText(40),
  currentLocation: optionalText(160),
  linkedinUrl: optionalText(300),
  portfolioUrl: optionalText(300),
  skills: optionalText(1000),
  experienceYears: z.coerce.number().int().min(0).max(60).nullish(),
  currentCompany: optionalText(160),
  currentTitle: optionalText(160),
  currentSalary: optionalMoney,
  expectedSalary: optionalMoney,
  salaryCurrency: optionalText(8),
  noticePeriodDays: z.coerce.number().int().min(0).max(365).nullish(),
  source: optionalText(120),
  notes: optionalText(4000),
  recruiterId: optionalId,
  /** Apply them to a vacancy in the same action. Optional: a CV can be filed. */
  jobOpeningId: optionalId,
});

export type CandidateInput = z.infer<typeof candidateInputSchema>;

export const candidateUpdateSchema = candidateInputSchema
  .omit({ jobOpeningId: true })
  .partial();

export const candidateQuerySchema = paginationQuerySchema.extend({
  stage: z.enum(CANDIDATE_STAGES).optional(),
  jobOpeningId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  recruiterId: z.string().trim().max(64).optional(),
  skills: z.string().trim().max(200).optional(),
  /** Hide the two terminal stages, which is what a working list wants. */
  live: z.enum(['true', 'false']).optional(),
});

export const CANDIDATE_SORT_FIELDS = ['createdAt', 'fullName', 'stage', 'updatedAt'] as const;

/** Putting an existing candidate against a vacancy. */
export const applicationCreateSchema = z.object({
  jobOpeningId: z.string().trim().min(1, 'Choose a job opening.').max(64),
});

export const stageChangeSchema = z.object({
  stage: z.enum(CANDIDATE_STAGES),
  reason: optionalText(500),
});

// --- interviews ---

/**
 * Scheduling one.
 *
 * The time arrives as a day, two wall-clock times and a zone rather than as two
 * instants, deliberately. An instant computed in the browser is computed in the
 * BROWSER'S zone, so an HR coordinator working from home in a different country
 * would book "10:00" and produce an interview at a time nobody agreed to. The
 * three parts are unambiguous and the server does the arithmetic.
 */
export const interviewCreateSchema = z.object({
  candidateId: z.string().trim().min(1, 'Choose a candidate.').max(64),
  jobOpeningId: optionalId,
  applicationId: optionalId,
  type: z.enum(INTERVIEW_TYPES),
  round: z.enum(INTERVIEW_ROUNDS).default('ROUND_1'),
  day: requiredDay,
  startTime: clockTime,
  endTime: clockTime,
  timezone: z.string().trim().min(1, 'Choose a time zone.').max(64),
  interviewerIds: z
    .array(z.string().trim().min(1).max(64))
    .min(1, 'Add at least one interviewer.')
    .max(10, 'Ten interviewers is the most a panel can hold.'),
  leadInterviewerId: optionalId,
  location: optionalText(300),
  meetingLink: optionalText(500),
  notes: optionalText(4000),
  /**
   * Book it anyway, knowing an interviewer is already busy.
   *
   * A clash is a WARNING rather than a refusal, because double-booking is
   * sometimes the right answer - a panellist steps out of one thing for
   * another. What it must never be is silent, so the default is to refuse and
   * report who clashes with what, and this flag is how a human overrules that
   * after reading it.
   */
  allowConflicts: z.boolean().default(false),
})
  .refine((v) => v.endTime > v.startTime, {
    path: ['endTime'],
    message: 'The end time must be after the start time.',
  })
  .refine(
    (v) => v.leadInterviewerId === null || v.interviewerIds.includes(v.leadInterviewerId),
    { path: ['leadInterviewerId'], message: 'The lead has to be one of the interviewers.' },
  );

export type InterviewCreateInput = z.infer<typeof interviewCreateSchema>;

/** Editing the things about an interview that are not its time. */
export const interviewUpdateSchema = z
  .object({
    type: z.enum(INTERVIEW_TYPES).optional(),
    round: z.enum(INTERVIEW_ROUNDS).optional(),
    location: optionalText(300),
    meetingLink: optionalText(500),
    notes: optionalText(4000),
    interviewerIds: z.array(z.string().trim().min(1).max(64)).min(1).max(10).optional(),
    leadInterviewerId: optionalId,
  })
  // Absent means leave alone, for the reason given on the opening's update
  // schema: without this, editing an interview's notes would clear the room it
  // is being held in and the link people were going to join on.
  .partial()
  .extend({ allowConflicts: z.boolean().default(false) });

/**
 * Moving one.
 *
 * The reason is COMPULSORY and is the whole point of this being its own
 * endpoint: section 10 asks that a reschedule not silently overwrite history,
 * and a reschedule without a reason is exactly that with an extra timestamp.
 */
export const interviewRescheduleSchema = z.object({
  day: requiredDay,
  startTime: clockTime,
  endTime: clockTime,
  timezone: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1, 'Say why it is moving.').max(500),
  allowConflicts: z.boolean().default(false),
}).refine((v) => v.endTime > v.startTime, {
  path: ['endTime'],
  message: 'The end time must be after the start time.',
});

export const interviewStatusSchema = z.object({
  status: z.enum(INTERVIEW_STATUSES),
  reason: optionalText(500),
});

export const interviewQuerySchema = paginationQuerySchema.extend({
  status: z.enum(INTERVIEW_STATUSES).optional(),
  type: z.enum(INTERVIEW_TYPES).optional(),
  interviewerId: z.string().trim().max(64).optional(),
  candidateId: z.string().trim().max(64).optional(),
  jobOpeningId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
  /** `mine` narrows to the caller's own panel seats, resolved server-side. */
  scope: z.enum(['all', 'mine']).optional(),
});

/**
 * The calendar's own query.
 *
 * A view and an anchor day rather than a from/to pair, so the server works out
 * the window in the COMPANY's zone. A browser computing "this week" computes it
 * in the browser's zone, which is how a Monday interview disappears from a
 * Monday-to-Sunday week for somebody sitting five hours west.
 */
export const interviewCalendarQuerySchema = z.object({
  view: z.enum(['day', 'week', 'month']).default('week'),
  day: requiredDay.optional(),
  interviewerId: z.string().trim().max(64).optional(),
  jobOpeningId: z.string().trim().max(64).optional(),
  departmentId: z.string().trim().max(64).optional(),
  type: z.enum(INTERVIEW_TYPES).optional(),
  status: z.enum(INTERVIEW_STATUSES).optional(),
  scope: z.enum(['all', 'mine']).optional(),
});

/** Asking who would clash, before committing to a time. */
export const interviewConflictQuerySchema = z.object({
  day: requiredDay,
  startTime: clockTime,
  endTime: clockTime,
  timezone: z.string().trim().min(1).max(64),
  interviewerIds: z.string().trim().min(1).max(1000),
  /** Ignore this interview when checking - it is the one being moved. */
  excludeInterviewId: z.string().trim().max(64).optional(),
});

const score = z.coerce
  .number()
  .int()
  .min(0, 'A score is 0 to 10.')
  .max(EVALUATION_SCORE_MAX, 'A score is 0 to 10.')
  .nullish()
  .transform((value) => (value === undefined ? null : value));

export const evaluationInputSchema = z.object({
  technicalScore: score,
  problemSolvingScore: score,
  communicationScore: score,
  experienceScore: score,
  cultureFitScore: score,
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS),
  comments: optionalText(4000),
});

export type EvaluationInput = z.infer<typeof evaluationInputSchema>;

// --- offers ---

export const offerInputSchema = z.object({
  candidateId: z.string().trim().min(1, 'Choose a candidate.').max(64),
  jobOpeningId: optionalId,
  applicationId: optionalId,
  designationId: optionalId,
  proposedTitle: optionalText(160),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  /**
   * The stage a new hire starts on. Defaulted to PROBATION here because
   * section 17 asks for that default explicitly - and it is a default, not a
   * rule: HR picks PERMANENT or INTERNEE on the form when that is the deal.
   */
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).default('PROBATION'),
  proposedSalary: optionalMoney,
  salaryCurrency: optionalText(8),
  expectedJoiningDate: optionalDate,
  expiresAt: optionalDate,
  notes: optionalText(4000),
});

export const offerUpdateSchema = offerInputSchema.omit({ candidateId: true }).partial();

export const offerStatusSchema = z.object({
  status: z.enum(OFFER_STATUSES),
  reason: optionalText(500),
});

export const offerQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OFFER_STATUSES).optional(),
  candidateId: z.string().trim().max(64).optional(),
  jobOpeningId: z.string().trim().max(64).optional(),
});

// --- documents ---

export const candidateDocumentUploadQuerySchema = z.object({
  filename: z.string().trim().max(400).optional(),
  type: z.enum(CANDIDATE_DOCUMENT_TYPES).optional(),
  confidential: z.enum(['true', 'false']).optional(),
});

// --- conversion ---

/**
 * Convert to Employee.
 *
 * Every field is here rather than derived, because section 16 asks that HR
 * REVIEW the mapping before an employee is created. The server offers a
 * proposal - `CandidateConversionPreview` below - the form shows it, a person
 * edits it, and THIS is what they confirm. Nothing is created from the
 * candidate record alone.
 */
export const candidateConvertSchema = z.object({
  employeeNumber: optionalText(32),
  firstName: z.string().trim().min(1, 'First name is required.').max(80),
  lastName: z.string().trim().min(1, 'Last name is required.').max(80),
  workEmail: optionalText(200),
  personalEmail: optionalText(200),
  phone: optionalText(40),
  departmentId: optionalId,
  teamId: optionalId,
  designationId: optionalId,
  locationId: optionalId,
  managerId: optionalId,
  jobTitle: optionalText(120),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  /**
   * PROBATION unless HR says otherwise - the default section 17 asks for. The
   * canonical enum, and the same three values the employee form offers, so
   * nothing is translated on the way across.
   */
  employmentStatus: z.enum(EMPLOYMENT_STATUSES).default('PROBATION'),
  hireDate: optionalDate,
  sourceOfHire: optionalText(120),
  linkedinUrl: optionalText(300),
  priorExperienceMonths: z.coerce.number().int().min(0).max(1200).nullish(),
  /**
   * Proceed even though somebody who looks like this person already has an
   * employee record.
   *
   * The duplicate check runs first and REFUSES by default, naming the matches.
   * This is how a human overrules it after looking - two people really do share
   * a name - and it is deliberately not a silent default.
   */
  acknowledgeDuplicates: z.boolean().default(false),
});

export type CandidateConvertInput = z.infer<typeof candidateConvertSchema>;

// ------------------------------------------------------------------ records

export interface LookupRef {
  id: string;
  name: string;
}

export interface JobOpeningRecord {
  id: string;
  reference: string;
  title: string;
  department: LookupRef | null;
  team: LookupRef | null;
  location: LookupRef | null;
  employmentType: string;
  expectedEmploymentStatus: string | null;
  vacancies: number;
  hiringManager: { id: string; fullName: string } | null;
  recruiter: { id: string; fullName: string } | null;
  description: string | null;
  requirements: string | null;
  skills: string | null;
  minExperienceYears: number | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  openingDate: string | null;
  closingDate: string | null;
  status: JobOpeningStatus;
  closedAt: string | null;
  closedReason: string | null;
  /** How many candidates are against it, and how many have been hired. */
  applicationCount: number;
  hiredCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateApplicationRecord {
  id: string;
  jobOpeningId: string;
  jobTitle: string;
  jobReference: string;
  departmentName: string | null;
  stage: CandidateStage;
  stageChangedAt: string;
  outcomeReason: string | null;
  appliedAt: string;
}

/**
 * What a candidate looks like to a reader.
 *
 * `restricted` is attached only for a caller holding `candidate.manage`, and it
 * is OMITTED rather than nulled - so a client can tell "you may not see this"
 * from "this is not set", exactly as the employee record's restricted block
 * does. That is what lets an interviewer open the person they are meeting and
 * be shown no salary history at all rather than a row of blanks that invites a
 * guess.
 */
export interface CandidateRecord {
  id: string;
  reference: string;
  fullName: string;
  email: string;
  phone: string | null;
  currentLocation: string | null;
  linkedinUrl: string | null;
  portfolioUrl: string | null;
  skills: string | null;
  experienceYears: number | null;
  currentCompany: string | null;
  currentTitle: string | null;
  noticePeriodDays: number | null;
  source: string | null;
  recruiter: { id: string; fullName: string } | null;
  /** The DERIVED summary. The applications below carry the real stages. */
  stage: CandidateStage;
  applications: CandidateApplicationRecord[];
  documentCount: number;
  interviewCount: number;
  hiredEmployeeId: string | null;
  hiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  restricted?: {
    currentSalary: number | null;
    expectedSalary: number | null;
    salaryCurrency: string | null;
    notes: string | null;
  };
}

export interface InterviewerRef {
  employeeId: string;
  fullName: string;
  jobTitle: string | null;
  isLead: boolean;
  confirmedAt: string | null;
  /** Whether this panellist has filed their evaluation yet. */
  hasEvaluation: boolean;
}

export interface InterviewScheduleChangeRecord {
  id: string;
  previousStartsAt: string;
  previousEndsAt: string;
  previousTimezone: string;
  newStartsAt: string;
  newEndsAt: string;
  newTimezone: string;
  reason: string;
  changedByName: string | null;
  createdAt: string;
}

export interface InterviewRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  candidateReference: string;
  jobOpeningId: string | null;
  jobTitle: string | null;
  departmentName: string | null;
  applicationId: string | null;
  type: InterviewType;
  round: InterviewRound;
  startsAt: string;
  endsAt: string;
  timezone: string;
  location: string | null;
  meetingLink: string | null;
  notes: string | null;
  status: InterviewStatus;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  interviewers: InterviewerRef[];
  evaluationCount: number;
  /** How many panellists have not filed yet. Drives "Evaluation pending". */
  evaluationsPending: number;
  /** Set only on the detail read, and only for a caller who may see it. */
  scheduleChanges?: InterviewScheduleChangeRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationRecord {
  id: string;
  interviewId: string;
  interviewerEmployeeId: string;
  interviewerName: string;
  technicalScore: number | null;
  problemSolvingScore: number | null;
  communicationScore: number | null;
  experienceScore: number | null;
  cultureFitScore: number | null;
  recommendation: InterviewRecommendation;
  comments: string | null;
  submittedAt: string;
  /** True when this evaluation is the caller's own, so the UI can offer edit. */
  isMine: boolean;
}

/**
 * A panel's feedback, as a panel rather than as an average.
 *
 * `pending` names the people who have not filed. That is the figure section 12
 * asks to be shown - "HR Manager: Pending" - and it is an absence rather than a
 * zero, which is why it is a separate list and not a null-scored evaluation.
 */
export interface InterviewEvaluationSummary {
  interviewId: string;
  evaluations: EvaluationRecord[];
  pending: Array<{ employeeId: string; fullName: string }>;
}

export interface OfferRecord {
  id: string;
  candidateId: string;
  candidateName: string;
  jobOpeningId: string | null;
  jobTitle: string | null;
  applicationId: string | null;
  designation: LookupRef | null;
  proposedTitle: string | null;
  employmentType: string;
  employmentStatus: string | null;
  proposedSalary: number | null;
  salaryCurrency: string | null;
  expectedJoiningDate: string | null;
  status: OfferStatus;
  sentAt: string | null;
  respondedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateDocumentRecord {
  id: string;
  type: CandidateDocumentType;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  isConfidential: boolean;
  uploadedByName: string | null;
  createdAt: string;
}

/**
 * One thing that happened to a candidate.
 *
 * A READ layer, like the employee timeline: every entry is a row some other
 * table already owns, read back and normalised. There is no candidate-timeline
 * table and nothing writes one, so this can never disagree with the records it
 * describes.
 */
export interface CandidateTimelineEntry {
  at: string;
  kind:
    | 'CANDIDATE_CREATED'
    | 'APPLIED'
    | 'STAGE_CHANGED'
    | 'INTERVIEW_SCHEDULED'
    | 'INTERVIEW_RESCHEDULED'
    | 'INTERVIEW_COMPLETED'
    | 'INTERVIEW_CANCELLED'
    | 'EVALUATION_SUBMITTED'
    | 'OFFER_CREATED'
    | 'OFFER_SENT'
    | 'OFFER_ANSWERED'
    | 'DOCUMENT_UPLOADED'
    | 'CONVERTED_TO_EMPLOYEE';
  title: string;
  detail: string | null;
  actorName: string | null;
}

/** Who can be put on a panel: an existing employee, never a new user record. */
export interface InterviewerOption {
  employeeId: string;
  fullName: string;
  jobTitle: string | null;
  departmentName: string | null;
  /** Their login account, where they have one - so they can be notified. */
  hasLogin: boolean;
}

/** One interviewer already busy at the proposed time. */
export interface InterviewConflict {
  employeeId: string;
  fullName: string;
  interviewId: string;
  candidateName: string;
  startsAt: string;
  endsAt: string;
  status: InterviewStatus;
}

/**
 * What scheduling actually did, beyond creating the row.
 *
 * `emailStatus` is reported per the notification service's own vocabulary and
 * is NOT flattened into "sent". Section 21 is explicit about this: if mail is
 * configured to the console provider, the UI must not claim an email was
 * delivered. `notified` counts in-app notifications, which are durable and
 * always written; `emailStatus` describes the other half honestly.
 */
export interface InterviewScheduleResult {
  interview: InterviewRecord;
  notified: number;
  emailStatus: 'skipped' | 'delivered' | 'unconfirmed' | 'failed';
  emailProvider: string | null;
  /** Panellists who were double-booked and whom the caller chose to book anyway. */
  conflicts: InterviewConflict[];
}

/**
 * The proposal HR is shown before an employee is created.
 *
 * `duplicates` is the part that matters: existing employees who look like this
 * candidate, by email or by name. The conversion REFUSES while any are present
 * unless the caller acknowledges them, so section 16's "do not automatically
 * create a duplicate employee" is enforced rather than hoped for.
 */
export interface CandidateConversionPreview {
  candidateId: string;
  suggested: {
    employeeNumber: string;
    firstName: string;
    lastName: string;
    workEmail: string | null;
    personalEmail: string | null;
    phone: string | null;
    departmentId: string | null;
    teamId: string | null;
    designationId: string | null;
    locationId: string | null;
    jobTitle: string | null;
    employmentType: string;
    employmentStatus: string;
    hireDate: string | null;
    sourceOfHire: string | null;
    linkedinUrl: string | null;
    priorExperienceMonths: number | null;
  };
  /** Where each suggestion came from, so HR can see what is being assumed. */
  derivedFrom: {
    offerId: string | null;
    jobOpeningId: string | null;
  };
  duplicates: Array<{
    employeeId: string;
    employeeNumber: string;
    fullName: string;
    workEmail: string | null;
    matchedOn: 'EMAIL' | 'NAME';
  }>;
  /** Set when this candidate has already been converted. */
  alreadyConvertedEmployeeId: string | null;
}

export interface RecruitmentDashboard {
  openPositions: number;
  /** Seats, not vacancies: six openings for two people each is twelve. */
  openVacancies: number;
  activeCandidates: number;
  candidatesInInterview: number;
  interviewsToday: number;
  upcomingInterviews: number;
  offersPending: number;
  hiredThisMonth: number;
  /** The company day these figures were computed for, in its own timezone. */
  today: string;
  timezone: string;
}

/** One line on the "upcoming interviews" panel. */
export interface UpcomingInterview {
  id: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  candidateId: string;
  candidateName: string;
  jobTitle: string | null;
  type: InterviewType;
  round: InterviewRound;
  status: InterviewStatus;
  interviewerNames: string[];
  /** `TODAY` or `UPCOMING`, decided in the company's zone by the server. */
  when: 'TODAY' | 'UPCOMING';
}

/** The interviewer's own three figures. */
export interface MyInterviewSummary {
  today: number;
  upcoming: number;
  completed: number;
  /** Interviews they have sat on and not yet filed feedback for. */
  awaitingEvaluation: number;
}
