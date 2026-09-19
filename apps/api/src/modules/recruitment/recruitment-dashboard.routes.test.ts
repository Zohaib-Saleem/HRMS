import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The dashboard, the upcoming-interviews panel, and the interviewer picker.
 *
 * Two claims, and both are easy to lose on a screen made of numbers.
 *
 * EVERY FIGURE IS IN THE COMPANY'S CALENDAR. "Interviews today" is a question
 * about the office's day, and the office is in Karachi: at 20:00 UTC it is
 * already tomorrow there, and a UTC-based count would report the wrong number
 * to whoever runs hiring. So the boundaries are asserted as instants, not as
 * "a day".
 *
 * AND EVERY FIGURE IS SCOPED. A dashboard aggregates rows, and a count is a
 * disclosure: "open positions: 7" from somebody who may open two of them has
 * leaked five. So a caller without `recruitment.manage` is counted over their
 * own openings, a caller without `interview.manage` over their own panel seats,
 * and a caller without `candidate.read` gets zeroes rather than a figure they
 * were never allowed - reported as zero rather than omitted, so the payload has
 * one shape for everybody.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { recruitmentDashboardRoutes } = await import('./recruitment-dashboard.routes.js');
const {
  AHMED,
  COMPANY,
  HR,
  MANAGER,
  NOW,
  TIMEZONE,
  ZOHAIB,
  appAs,
  interviewRow,
  participantRow,
  useRecruitmentDb,
  wirePeople,
} = kit;

const PREFIX = '/recruitment/dashboard';

/** Runs recruitment but reads no candidates - the section 20 shape. */
const COORDINATOR: Permission[] = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.INTERVIEW_READ,
  PERMISSIONS.INTERVIEW_MANAGE,
];

/** 10:00 Karachi on the 18th. The day there runs 19:00 UTC to 19:00 UTC. */
const DAY_START = new Date('2026-09-17T19:00:00.000Z');
const DAY_END = new Date('2026-09-18T19:00:00.000Z');

/** Pulls one `count` call out of a mock by a marker in its WHERE clause. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callWhere(mock: any, index: number): any {
  return mock.mock.calls[index]?.[0]?.where;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);

  db.jobOpening.count.mockResolvedValue(4);
  db.jobOpening.aggregate.mockResolvedValue({ _sum: { vacancies: 9 } });
  db.interview.count.mockResolvedValue(2);
  db.candidate.count.mockResolvedValue(11);
  db.offer.count.mockResolvedValue(3);
  db.interview.findMany.mockResolvedValue([]);
  db.employee.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the figures', () => {
  it('counts today in the company’s calendar, not the server’s', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ today: '2026-09-18', timezone: TIMEZONE });

    const todayWhere = callWhere(db.interview.count, 0);
    expect(todayWhere.AND).toContainEqual({ startsAt: { gte: DAY_START, lt: DAY_END } });
  });

  /*
   * 01:00 on the 19th in Karachi, which is still the 18th everywhere the
   * server might think it is. The office's answer is the 19th.
   */
  it('has already rolled over when Karachi has, though UTC has not', async () => {
    vi.setSystemTime(new Date('2026-09-18T20:00:00.000Z'));

    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.json().data.today).toBe('2026-09-19');
  });

  it('does not count a cancelled interview as something happening today', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: PREFIX });

    expect(callWhere(db.interview.count, 0).AND).toContainEqual({
      status: { notIn: ['CANCELLED'] },
    });
  });

  it('sums the vacancies across the live openings, not just the open ones', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.json().data.openVacancies).toBe(9);
    expect(db.jobOpening.aggregate.mock.calls[0]?.[0]?._sum).toEqual({ vacancies: true });
  });

  it('reports zero vacancies rather than null when there are no openings', async () => {
    db.jobOpening.aggregate.mockResolvedValue({ _sum: { vacancies: null } });

    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.json().data.openVacancies).toBe(0);
  });

  it('counts hires from the first of the month in the company’s zone', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: PREFIX });

    // Midnight on 1 September in Karachi is 19:00 UTC on 31 August.
    expect(callWhere(db.candidate.count, 2)).toMatchObject({
      hiredAt: { gte: new Date('2026-08-31T19:00:00.000Z') },
    });
  });
});

describe('who the figures are about', () => {
  it('counts a hiring manager’s own openings and own panel seats', async () => {
    const app = await appAs(recruitmentDashboardRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: AHMED.userId,
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    expect(callWhere(db.jobOpening.count, 0).AND).toContainEqual({
      OR: [{ hiringManagerId: AHMED.id }, { recruiterId: AHMED.id }],
    });
    expect(callWhere(db.interview.count, 0).AND[0].AND).toContainEqual({
      participants: { some: { employeeId: AHMED.id } },
    });
  });

  it('counts everything for somebody who manages recruitment', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: PREFIX });

    expect(callWhere(db.jobOpening.count, 0).AND).toContainEqual({});
  });

  /*
   * An administrator's login that was never linked to a person is on nobody's
   * panel and named on nobody's opening. The narrowed grants must answer with
   * no rows, and must answer without asking the database for any.
   */
  it('gives a login with no employee record nothing, and asks for nothing', async () => {
    const app = await appAs(recruitmentDashboardRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: 'user-ghost',
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.json().data).toMatchObject({
      openPositions: 0,
      openVacancies: 0,
      interviewsToday: 0,
      upcomingInterviews: 0,
    });
    expect(db.jobOpening.count).not.toHaveBeenCalled();
    expect(db.interview.count).not.toHaveBeenCalled();
  });

  it('zeroes the candidate and offer figures without candidate.read', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: COORDINATOR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    const data = response.json().data;
    // Present and zero, not absent: the payload has one shape for everybody.
    expect(data).toMatchObject({
      activeCandidates: 0,
      candidatesInInterview: 0,
      hiredThisMonth: 0,
      offersPending: 0,
    });
    expect(db.candidate.count).not.toHaveBeenCalled();
    expect(db.offer.count).not.toHaveBeenCalled();
  });

  it('refuses somebody with no recruitment grant at all', async () => {
    const app = await appAs(recruitmentDashboardRoutes, {
      prefix: PREFIX,
      permissions: kit.EMPLOYEE,
    });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(403);
    expect(db.jobOpening.count).not.toHaveBeenCalled();
  });
});

describe('the upcoming panel', () => {
  beforeEach(() => {
    db.interview.findMany.mockResolvedValue([
      interviewRow({
        id: 'int-today',
        participants: [participantRow(AHMED, { isLead: true }), participantRow(ZOHAIB)],
      }),
      interviewRow({
        id: 'int-later',
        startsAt: new Date('2026-09-22T05:00:00.000Z'),
        endsAt: new Date('2026-09-22T06:00:00.000Z'),
        participants: [participantRow(AHMED)],
      }),
    ]);
  });

  it('marks today’s as TODAY and the rest as UPCOMING', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { when: string }) => row.when)).toEqual([
      'TODAY',
      'UPCOMING',
    ]);
  });

  it('starts at the beginning of today, not at this moment', async () => {
    // An interview at 10 a.m. is still today's business at 11.
    vi.setSystemTime(new Date('2026-09-18T08:00:00.000Z'));

    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/upcoming-interviews` });

    const clauses = db.interview.findMany.mock.calls[0]?.[0]?.where?.AND ?? [];
    expect(clauses).toContainEqual({
      startsAt: { gte: DAY_START, lt: new Date(DAY_START.getTime() + 14 * 86_400_000) },
    });
  });

  it('carries the panel’s names and nothing about money', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews`,
    });

    const [first] = response.json().data;
    expect(first.interviewerNames).toEqual(['Ahmed Khan', 'Muhammad Zohaib']);
    expect(first.candidateName).toBe('Muhammad Ali');
    expect(JSON.stringify(first)).not.toContain('Salary');
    expect(first).not.toHaveProperty('notes');
  });

  it('honours the horizon and the limit', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews?days=3&limit=5`,
    });

    const args = db.interview.findMany.mock.calls[0]?.[0];
    expect(args.take).toBe(5);
    expect(args.where.AND).toContainEqual({
      startsAt: { gte: DAY_START, lt: new Date(DAY_START.getTime() + 3 * 86_400_000) },
    });
  });

  it('refuses a horizon outside the allowed range', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews?days=400`,
    });

    expect(response.statusCode).toBe(422);
    expect(db.interview.findMany).not.toHaveBeenCalled();
  });

  it('narrows to the caller’s own seats when asked for mine', async () => {
    const app = await appAs(recruitmentDashboardRoutes, {
      prefix: PREFIX,
      permissions: HR,
      userId: AHMED.userId,
    });
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews?scope=mine`,
    });

    expect(db.interview.findMany.mock.calls[0]?.[0]?.where?.AND).toContainEqual({
      participants: { some: { employeeId: AHMED.id } },
    });
  });

  it('leaves out interviews that were cancelled or already happened', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/upcoming-interviews` });

    expect(db.interview.findMany.mock.calls[0]?.[0]?.where?.AND).toContainEqual({
      status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] },
    });
  });

  it('answers with an empty panel for a login on nobody’s panel', async () => {
    const app = await appAs(recruitmentDashboardRoutes, {
      prefix: PREFIX,
      permissions: MANAGER,
      userId: 'user-ghost',
    });
    const response = await app.inject({
      method: 'GET',
      url: `${PREFIX}/upcoming-interviews`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(db.interview.findMany).not.toHaveBeenCalled();
  });
});

describe('who can be put on a panel', () => {
  beforeEach(() => {
    db.employee.findMany.mockResolvedValue([
      {
        id: AHMED.id,
        firstName: AHMED.firstName,
        lastName: AHMED.lastName,
        jobTitle: 'Developer',
        userId: AHMED.userId,
        designation: { name: 'Senior Unity Developer' },
        department: { name: 'Development' },
      },
      {
        id: kit.NO_LOGIN.id,
        firstName: kit.NO_LOGIN.firstName,
        lastName: kit.NO_LOGIN.lastName,
        jobTitle: 'Artist',
        userId: null,
        designation: null,
        department: null,
      },
    ]);
  });

  it('offers existing employees, and says which of them have a login', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/interviewers` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      {
        employeeId: AHMED.id,
        fullName: 'Ahmed Khan',
        // The designation wins over the free-text job title when there is one.
        jobTitle: 'Senior Unity Developer',
        departmentName: 'Development',
        hasLogin: true,
      },
      {
        employeeId: kit.NO_LOGIN.id,
        fullName: 'Bilal Aslam',
        jobTitle: 'Artist',
        departmentName: null,
        hasLogin: false,
      },
    ]);
  });

  it('leaves out people who have left', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/interviewers` });

    expect(db.employee.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      companyId: COMPANY,
      status: { notIn: ['TERMINATED', 'RESIGNED'] },
    });
  });

  it('searches by name or employee number, within one department', async () => {
    const app = await appAs(recruitmentDashboardRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/interviewers?q=ahmed&departmentId=dept-dev`,
    });

    const where = db.employee.findMany.mock.calls[0]?.[0]?.where;
    expect(where.departmentId).toBe('dept-dev');
    expect(where.OR).toEqual([
      { firstName: { contains: 'ahmed', mode: 'insensitive' } },
      { lastName: { contains: 'ahmed', mode: 'insensitive' } },
      { employeeNumber: { contains: 'ahmed', mode: 'insensitive' } },
    ]);
  });
});
