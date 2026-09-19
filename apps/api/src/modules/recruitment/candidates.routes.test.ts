import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Candidates, and the two rules the whole file exists to hold.
 *
 * A CANDIDATE IS NOT AN EMPLOYEE, AND IS NOT DUPLICATED PER VACANCY. Applying
 * for a second role adds an APPLICATION to one person, a second record with the
 * same email is refused by name, and nothing on this plugin - not even moving
 * somebody to HIRED - writes to the employees table.
 *
 * AND THE RESTRICTED BLOCK IS OMITTED, NOT NULLED. `candidate.read` returns
 * everything about a person except what they earn, what they are asking for and
 * what HR has written about them; `candidate.manage` restores it. The
 * distinction between an absent key and a null one is the difference between
 * "you may not be told" and "we do not know", and only one of them is true.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { candidateRoutes } = await import('./candidates.routes.js');
const {
  EMPLOYEE,
  HR,
  NOW,
  appAs,
  applicationRow,
  auditActions,
  candidateRow,
  useRecruitmentDb,
  wirePeople,
} = kit;

const PREFIX = '/recruitment/candidates';

/** Somebody who may read candidates and nothing more - a recruiter's assistant. */
const READER: Permission[] = [PERMISSIONS.CANDIDATE_READ];

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
});

describe('the restricted block', () => {
  it('is omitted for a reader, rather than nulled', async () => {
    db.candidate.findFirst.mockResolvedValue(candidateRow());

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: READER });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1` })
      .then((r) => r.json());

    expect(body.data.fullName).toBe('Muhammad Ali');
    expect(body.data).not.toHaveProperty('restricted');
    // Nor anywhere else on the record, under another name.
    expect(JSON.stringify(body)).not.toContain('450000');
    expect(JSON.stringify(body)).not.toContain('Asking above band');
  });

  it('is restored by candidate.manage', async () => {
    db.candidate.findFirst.mockResolvedValue(candidateRow());

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1` })
      .then((r) => r.json());

    expect(body.data.restricted).toEqual({
      currentSalary: 300_000,
      expectedSalary: 450_000,
      salaryCurrency: 'PKR',
      notes: 'Strong portfolio. Asking above band.',
    });
  });

  it('is absent from every row of the list, not just the detail', async () => {
    db.candidate.count.mockResolvedValue(1);
    db.candidate.findMany.mockResolvedValue([candidateRow()]);

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: READER });
    const body = await app.inject({ method: 'GET', url: PREFIX }).then((r) => r.json());

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('restricted');
  });
});

describe('who reaches this plugin at all', () => {
  /*
   * The widest employee-facing grants in the product, including
   * `employee.sensitive.read`. None of them is a candidate grant, and a person
   * who has not been hired is not an employee record.
   */
  it('refuses somebody holding every employee grant and no candidate grant', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: EMPLOYEE });

    for (const url of [PREFIX, `${PREFIX}/board`, `${PREFIX}/cand-1`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(403);
    }
    expect(db.candidate.findFirst).not.toHaveBeenCalled();
    expect(db.candidate.findMany).not.toHaveBeenCalled();
  });
});

describe('the board', () => {
  it('leaves out the two stages somebody has left the pipeline into', async () => {
    db.candidate.findMany.mockResolvedValue([candidateRow()]);

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/board` });

    const where = db.candidate.findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toContainEqual({ stage: { notIn: ['REJECTED', 'WITHDRAWN'] } });
    // Bounded rather than paginated: a board with a "next page" is not a board.
    expect(db.candidate.findMany.mock.calls[0]?.[0]?.take).toBe(400);
  });
});

describe('adding one', () => {
  const INPUT = {
    fullName: 'Muhammad Ali',
    email: 'muhammad.ali@example.com',
    expectedSalary: 450_000,
    notes: 'Strong portfolio.',
  };

  it('refuses a second record for an email already on file, and names who has it', async () => {
    db.candidate.findFirst.mockResolvedValue({
      id: 'cand-1',
      fullName: 'Muhammad Ali',
      reference: 'CAN-0001',
    });

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.email[0]).toContain('CAN-0001');
    expect(db.candidate.create).not.toHaveBeenCalled();
  });

  it('files the candidate against a vacancy in the same action', async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    db.candidate.findMany.mockResolvedValue([{ reference: 'CAN-0001' }]);
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      title: 'Senior Unity Developer',
      reference: 'JOB-0001',
      status: 'OPEN',
    });
    db.candidate.create.mockResolvedValue(candidateRow({ reference: 'CAN-0002' }));

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...INPUT, jobOpeningId: 'job-1' },
    });

    expect(response.statusCode).toBe(201);
    const data = db.candidate.create.mock.calls[0]?.[0]?.data;
    expect(data.reference).toBe('CAN-0002');
    expect(data.stage).toBe('NEW');
    expect(data.applications.create).toMatchObject({ jobOpeningId: 'job-1', stage: 'NEW' });
  });

  it('will not file anybody against an opening that is not taking candidates', async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      title: 'Senior Unity Developer',
      reference: 'JOB-0001',
      status: 'CANCELLED',
    });

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...INPUT, jobOpeningId: 'job-1' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.jobOpeningId).toBeDefined();
    expect(db.candidate.create).not.toHaveBeenCalled();
  });

  /*
   * The audit log is read behind `audit.read`, which is not a candidate grant.
   * What somebody is asking to be paid must not arrive there.
   */
  it('audits the fact of the candidate, and never the restricted block', async () => {
    db.candidate.findFirst.mockResolvedValue(null);
    db.candidate.findMany.mockResolvedValue([]);
    db.candidate.create.mockResolvedValue(candidateRow({ reference: 'CAN-0001' }));

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(auditActions(db)).toEqual(['candidate.created']);
    const logged = JSON.stringify(db.auditLog.create.mock.calls[0]?.[0]?.data);
    expect(logged).not.toContain('450000');
    expect(logged).not.toContain('Strong portfolio');
  });
});

describe('a second application for the same person', () => {
  beforeEach(() => {
    db.candidate.findFirst.mockResolvedValue({
      id: 'cand-1',
      fullName: 'Muhammad Ali',
      reference: 'CAN-0001',
    });
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-2',
      title: 'Technical Artist',
      reference: 'JOB-0002',
      status: 'OPEN',
    });
  });

  it('adds an application rather than a second candidate', async () => {
    db.candidateApplication.findUnique.mockResolvedValue(null);
    db.candidateApplication.create.mockResolvedValue({ id: 'app-2' });
    db.candidateApplication.findMany.mockResolvedValue([{ stage: 'INTERVIEW' }, { stage: 'NEW' }]);
    db.candidate.findUnique.mockResolvedValue({ stage: 'INTERVIEW' });
    db.candidate.findUniqueOrThrow.mockResolvedValue(candidateRow());

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/applications`,
      payload: { jobOpeningId: 'job-2' },
    });

    expect(response.statusCode).toBe(201);
    expect(db.candidate.create).not.toHaveBeenCalled();
    expect(db.candidateApplication.create.mock.calls[0]?.[0]?.data).toMatchObject({
      candidateId: 'cand-1',
      jobOpeningId: 'job-2',
      stage: 'NEW',
    });
  });

  it('refuses the same person for the same vacancy twice', async () => {
    db.candidateApplication.findUnique.mockResolvedValue({ id: 'app-1' });

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/applications`,
      payload: { jobOpeningId: 'job-2' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.candidateApplication.create).not.toHaveBeenCalled();
  });
});

describe('moving an application along the pipeline', () => {
  /** The application as the route reads it, at a stage of the test's choosing. */
  function applicationAt(stage: string) {
    return {
      ...applicationRow({ stage }),
      candidate: { id: 'cand-1', fullName: 'Muhammad Ali', reference: 'CAN-0001' },
      jobOpening: { id: 'job-1', title: 'Senior Unity Developer', reference: 'JOB-0001' },
    };
  }

  beforeEach(() => {
    db.candidateApplication.update.mockResolvedValue({ id: 'app-1' });
    db.candidate.findUniqueOrThrow.mockResolvedValue(candidateRow());
    db.candidate.findUnique.mockResolvedValue({ stage: 'INTERVIEW' });
    db.candidateApplication.findMany.mockResolvedValue([{ stage: 'SELECTED' }]);
  });

  it('refuses HIRED from anywhere but OFFER', async () => {
    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('SCREENING'));

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'HIRED' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.candidateApplication.update).not.toHaveBeenCalled();
  });

  /*
   * Reaching HIRED is a pipeline fact. It is emphatically NOT a hire: no
   * employee row, no login, no payroll. Conversion is its own grant, its own
   * endpoint and a person's decision.
   */
  it('reaches HIRED from OFFER without creating an employee', async () => {
    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('OFFER'));
    db.candidateApplication.findMany.mockResolvedValue([{ stage: 'HIRED' }]);

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'HIRED' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.candidateApplication.update.mock.calls[0]?.[0]?.data.stage).toBe('HIRED');
    expect(db.employee.create).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual(['candidate.stage_changed']);
  });

  it('will not reject somebody without saying why', async () => {
    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('INTERVIEW'));

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'REJECTED' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBeDefined();
    expect(db.candidateApplication.update).not.toHaveBeenCalled();
  });

  it('records a rejection and a withdrawal under their own audit verbs', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });

    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('INTERVIEW'));
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'REJECTED', reason: 'Took another offer elsewhere' },
    });

    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('INTERVIEW'));
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'WITHDRAWN', reason: 'Stopped replying' },
    });

    expect(auditActions(db)).toEqual(['candidate.rejected', 'candidate.withdrawn']);
  });

  it('clears the outcome reason on the way back out of a terminal stage', async () => {
    db.candidateApplication.findFirst.mockResolvedValue(
      applicationAt('REJECTED'),
    );

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'SCREENING' },
    });

    expect(db.candidateApplication.update.mock.calls[0]?.[0]?.data.outcomeReason).toBeNull();
  });

  /*
   * The candidate's summary stage is DERIVED, and derived from all of their
   * applications rather than from the one that just moved: somebody rejected
   * for one role and shortlisted for another is shortlisted.
   */
  it('recomputes the candidate stage from every application they have', async () => {
    db.candidateApplication.findFirst.mockResolvedValue(applicationAt('INTERVIEW'));
    db.candidateApplication.findMany.mockResolvedValue([
      { stage: 'REJECTED' },
      { stage: 'SHORTLISTED' },
    ]);
    db.candidate.findUnique.mockResolvedValue({ stage: 'INTERVIEW' });

    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'SHORTLISTED' },
    });

    expect(db.candidate.update).toHaveBeenCalledWith({
      where: { id: 'cand-1' },
      data: { stage: 'SHORTLISTED' },
    });
  });

  it('is closed to a reader who cannot manage candidates', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: READER });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/applications/app-1/stage`,
      payload: { stage: 'SHORTLISTED' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.candidateApplication.update).not.toHaveBeenCalled();
  });
});

describe('the timeline', () => {
  beforeEach(() => {
    db.candidate.findFirst.mockResolvedValue({
      id: 'cand-1',
      fullName: 'Muhammad Ali',
      createdAt: NOW,
      hiredAt: null,
      hiredEmployeeId: null,
    });
    db.candidateApplication.findMany.mockResolvedValue([
      {
        appliedAt: NOW,
        stageChangedAt: new Date('2026-09-19T05:00:00.000Z'),
        stage: 'INTERVIEW',
        outcomeReason: null,
        jobOpening: { title: 'Senior Unity Developer' },
      },
    ]);
    db.interview.findMany.mockResolvedValue([]);
    db.offer.findMany.mockResolvedValue([
      {
        createdAt: NOW,
        proposedTitle: 'Senior Unity Developer',
        proposedSalary: 380_000,
        status: 'DRAFT',
        sentAt: null,
        respondedAt: null,
      },
    ]);
    db.candidateDocument.findMany.mockResolvedValue([]);
    db.interviewScheduleChange.findMany.mockResolvedValue([]);
    db.interviewEvaluation.findMany.mockResolvedValue([]);
  });

  it('hides confidential files from a reader by the query, not afterwards', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: READER });
    await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/timeline` });

    expect(db.candidateDocument.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      isConfidential: false,
    });
  });

  it('shows a manager every file', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/timeline` });

    expect(db.candidateDocument.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty(
      'isConfidential',
    );
  });

  /** An offer's figure is a restricted value; the timeline is not a way round it. */
  it('names the offer without carrying its salary', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1/timeline` })
      .then((r) => r.json());

    const offer = body.data.find((entry: { kind: string }) => entry.kind === 'OFFER_CREATED');
    expect(offer.detail).toBe('Senior Unity Developer');
    expect(JSON.stringify(body)).not.toContain('380000');
  });

  it('is sorted oldest first, whatever order the tables answered in', async () => {
    const app = await appAs(candidateRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1/timeline` })
      .then((r) => r.json());

    const times = body.data.map((entry: { at: string }) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
    expect(body.data[0].kind).toBe('CANDIDATE_CREATED');
  });
});
