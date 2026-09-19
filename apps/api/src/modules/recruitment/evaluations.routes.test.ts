import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Interview evaluations.
 *
 * ONE SEAT, ONE EVALUATION, AND NOBODY OVERWRITES ANYBODY. Every write is
 * addressed by the caller's OWN participant row, resolved from the session, so
 * there is no request shape that files an opinion in somebody else's name or
 * edits theirs. Submitting twice revises your own.
 *
 * FEEDBACK COMES AFTER THE INTERVIEW - COMPLETED or NO_SHOW, nothing else. An
 * interview that has not happened has nothing to evaluate; "they did not turn
 * up" is itself feedback and has somewhere to go.
 *
 * AND AN EVALUATION IS ADVICE, NOT ARITHMETIC. Nothing here averages a score,
 * ranks anybody or moves a stage. A panel that disagrees produces a visible
 * disagreement, which is the useful outcome.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { evaluationRoutes } = await import('./evaluations.routes.js');
const {
  AHMED,
  HR,
  INTERVIEWER,
  NOW,
  ZOHAIB,
  appAs,
  auditActions,
  evaluationRow,
  useRecruitmentDb,
  wirePeople,
} = kit;

const PREFIX = '/recruitment/interviews';

const SCORES = {
  technicalScore: 8,
  problemSolvingScore: 7,
  experienceScore: 8,
  cultureFitScore: 9,
  recommendation: 'YES',
  comments: 'Knows the engine. Weak on tooling.',
};

/** The interview as `interviewOrThrow` selects it. */
function interviewAt(status: string) {
  return { id: 'int-1', status, candidateId: 'cand-1', startsAt: NOW };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.candidate.findUniqueOrThrow.mockResolvedValue({
    fullName: 'Muhammad Ali',
    reference: 'CAN-0001',
  });
  db.interview.findUniqueOrThrow.mockResolvedValue({ type: 'TECHNICAL' });
});

describe('filing your own', () => {
  beforeEach(() => {
    db.interview.findFirst.mockResolvedValue(interviewAt('COMPLETED'));
    db.interviewParticipant.findFirst.mockResolvedValue({
      id: `part-${AHMED.id}`,
      employeeId: AHMED.id,
    });
    db.interviewEvaluation.findUnique.mockResolvedValue(null);
    db.interviewEvaluation.upsert.mockResolvedValue(evaluationRow(AHMED));
  });

  it('addresses the caller’s own seat, found from the session', async () => {
    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    expect(response.statusCode).toBe(201);
    expect(db.interviewParticipant.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      interviewId: 'int-1',
      employeeId: AHMED.id,
    });
    expect(db.interviewEvaluation.upsert.mock.calls[0]?.[0]?.where).toEqual({
      participantId: `part-${AHMED.id}`,
    });
  });

  /*
   * The seat is the only address there is. A body naming another participant,
   * another employee or another interview changes nothing about which row is
   * written, because none of those values is read.
   */
  it('ignores a body that tries to file in somebody else’s name', async () => {
    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: { ...SCORES, participantId: `part-${ZOHAIB.id}`, interviewerEmployeeId: ZOHAIB.id },
    });

    expect(db.interviewEvaluation.upsert.mock.calls[0]?.[0]?.where).toEqual({
      participantId: `part-${AHMED.id}`,
    });
    const written = db.interviewEvaluation.upsert.mock.calls[0]?.[0]?.create;
    expect(written.participantId).toBe(`part-${AHMED.id}`);
  });

  it('revises rather than duplicating when the same person submits again', async () => {
    db.interviewEvaluation.findUnique.mockResolvedValue({ id: 'eval-1' });

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    // 200, not 201: nothing new came into existence.
    expect(response.statusCode).toBe(200);
    expect(db.interviewEvaluation.create).not.toHaveBeenCalled();
    expect(db.interviewEvaluation.upsert.mock.calls[0]?.[0]?.update.submittedAt).toBeInstanceOf(
      Date,
    );
    expect(db.auditLog.create.mock.calls[0]?.[0]?.data.after.revised).toBe(true);
  });

  it('refuses somebody who was not on the panel', async () => {
    db.interviewParticipant.findFirst.mockResolvedValue(null);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: HR,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    // 403 rather than 404: the caller may READ this interview, so its existence
    // is not the secret. What they may not do is have an opinion in it.
    expect(response.statusCode).toBe(403);
    expect(db.interviewEvaluation.upsert).not.toHaveBeenCalled();
  });

  it('refuses a login with no employee record, which has no seat anywhere', async () => {
    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: HR,
      userId: 'user-ghost',
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    expect(response.statusCode).toBe(403);
    expect(db.interviewEvaluation.upsert).not.toHaveBeenCalled();
  });

  /*
   * The written opinion of a named person is exactly what section 23 means by
   * sensitive detail that does not belong in a log read behind another grant.
   */
  it('audits the recommendation and the fact of the scores, never the comments', async () => {
    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    expect(auditActions(db)).toEqual(['interview.evaluation_created']);
    const after = db.auditLog.create.mock.calls[0]?.[0]?.data.after;
    expect(after).toEqual({ recommendation: 'YES', scored: 4, revised: false });
    expect(JSON.stringify(after)).not.toContain('Weak on tooling');
  });

  it('moves nobody’s stage and averages nothing', async () => {
    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'POST', url: `${PREFIX}/int-1/evaluations`, payload: SCORES })
      .then((r) => r.json());

    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(db.candidateApplication.update).not.toHaveBeenCalled();
    expect(db.interview.update).not.toHaveBeenCalled();
    expect(body.data).not.toHaveProperty('averageScore');
    expect(body.data).not.toHaveProperty('rank');
  });
});

describe('when feedback may be filed', () => {
  beforeEach(() => {
    db.interviewParticipant.findFirst.mockResolvedValue({
      id: `part-${AHMED.id}`,
      employeeId: AHMED.id,
    });
    db.interviewEvaluation.findUnique.mockResolvedValue(null);
    db.interviewEvaluation.upsert.mockResolvedValue(evaluationRow(AHMED));
  });

  it('refuses an interview that has not happened yet', async () => {
    db.interview.findFirst.mockResolvedValue(interviewAt('SCHEDULED'));

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('marked complete');
    expect(db.interviewEvaluation.upsert).not.toHaveBeenCalled();
  });

  /** "They did not turn up" is feedback, and needs somewhere to go. */
  it('accepts one against a no-show', async () => {
    db.interview.findFirst.mockResolvedValue(interviewAt('NO_SHOW'));

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: { ...SCORES, recommendation: 'NO' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('answers 404 on an interview the caller cannot read at all', async () => {
    db.interview.findFirst.mockResolvedValue(null);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: ZOHAIB.userId,
    });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/evaluations`,
      payload: SCORES,
    });

    expect(response.statusCode).toBe(404);
    expect(db.interviewParticipant.findFirst).not.toHaveBeenCalled();
  });
});

describe('reading the panel’s feedback', () => {
  it('names who has not filed, rather than leaving a gap', async () => {
    db.interview.findFirst.mockResolvedValue(interviewAt('COMPLETED'));
    db.interviewEvaluation.findMany.mockResolvedValue([evaluationRow(AHMED)]);
    db.interviewParticipant.findMany.mockResolvedValue([
      {
        employeeId: ZOHAIB.id,
        employee: { id: ZOHAIB.id, firstName: ZOHAIB.firstName, lastName: ZOHAIB.lastName },
      },
    ]);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/int-1/evaluations` })
      .then((r) => r.json());

    expect(body.data.evaluations).toHaveLength(1);
    // A missing evaluation is an absence with a name on it, never a row of
    // zeros - the two must not render the same way.
    expect(body.data.pending).toEqual([
      { employeeId: ZOHAIB.id, fullName: 'Muhammad Zohaib' },
    ]);
  });

  it('marks the caller’s own evaluation as theirs', async () => {
    db.interview.findFirst.mockResolvedValue(interviewAt('COMPLETED'));
    db.interviewEvaluation.findMany.mockResolvedValue([
      evaluationRow(AHMED),
      evaluationRow(ZOHAIB),
    ]);
    db.interviewParticipant.findMany.mockResolvedValue([]);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/int-1/evaluations` })
      .then((r) => r.json());

    const mine = body.data.evaluations.filter((row: { isMine: boolean }) => row.isMine);
    expect(mine).toHaveLength(1);
    expect(mine[0].interviewerEmployeeId).toBe(AHMED.id);
  });

  it('refuses the evaluations on an interview the caller was not part of', async () => {
    db.interview.findFirst.mockResolvedValue(null);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: ZOHAIB.userId,
    });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/int-1/evaluations`,
    });

    expect(response.statusCode).toBe(404);
    expect(db.interviewEvaluation.findMany).not.toHaveBeenCalled();
  });
});

describe('everything one candidate was told', () => {
  beforeEach(() => {
    db.candidate.findFirst.mockResolvedValue({ id: 'cand-1' });
  });

  it('shows an interviewer only the rounds they sat', async () => {
    db.interview.findMany.mockResolvedValue([]);

    const app = await appAs(evaluationRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/by-candidate/cand-1` })
      .then((r) => r.json());

    expect(body.data).toEqual([]);
    expect(db.interview.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      participants: { some: { employeeId: AHMED.id } },
    });
    // Nothing was visible, so nothing was fetched.
    expect(db.interviewEvaluation.findMany).not.toHaveBeenCalled();
  });

  it('shows HR all of them', async () => {
    db.interview.findMany.mockResolvedValue([
      { id: 'int-1', type: 'TECHNICAL', round: 'ROUND_1', startsAt: NOW, status: 'COMPLETED' },
    ]);
    db.interviewEvaluation.findMany.mockResolvedValue([evaluationRow(ZOHAIB)]);

    const app = await appAs(evaluationRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/by-candidate/cand-1` })
      .then((r) => r.json());

    expect(db.interview.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('participants');
    expect(body.data[0].interviewType).toBe('TECHNICAL');
    expect(body.data[0].interviewerName).toBe('Muhammad Zohaib');
  });

  it('carries feedback and nothing about the candidate’s money', async () => {
    db.interview.findMany.mockResolvedValue([
      { id: 'int-1', type: 'TECHNICAL', round: 'ROUND_1', startsAt: NOW, status: 'COMPLETED' },
    ]);
    db.interviewEvaluation.findMany.mockResolvedValue([evaluationRow(AHMED)]);

    const app = await appAs(evaluationRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/by-candidate/cand-1` })
      .then((r) => r.json());

    for (const key of ['currentSalary', 'expectedSalary', 'notes', 'documents']) {
      expect(body.data[0]).not.toHaveProperty(key);
    }
  });
});
