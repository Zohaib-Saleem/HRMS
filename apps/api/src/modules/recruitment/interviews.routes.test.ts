import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Interviews: the calendar, and the appointments on it.
 *
 * Four claims carry this file, and each of them is a decision somebody could
 * plausibly reverse without noticing what it cost:
 *
 *   - AN INTERVIEWER SEES THEIR OWN SEATS. `interview.read` alone is narrowed
 *     by a clause on the panel, so the calendar cannot be browsed, the other
 *     candidates for a role cannot be discovered, and a guessed id answers 404
 *     exactly as a made-up one does;
 *   - A CLASH IS A WARNING, NOT A REFUSAL. Booking over one is allowed and is
 *     never silent: the refusal names who is busy and with whom, `allowConflicts`
 *     is how a person overrules it, and the override is written to the audit;
 *   - RESCHEDULING DOES NOT OVERWRITE HISTORY. Same id, same panel, same
 *     evaluations; the old time goes to `interview_schedule_changes` with a
 *     compulsory reason, and every confirmation is dropped because it was given
 *     for a time that no longer exists;
 *   - NOTIFICATION IS NOT DELIVERY. The transport's own answer is passed
 *     through verbatim, so a console mail provider can never be reported as a
 *     delivered email.
 *
 * The time arithmetic is asserted in instants: 10:00 in Karachi is 05:00Z, and
 * a test that checked the strings it sent would have proved nothing.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();
const notify = vi.hoisted(() => vi.fn());

vi.mock('../../core/db.js', () => ({ prisma: db }));
vi.mock('../../core/notifications/notification.service.js', () => ({ notify }));

const { interviewRoutes } = await import('./interviews.routes.js');
const {
  AHMED,
  HR,
  INTERVIEWER,
  NO_LOGIN,
  TIMEZONE,
  ZOHAIB,
  appAs,
  auditActions,
  interviewRow,
  participantRow,
  useRecruitmentDb,
  wirePeople,
} = kit;

const PREFIX = '/recruitment/interviews';

/** 10:00 to 11:00 in Karachi, which is what the schema sends. */
const SLOT = {
  day: '2026-09-18',
  startTime: '10:00',
  endTime: '11:00',
  timezone: TIMEZONE,
};

const CREATE = {
  candidateId: 'cand-1',
  type: 'TECHNICAL',
  round: 'ROUND_1',
  ...SLOT,
  interviewerIds: [AHMED.id],
};

/** One busy panellist, as `findConflicts` reads them out of Prisma. */
function busyRow(person = AHMED) {
  return {
    employeeId: person.id,
    employee: { firstName: person.firstName, lastName: person.lastName },
    interview: {
      id: 'int-other',
      startsAt: new Date('2026-09-18T05:30:00.000Z'),
      endsAt: new Date('2026-09-18T06:30:00.000Z'),
      status: 'SCHEDULED',
      candidate: { fullName: 'Usman Ahmed' },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  notify.mockResolvedValue({ id: 'notif-1', emailStatus: 'skipped', emailProvider: 'console' });
  db.interviewParticipant.findMany.mockResolvedValue([]);
  db.candidate.findFirst.mockResolvedValue({
    id: 'cand-1',
    fullName: 'Muhammad Ali',
    reference: 'CAN-0001',
  });
  db.interview.create.mockResolvedValue(interviewRow());
});

describe('who sees which interviews', () => {
  it('narrows a plain interviewer to the panels they sit on', async () => {
    db.interview.count.mockResolvedValue(1);
    db.interview.findMany.mockResolvedValue([interviewRow()]);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    const where = db.interview.findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toContainEqual({ participants: { some: { employeeId: AHMED.id } } });
  });

  /*
   * The widest possible data scope with the narrow grant. Recruitment is
   * narrowed by NAMED INVOLVEMENT, not by the reporting line - a manager's
   * scope over somebody's employee record is not a reason to read the
   * interviews of people who do not work here.
   */
  it('is not widened by a data scope of ALL', async () => {
    db.interview.count.mockResolvedValue(0);
    db.interview.findMany.mockResolvedValue([]);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
      dataScope: 'ALL',
    });
    await app.inject({ method: 'GET', url: PREFIX });

    const where = db.interview.findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toContainEqual({ participants: { some: { employeeId: AHMED.id } } });
  });

  it('answers 404 for an interview the caller was not invited to', async () => {
    db.interview.findFirst.mockResolvedValue(null);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: ZOHAIB.userId,
    });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/int-1` });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('will not answer the conflicts question for somebody who cannot schedule', async () => {
    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/conflicts?day=2026-09-18&startTime=10:00&endTime=11:00&timezone=${TIMEZONE}&interviewerIds=${ZOHAIB.id}`,
    });

    expect(response.statusCode).toBe(403);
    expect(db.interviewParticipant.findMany).not.toHaveBeenCalled();
  });
});

describe('scheduling one', () => {
  it('turns a day, two wall-clock times and a zone into instants', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: CREATE });

    expect(response.statusCode).toBe(201);
    const data = db.interview.create.mock.calls[0]?.[0]?.data;
    expect(data.startsAt.toISOString()).toBe('2026-09-18T05:00:00.000Z');
    expect(data.endsAt.toISOString()).toBe('2026-09-18T06:00:00.000Z');
    // The zone travels with it, because the appointment is at ten o'clock in
    // Karachi whoever is looking at it.
    expect(data.timezone).toBe(TIMEZONE);
  });

  it('refuses a zone the server does not recognise rather than treating it as UTC', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...CREATE, timezone: 'Mars/Olympus' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.timezone).toBeDefined();
    expect(db.interview.create).not.toHaveBeenCalled();
  });

  it('seats the whole panel, with the lead flagged', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: {
        ...CREATE,
        interviewerIds: [AHMED.id, ZOHAIB.id],
        leadInterviewerId: ZOHAIB.id,
      },
    });

    const seats = db.interview.create.mock.calls[0]?.[0]?.data.participants.create;
    expect(seats).toEqual([
      { companyId: 'company-1', employeeId: AHMED.id, isLead: false },
      { companyId: 'company-1', employeeId: ZOHAIB.id, isLead: true },
    ]);
  });

  it('refuses a clash by default, naming who is busy and with whom', async () => {
    db.interviewParticipant.findMany.mockResolvedValue([busyRow()]);

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: CREATE });

    expect(response.statusCode).toBe(409);
    const error = response.json().error;
    expect(error.message).toContain('Ahmed Khan');
    expect(error.details.conflicts[0]).toContain('Usman Ahmed');
    expect(db.interview.create).not.toHaveBeenCalled();
  });

  it('books over a clash when a person has said to, and records that they did', async () => {
    db.interviewParticipant.findMany.mockResolvedValue([busyRow()]);

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...CREATE, allowConflicts: true },
    });

    expect(response.statusCode).toBe(201);
    expect(db.interview.create).toHaveBeenCalledTimes(1);
    expect(auditActions(db)).toEqual(['interview.created']);
    const logged = db.auditLog.create.mock.calls[0]?.[0]?.data.after;
    expect(logged.bookedOverConflicts).toBe(true);
    // And the response still carries the clashes, so the screen can say so.
    expect(response.json().data.conflicts).toHaveLength(1);
  });

  /*
   * Order of proof. The candidate and the vacancy are proved to be ours before
   * anything is said about anybody's calendar, so a caller probing with foreign
   * ids learns nothing about who is interviewing whom.
   */
  it('refuses a foreign candidate id before it looks at any calendar', async () => {
    db.candidate.findFirst.mockResolvedValue(null);

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: CREATE });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.candidateId).toBeDefined();
    expect(db.interviewParticipant.findMany).not.toHaveBeenCalled();
    expect(db.employee.findMany).not.toHaveBeenCalled();
  });

  it('refuses an interviewer who is not an employee of this company', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...CREATE, interviewerIds: [AHMED.id, 'emp-elsewhere'] },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.interviewerIds).toBeDefined();
    expect(db.interview.create).not.toHaveBeenCalled();
  });

  it('will not arrange an interview against an opening that is not open', async () => {
    db.jobOpening.findFirst.mockResolvedValue({ id: 'job-1', status: 'CLOSED' });

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...CREATE, jobOpeningId: 'job-1' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.jobOpeningId).toBeDefined();
  });

  it('is closed to an interviewer, who reads the calendar and does not write it', async () => {
    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: CREATE });

    expect(response.statusCode).toBe(403);
    expect(db.interview.create).not.toHaveBeenCalled();
  });
});

describe('telling the panel', () => {
  /*
   * Section 21's honesty rule. `unconfirmed` means a transport that logs and
   * drops, and it must arrive at the screen as itself - flattened into "sent",
   * it becomes a cheerful lie on every installation running the console
   * provider.
   */
  it('passes the transport’s own verdict through untouched', async () => {
    notify.mockResolvedValue({
      id: 'notif-1',
      emailStatus: 'unconfirmed',
      emailProvider: 'console',
    });

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'POST', url: PREFIX, payload: CREATE })
      .then((r) => r.json());

    expect(body.data.notified).toBe(1);
    expect(body.data.emailStatus).toBe('unconfirmed');
    expect(body.data.emailProvider).toBe('console');
  });

  it('reports the worst answer across the panel, not the happiest', async () => {
    notify
      .mockResolvedValueOnce({ id: 'n1', emailStatus: 'delivered', emailProvider: 'smtp' })
      .mockResolvedValueOnce({ id: 'n2', emailStatus: 'failed', emailProvider: 'smtp' });

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({
        method: 'POST',
        url: PREFIX,
        payload: { ...CREATE, interviewerIds: [AHMED.id, ZOHAIB.id] },
      })
      .then((r) => r.json());

    expect(body.data.notified).toBe(2);
    expect(body.data.emailStatus).toBe('failed');
  });

  /** A panellist with no login is unreachable. The interview still happens. */
  it('still books the interview when somebody on the panel has no login', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { ...CREATE, interviewerIds: [AHMED.id, NO_LOGIN.id] },
    });

    expect(response.statusCode).toBe(201);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(response.json().data.notified).toBe(1);
  });

  it('does not fail the booking when notification throws', async () => {
    notify.mockRejectedValue(new Error('the relay is down'));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'POST', url: PREFIX, payload: CREATE });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.notified).toBe(0);
  });
});

describe('moving one to a new time', () => {
  const RESCHEDULE = {
    day: '2026-09-18',
    startTime: '14:00',
    endTime: '15:00',
    timezone: TIMEZONE,
    reason: 'The interviewer is travelling',
  };

  function before(overrides: Record<string, unknown> = {}) {
    return {
      ...interviewRow(overrides),
      candidate: { fullName: 'Muhammad Ali' },
      jobOpening: { title: 'Senior Unity Developer' },
      participants: [{ employeeId: AHMED.id }],
    };
  }

  beforeEach(() => {
    db.interview.findFirst.mockResolvedValue(before());
    db.interview.update.mockResolvedValue(interviewRow({ status: 'RESCHEDULED' }));
    db.interviewScheduleChange.create.mockResolvedValue({ id: 'chg-1' });
  });

  it('keeps the appointment and writes where it came from', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/reschedule`,
      payload: RESCHEDULE,
    });

    expect(response.statusCode).toBe(200);

    const history = db.interviewScheduleChange.create.mock.calls[0]?.[0]?.data;
    expect(history.interviewId).toBe('int-1');
    expect(history.previousStartsAt.toISOString()).toBe('2026-09-18T05:00:00.000Z');
    expect(history.newStartsAt.toISOString()).toBe('2026-09-18T09:00:00.000Z');
    expect(history.reason).toBe('The interviewer is travelling');

    // Same row, moved. Not a new interview, so the panel and the evaluations
    // that already exist stay attached to it.
    expect(db.interview.update.mock.calls[0]?.[0]?.where).toEqual({ id: 'int-1' });
    expect(db.interview.create).not.toHaveBeenCalled();
  });

  it('drops every confirmation, because they were given for the old time', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/reschedule`,
      payload: RESCHEDULE,
    });

    const data = db.interview.update.mock.calls[0]?.[0]?.data;
    expect(data.status).toBe('RESCHEDULED');
    expect(data.participants).toEqual({
      updateMany: { where: {}, data: { confirmedAt: null } },
    });
  });

  it('refuses to move a cancelled interview', async () => {
    db.interview.findFirst.mockResolvedValue(before({ status: 'CANCELLED' }));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/reschedule`,
      payload: RESCHEDULE,
    });

    expect(response.statusCode).toBe(409);
    expect(db.interviewScheduleChange.create).not.toHaveBeenCalled();
  });

  it('refuses a move to the time it is already at', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/reschedule`,
      payload: { ...RESCHEDULE, startTime: '10:00', endTime: '11:00' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.interview.update).not.toHaveBeenCalled();
  });

  it('tells the panel both times', async () => {
    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/reschedule`,
      payload: RESCHEDULE,
    });

    const sent = notify.mock.calls[0]?.[0];
    expect(sent.type).toBe('INTERVIEW_RESCHEDULED');
    expect(sent.message).toContain('Originally');
    expect(sent.message).toContain('The interviewer is travelling');
  });
});

describe('the status workflow', () => {
  function before(status: string) {
    return {
      ...interviewRow({ status }),
      candidate: { fullName: 'Muhammad Ali' },
      jobOpening: { title: 'Senior Unity Developer' },
      participants: [{ employeeId: AHMED.id }],
    };
  }

  beforeEach(() => {
    db.interview.update.mockResolvedValue(interviewRow({ status: 'COMPLETED' }));
  });

  it('will not cancel without a reason', async () => {
    db.interview.findFirst.mockResolvedValue(before('SCHEDULED'));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/status`,
      payload: { status: 'CANCELLED' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.reason).toBeDefined();
    expect(db.interview.update).not.toHaveBeenCalled();
  });

  it('refuses a move the workflow does not allow', async () => {
    db.interview.findFirst.mockResolvedValue(before('CANCELLED'));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/status`,
      payload: { status: 'COMPLETED' },
    });

    expect(response.statusCode).toBe(409);
    expect(db.interview.update).not.toHaveBeenCalled();
  });

  it('prompts the panel for their feedback when the interview is marked complete', async () => {
    db.interview.findFirst.mockResolvedValue(before('CONFIRMED'));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/status`,
      payload: { status: 'COMPLETED' },
    });

    expect(db.interview.update.mock.calls[0]?.[0]?.data.completedAt).toBeInstanceOf(Date);
    expect(auditActions(db)).toEqual(['interview.completed']);
    expect(notify.mock.calls[0]?.[0]?.type).toBe('INTERVIEW_EVALUATION_PENDING');
  });

  /** The panel confirmed it themselves. Telling them about it is noise. */
  it('sends nothing at all when the panel confirms', async () => {
    db.interview.findFirst.mockResolvedValue(before('SCHEDULED'));
    db.interview.update.mockResolvedValue(interviewRow({ status: 'CONFIRMED' }));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/status`,
      payload: { status: 'CONFIRMED' },
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps a cancelled interview rather than deleting it', async () => {
    db.interview.findFirst.mockResolvedValue(before('SCHEDULED'));
    db.interview.update.mockResolvedValue(interviewRow({ status: 'CANCELLED' }));

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/int-1/status`,
      payload: { status: 'CANCELLED', reason: 'The candidate withdrew' },
    });

    const data = db.interview.update.mock.calls[0]?.[0]?.data;
    expect(data.cancelledReason).toBe('The candidate withdrew');
    expect(data.cancelledAt).toBeInstanceOf(Date);
    expect(auditActions(db)).toEqual(['interview.cancelled']);
    expect(notify.mock.calls[0]?.[0]?.type).toBe('INTERVIEW_CANCELLED');
  });
});

describe('a panellist confirming', () => {
  beforeEach(() => {
    db.interviewParticipant.update.mockResolvedValue({ id: 'part-1' });
    db.interview.findUniqueOrThrow.mockResolvedValue(interviewRow());
  });

  it('reaches exactly one row - the caller’s own seat', async () => {
    db.interviewParticipant.findFirst.mockResolvedValue({
      id: `part-${AHMED.id}`,
      interview: { id: 'int-1', status: 'SCHEDULED' },
    });
    db.interviewParticipant.count.mockResolvedValue(1);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'POST', url: `${PREFIX}/int-1/confirm` });

    expect(response.statusCode).toBe(200);
    expect(db.interviewParticipant.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      interviewId: 'int-1',
      employeeId: AHMED.id,
    });
    expect(db.interviewParticipant.update.mock.calls[0]?.[0]?.where).toEqual({
      id: `part-${AHMED.id}`,
    });
  });

  /*
   * One person saying yes does not settle the appointment. Flipping the status
   * on the first confirmation tells a coordinator the panel is ready while two
   * of three have not answered.
   */
  it('leaves the interview unconfirmed while a seat is outstanding', async () => {
    db.interviewParticipant.findFirst.mockResolvedValue({
      id: `part-${AHMED.id}`,
      interview: { id: 'int-1', status: 'SCHEDULED' },
    });
    db.interviewParticipant.count.mockResolvedValue(1);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    await app.inject({ method: 'POST', url: `${PREFIX}/int-1/confirm` });

    expect(db.interview.update).not.toHaveBeenCalled();
  });

  it('confirms the interview once the last seat answers', async () => {
    db.interviewParticipant.findFirst.mockResolvedValue({
      id: `part-${AHMED.id}`,
      interview: { id: 'int-1', status: 'SCHEDULED' },
    });
    db.interviewParticipant.count.mockResolvedValue(0);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    await app.inject({ method: 'POST', url: `${PREFIX}/int-1/confirm` });

    expect(db.interview.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { status: 'CONFIRMED' },
    });
  });

  it('answers 404 to somebody with no seat on it', async () => {
    db.interviewParticipant.findFirst.mockResolvedValue(null);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: ZOHAIB.userId,
    });
    const response = await app.inject({ method: 'POST', url: `${PREFIX}/int-1/confirm` });

    expect(response.statusCode).toBe(404);
    expect(db.interviewParticipant.update).not.toHaveBeenCalled();
  });
});

describe('editing the panel', () => {
  function before(participants: Array<{ id: string; employeeId: string }>) {
    return {
      ...interviewRow(),
      candidate: { fullName: 'Muhammad Ali' },
      participants,
    };
  }

  it('refuses to drop somebody who has already filed an evaluation', async () => {
    db.interview.findFirst.mockResolvedValue(
      before([
        { id: 'part-1', employeeId: AHMED.id },
        { id: 'part-2', employeeId: ZOHAIB.id },
      ]),
    );
    db.interviewEvaluation.count.mockResolvedValue(1);

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/int-1`,
      payload: { interviewerIds: [AHMED.id] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('evaluation');
    expect(db.interviewParticipant.deleteMany).not.toHaveBeenCalled();
  });

  /*
   * Only the people being ADDED are checked. Somebody already on this panel
   * clashes with this interview, which is not a clash - reporting it would make
   * every panel edit look like a double-booking.
   */
  it('checks only the interviewers being added for a clash', async () => {
    db.interview.findFirst.mockResolvedValue(before([{ id: 'part-1', employeeId: AHMED.id }]));
    db.interviewEvaluation.count.mockResolvedValue(0);
    db.interviewParticipant.create.mockResolvedValue({ id: 'part-2' });
    db.interview.update.mockResolvedValue(interviewRow());

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/int-1`,
      payload: { interviewerIds: [AHMED.id, ZOHAIB.id] },
    });

    expect(response.statusCode).toBe(200);
    const checked = db.interviewParticipant.findMany.mock.calls[0]?.[0]?.where.employeeId.in;
    expect(checked).toEqual([ZOHAIB.id]);
  });

  it('leaves the time alone - a panel change is not a reschedule', async () => {
    db.interview.findFirst.mockResolvedValue(before([{ id: 'part-1', employeeId: AHMED.id }]));
    db.interview.update.mockResolvedValue(interviewRow());

    const app = await appAs(interviewRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/int-1`,
      payload: { notes: 'Ask about the shader work' },
    });

    const data = db.interview.update.mock.calls[0]?.[0]?.data;
    expect(data).toEqual({ notes: 'Ask about the shader work' });
    expect(db.interviewScheduleChange.create).not.toHaveBeenCalled();
  });
});

describe('the interviewer’s own three figures', () => {
  it('counts nothing for a login with no employee record', async () => {
    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: 'user-ghost',
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/my-summary` })
      .then((r) => r.json());

    expect(body.data).toEqual({ today: 0, upcoming: 0, completed: 0, awaitingEvaluation: 0 });
    expect(db.interview.count).not.toHaveBeenCalled();
  });

  it('counts their own seats, in the company’s zone', async () => {
    db.interview.count.mockResolvedValue(2);
    db.interviewParticipant.count.mockResolvedValue(1);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/my-summary` })
      .then((r) => r.json());

    expect(body.data.awaitingEvaluation).toBe(1);
    const where = db.interview.count.mock.calls[0]?.[0]?.where;
    expect(where.participants).toEqual({ some: { employeeId: AHMED.id } });
  });
});

describe('what an interview says about a candidate', () => {
  it('carries the name, the role and the panel, and no salary or note', async () => {
    db.interview.findFirst.mockResolvedValue(
      interviewRow({ participants: [participantRow(AHMED), participantRow(ZOHAIB)] }),
    );
    db.interviewScheduleChange.findMany.mockResolvedValue([]);

    const app = await appAs(interviewRoutes, {
      prefix: PREFIX,
      permissions: INTERVIEWER,
      userId: AHMED.userId,
    });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/int-1` })
      .then((r) => r.json());

    expect(body.data.candidateName).toBe('Muhammad Ali');
    expect(body.data.interviewers).toHaveLength(2);
    expect(body.data.evaluationsPending).toBe(2);
    expect(body.data).not.toHaveProperty('restricted');
    for (const key of ['currentSalary', 'expectedSalary', 'notes', 'email', 'phone']) {
      expect(body.data.candidate?.[key]).toBeUndefined();
    }
  });
});
