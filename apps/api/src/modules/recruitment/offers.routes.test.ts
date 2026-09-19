import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Offers.
 *
 * Deliberately thin, and the tests are mostly about what it does NOT do. An
 * offer is a record of what was proposed; accepting one creates no employee, no
 * salary row, no payroll profile and no contract. A new hire's pay is still set
 * in payroll, by a person, after they exist.
 *
 * Three rules beyond that:
 *
 *   - `recruitment.offer.manage` is its own grant. Somebody who runs
 *     recruitment is not thereby somebody who may make a commitment about
 *     money, so `recruitment.manage` alone is refused;
 *   - one live offer per candidate. Two open offers to the same person is not a
 *     scenario, it is two different promises about salary;
 *   - a SENT offer is not editable. The candidate has seen terms, and rewriting
 *     the record would leave no trace of what they were actually promised.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { offerRoutes } = await import('./offers.routes.js');
const { HR, appAs, auditActions, offerRow, useRecruitmentDb, wirePeople } = kit;

const PREFIX = '/recruitment/offers';

/** Runs recruitment, but makes no offers. */
const COORDINATOR: Permission[] = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.CANDIDATE_READ,
  PERMISSIONS.CANDIDATE_MANAGE,
];

const INPUT = {
  candidateId: 'cand-1',
  proposedTitle: 'Senior Unity Developer',
  employmentType: 'FULL_TIME',
  proposedSalary: 380_000,
  expectedJoiningDate: '2026-10-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.candidate.findFirst.mockResolvedValue({
    id: 'cand-1',
    fullName: 'Muhammad Ali',
    reference: 'CAN-0001',
  });
  db.offer.findFirst.mockResolvedValue(null);
  db.offer.create.mockResolvedValue(offerRow());
});

describe('who may make one', () => {
  it('refuses somebody who runs recruitment but holds no offer grant', async () => {
    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: COORDINATOR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(403);
    expect(db.offer.create).not.toHaveBeenCalled();
  });

  it('still lets them read the list', async () => {
    db.offer.count.mockResolvedValue(1);
    db.offer.findMany.mockResolvedValue([offerRow()]);

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: COORDINATOR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });
});

describe('drafting one', () => {
  it('starts as a DRAFT and defaults the new hire to probation', async () => {
    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(201);
    const data = db.offer.create.mock.calls[0]?.[0]?.data;
    expect(data.status).toBe('DRAFT');
    // Section 17's default, from the canonical employment-status enum. There is
    // no second status vocabulary anywhere in recruitment.
    expect(data.employmentStatus).toBe('PROBATION');
    expect(data.expectedJoiningDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('refuses a second live offer to the same person', async () => {
    db.offer.findFirst.mockResolvedValue({ id: 'offer-1', status: 'SENT' });

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Answer or withdraw');
    expect(db.offer.create).not.toHaveBeenCalled();
  });

  /*
   * The figure is the sensitive part, and the audit log is read behind
   * `audit.read` rather than behind `recruitment.offer.manage`. The fact of the
   * offer is logged; the money stays on the offer.
   */
  it('audits the terms and never the salary', async () => {
    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'POST', url: PREFIX, payload: INPUT });

    expect(auditActions(db)).toEqual(['offer.created']);
    const after = db.auditLog.create.mock.calls[0]?.[0]?.data.after;
    expect(after.salaryProposed).toBe(true);
    expect(JSON.stringify(after)).not.toContain('380000');
  });

  it('will not make an offer against a closed vacancy', async () => {
    db.jobOpening.findFirst.mockResolvedValue({ id: 'job-1', status: 'CLOSED' });

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...INPUT, jobOpeningId: 'job-1' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.jobOpeningId).toBeDefined();
  });
});

describe('editing one', () => {
  it('allows it while it is a draft', async () => {
    db.offer.findFirst.mockResolvedValue({
      ...offerRow(),
      candidate: { fullName: 'Muhammad Ali' },
    });
    db.offer.update.mockResolvedValue(offerRow({ proposedSalary: 400_000 }));

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/offer-1`,
      payload: { proposedSalary: 400_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(db.offer.update.mock.calls[0]?.[0]?.data.proposedSalary).toBe(400_000);
  });

  it('refuses once the candidate has seen it', async () => {
    db.offer.findFirst.mockResolvedValue({
      ...offerRow({ status: 'SENT' }),
      candidate: { fullName: 'Muhammad Ali' },
    });

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/offer-1`,
      payload: { proposedSalary: 400_000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Make a new offer');
    expect(db.offer.update).not.toHaveBeenCalled();
  });
});

describe('sending it, and the answer', () => {
  function stored(status: string, applicationId: string | null = 'app-1') {
    return {
      ...offerRow({ status, applicationId }),
      candidate: { id: 'cand-1', fullName: 'Muhammad Ali', reference: 'CAN-0001' },
    };
  }

  it('refuses an acceptance of something nobody sent', async () => {
    db.offer.findFirst.mockResolvedValue(stored('DRAFT'));

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/offer-1/status`,
      payload: { status: 'ACCEPTED' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.offer.update).not.toHaveBeenCalled();
  });

  it('nudges the application to OFFER when the offer goes out, and only forward', async () => {
    db.offer.findFirst.mockResolvedValue(stored('DRAFT'));
    db.offer.update.mockResolvedValue(offerRow({ status: 'SENT' }));
    db.candidateApplication.updateMany.mockResolvedValue({ count: 1 });
    db.candidate.updateMany.mockResolvedValue({ count: 1 });

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/offer-1/status`,
      payload: { status: 'SENT' },
    });

    const where = db.candidateApplication.updateMany.mock.calls[0]?.[0]?.where;
    // Bounded by the stages it may move FROM, so an offer marked sent can never
    // drag somebody back out of HIRED.
    expect(where.stage.in).toEqual(['NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED']);
    expect(db.offer.update.mock.calls[0]?.[0]?.data.sentAt).toBeInstanceOf(Date);
  });

  /*
   * Section 15, the whole of it. Accepting an offer is a fact about a
   * conversation, not the creation of a member of staff.
   */
  it('creates absolutely nothing when the offer is accepted', async () => {
    db.offer.findFirst.mockResolvedValue(stored('SENT'));
    db.offer.update.mockResolvedValue(offerRow({ status: 'ACCEPTED' }));

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/offer-1/status`,
      payload: { status: 'ACCEPTED' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.employee.create).not.toHaveBeenCalled();
    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(db.candidateApplication.updateMany).not.toHaveBeenCalled();
    expect(db.offer.update.mock.calls[0]?.[0]?.data.respondedAt).toBeInstanceOf(Date);
    expect(auditActions(db)).toEqual(['offer.accepted']);
  });

  it('keeps the reason under the existing note rather than replacing it', async () => {
    db.offer.findFirst.mockResolvedValue({
      ...stored('SENT'),
      notes: 'Agreed verbally on Tuesday.',
    });
    db.offer.update.mockResolvedValue(offerRow({ status: 'DECLINED' }));

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/offer-1/status`,
      payload: { status: 'DECLINED', reason: 'Took a counter-offer' },
    });

    expect(db.offer.update.mock.calls[0]?.[0]?.data.notes).toBe(
      'Agreed verbally on Tuesday.\n\nTook a counter-offer',
    );
    expect(auditActions(db)).toEqual(['offer.declined']);
  });

  it('refuses a move to the status it already has', async () => {
    db.offer.findFirst.mockResolvedValue(stored('SENT'));

    const app = await appAs(offerRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/offer-1/status`,
      payload: { status: 'SENT' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.offer.update).not.toHaveBeenCalled();
  });
});
