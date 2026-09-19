import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Job openings.
 *
 * What is pinned here is the gap between the two grants, because that gap is
 * the whole design of the plugin:
 *
 *   - `recruitment.read` ALONE returns the openings the caller is named on.
 *     The narrowing is a WHERE clause, so the test asserts the clause rather
 *     than the response - a filter applied after the query would pass a test
 *     that counted rows and would still have fetched them;
 *   - a caller with no employee record is named on nothing, and the route must
 *     not read that as "no filter". The expensive version of this bug returns
 *     every vacancy in the company;
 *   - `recruitment.manage` is required for every write, and a hiring manager
 *     holding the read grant is refused;
 *   - closing or cancelling needs a REASON and gets its own audit verb, and
 *     re-opening clears the reason so it never outlives the ending it explains;
 *   - the pipeline is reachable on `recruitment.read` and carries no restricted
 *     candidate field at all, which is what lets a hiring manager see their own
 *     board without being told what anybody on it earns.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { jobOpeningRoutes } = await import('./job-openings.routes.js');
const {
  AHMED,
  HR,
  HR_USER,
  MANAGER,
  appAs,
  auditActions,
  jobOpeningRow,
  useRecruitmentDb,
  wirePeople,
} = kit;

const PREFIX = '/recruitment/job-openings';

/** The AND array the route hands Prisma, flattened for reading. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function andClauses(where: any): any[] {
  return (where?.AND ?? []) as unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.candidateApplication.groupBy.mockResolvedValue([]);
  db.candidateApplication.count.mockResolvedValue(0);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
});

describe('who sees which openings', () => {
  it('narrows a hiring manager to the openings they are named on', async () => {
    db.jobOpening.count.mockResolvedValue(1);
    db.jobOpening.findMany.mockResolvedValue([jobOpeningRow()]);

    const app = await appAs(jobOpeningRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);

    const where = db.jobOpening.findMany.mock.calls[0]?.[0]?.where;
    expect(andClauses(where)).toContainEqual({
      OR: [{ hiringManagerId: AHMED.id }, { recruiterId: AHMED.id }],
    });
  });

  it('applies no such clause for HR, who runs recruitment', async () => {
    db.jobOpening.count.mockResolvedValue(1);
    db.jobOpening.findMany.mockResolvedValue([jobOpeningRow()]);

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: PREFIX });

    const where = db.jobOpening.findMany.mock.calls[0]?.[0]?.where;
    const named = andClauses(where).filter((clause) => 'OR' in (clause as object));
    expect(named).toHaveLength(0);
  });

  /*
   * The one that would be expensive to get wrong. `jobOpeningFilter` returns
   * null for "no rows", and a caller who read that as "no filter" would hand
   * every vacancy in the company to a login that is not linked to anybody.
   */
  it('returns nothing, and asks nothing, for a login with no employee record', async () => {
    const app = await appAs(jobOpeningRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: 'user-ghost',
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(response.json().meta.total).toBe(0);
    expect(db.jobOpening.findMany).not.toHaveBeenCalled();
    expect(db.jobOpening.count).not.toHaveBeenCalled();
  });

  it('answers 404 for an opening outside the caller’s own', async () => {
    db.jobOpening.findFirst.mockResolvedValue(null);

    const app = await appAs(jobOpeningRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/job-9` });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('counts the hires against each opening in one query, not one per row', async () => {
    db.jobOpening.count.mockResolvedValue(2);
    db.jobOpening.findMany.mockResolvedValue([
      jobOpeningRow(),
      jobOpeningRow({ id: 'job-2', reference: 'JOB-0002' }),
    ]);
    db.candidateApplication.groupBy.mockResolvedValue([
      { jobOpeningId: 'job-1', _count: { _all: 1 } },
    ]);

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app.inject({ method: 'GET', url: PREFIX }).then((r) => r.json());

    expect(db.candidateApplication.groupBy).toHaveBeenCalledTimes(1);
    expect(body.data[0].hiredCount).toBe(1);
    expect(body.data[1].hiredCount).toBe(0);
    // Two vacancies on the opening, one of them filled. Both figures travel.
    expect(body.data[0].vacancies).toBe(2);
  });
});

describe('creating one', () => {
  const INPUT = {
    title: 'Senior Unity Developer',
    departmentId: 'dept-dev',
    hiringManagerId: AHMED.id,
    recruiterId: HR_USER.id,
    vacancies: 2,
    status: 'OPEN',
  };

  beforeEach(() => {
    db.department.findFirst.mockResolvedValue({ id: 'dept-dev' });
    db.jobOpening.findMany.mockResolvedValue([{ reference: 'JOB-0001' }, { reference: 'JOB-0009' }]);
  });

  it('allocates the next reference in the company sequence and audits the creation', async () => {
    db.jobOpening.create.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { reference: string } }).data;
      return jobOpeningRow({ reference: data.reference });
    });

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(201);
    // Derived from the HIGHEST issued, not from a row count: deleting JOB-0005
    // must not make the next create collide with JOB-0009.
    expect(response.json().data.reference).toBe('JOB-0010');
    expect(auditActions(db)).toEqual(['job_opening.created']);
  });

  it('retries on the unique index rather than failing the request', async () => {
    const collision = Object.assign(new Error('unique'), { code: 'P2002' });
    db.jobOpening.create
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce(jobOpeningRow({ reference: 'JOB-0010' }));

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(201);
    expect(db.jobOpening.create).toHaveBeenCalledTimes(2);
  });

  it('refuses a department from another installation by name', async () => {
    db.department.findFirst.mockResolvedValue(null);

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.departmentId).toBeDefined();
    expect(db.jobOpening.create).not.toHaveBeenCalled();
  });

  it('is closed to a hiring manager, who only reads', async () => {
    const app = await appAs(jobOpeningRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(403);
    expect(db.jobOpening.create).not.toHaveBeenCalled();
  });
});

describe('editing one', () => {
  it('refuses a top of range below the bottom already on the record', async () => {
    db.jobOpening.findFirst.mockResolvedValue(jobOpeningRow());

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/job-1`,
      payload: { salaryMax: 100_000 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.salaryMax).toBeDefined();
    expect(db.jobOpening.update).not.toHaveBeenCalled();
  });

  /*
   * A PATCH says what it changes and nothing else.
   *
   * Every optional field on this form ends in a transform that reads an empty
   * control as null, and a schema that ran those transforms for keys the
   * request never sent would turn "rename the vacancy" into "rename the
   * vacancy and clear its department, its hiring manager and its salary band".
   */
  it('leaves the fields a partial body did not mention alone', async () => {
    db.jobOpening.findFirst.mockResolvedValue(jobOpeningRow());
    db.jobOpening.update.mockResolvedValue(jobOpeningRow({ title: 'Lead Unity Developer' }));

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/job-1`,
      payload: { title: 'Lead Unity Developer' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.jobOpening.update.mock.calls[0]?.[0]?.data).toEqual({
      title: 'Lead Unity Developer',
    });
  });

  /** An emptied control still clears the field - that is what null is for. */
  it('clears a field the form actually emptied', async () => {
    db.jobOpening.findFirst.mockResolvedValue(jobOpeningRow());
    db.jobOpening.update.mockResolvedValue(jobOpeningRow({ teamId: null }));

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/job-1`,
      payload: { teamId: '' },
    });

    expect(db.jobOpening.update.mock.calls[0]?.[0]?.data).toEqual({ teamId: null });
  });

  /*
   * The status is deliberately absent from the edit schema. A reason attached
   * to a general-purpose save is a reason that gets forgotten, so a PATCH
   * carrying one must change nothing about the status.
   */
  it('cannot move the status, even when the body says so', async () => {
    db.jobOpening.findFirst.mockResolvedValue(jobOpeningRow());
    db.jobOpening.update.mockResolvedValue(jobOpeningRow({ title: 'Lead Unity Developer' }));

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/job-1`,
      payload: { title: 'Lead Unity Developer', status: 'CLOSED' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.jobOpening.update.mock.calls[0]?.[0]?.data).not.toHaveProperty('status');
    expect(auditActions(db)).toEqual(['job_opening.updated']);
  });
});

describe('closing, cancelling and re-opening', () => {
  it('will not close an opening without saying why', async () => {
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      reference: 'JOB-0001',
      title: 'Senior Unity Developer',
      status: 'OPEN',
    });

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/job-1/status`,
      payload: { status: 'CLOSED' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBeDefined();
    expect(db.jobOpening.update).not.toHaveBeenCalled();
  });

  it('records the ending, its reason and its own audit verb', async () => {
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      reference: 'JOB-0001',
      title: 'Senior Unity Developer',
      status: 'OPEN',
    });
    db.jobOpening.update.mockResolvedValue(
      jobOpeningRow({ status: 'CLOSED', closedAt: new Date(), closedReason: 'Filled internally' }),
    );

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/job-1/status`,
      payload: { status: 'CLOSED', reason: 'Filled internally' },
    });

    expect(response.statusCode).toBe(200);
    const data = db.jobOpening.update.mock.calls[0]?.[0]?.data;
    expect(data.status).toBe('CLOSED');
    expect(data.closedReason).toBe('Filled internally');
    expect(data.closedAt).toBeInstanceOf(Date);
    // `job_opening.closed` is what an HR report looks for. Buried in a diff of
    // fifteen fields under "updated", it would be worse than not recorded.
    expect(auditActions(db)).toEqual(['job_opening.closed']);
  });

  it('clears the reason on the way back open, so it never outlives the ending', async () => {
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      reference: 'JOB-0001',
      title: 'Senior Unity Developer',
      status: 'CLOSED',
    });
    db.jobOpening.update.mockResolvedValue(jobOpeningRow({ status: 'OPEN' }));

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/job-1/status`,
      payload: { status: 'OPEN' },
    });

    const data = db.jobOpening.update.mock.calls[0]?.[0]?.data;
    expect(data.closedAt).toBeNull();
    expect(data.closedReason).toBeNull();
    expect(auditActions(db)).toEqual(['job_opening.updated']);
  });

  it('refuses to move an opening to the status it already has', async () => {
    db.jobOpening.findFirst.mockResolvedValue({
      id: 'job-1',
      reference: 'JOB-0001',
      title: 'Senior Unity Developer',
      status: 'OPEN',
    });

    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/job-1/status`,
      payload: { status: 'OPEN' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.jobOpening.update).not.toHaveBeenCalled();
  });

  /** Never deleted. The applications filed against a cancelled vacancy stay. */
  it('has no delete route at all', async () => {
    const app = await appAs(jobOpeningRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'DELETE', url: `${PREFIX}/job-1` });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('the pipeline for one opening', () => {
  it('carries names and stages, and no restricted candidate field', async () => {
    db.jobOpening.findFirst.mockResolvedValue({ id: 'job-1' });
    db.candidateApplication.findMany.mockResolvedValue([
      {
        id: 'app-1',
        stage: 'INTERVIEW',
        stageChangedAt: kit.NOW,
        appliedAt: kit.NOW,
        outcomeReason: null,
        candidate: { id: 'cand-1', fullName: 'Muhammad Ali', reference: 'CAN-0001' },
      },
    ]);

    const app = await appAs(jobOpeningRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/job-1/pipeline` })
      .then((r) => r.json());

    expect(body.data[0].candidateName).toBe('Muhammad Ali');
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'applicationId',
      'appliedAt',
      'candidateId',
      'candidateName',
      'candidateReference',
      'outcomeReason',
      'stage',
      'stageChangedAt',
    ]);
  });
});
