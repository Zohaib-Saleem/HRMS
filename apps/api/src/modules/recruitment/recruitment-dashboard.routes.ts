import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  JOB_OPENING_LIVE_STATUSES,
  OFFER_PENDING_STATUSES,
  PERMISSIONS,
  type InterviewRound,
  type InterviewType,
  type InterviewerOption,
  type RecruitmentDashboard,
  type UpcomingInterview,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { dayBoundsInZone, instantInZone, todayInZone } from '../../core/zoned-time.js';
import { companyTimezone, interviewFilter, jobOpeningFilter, resolveActor } from './recruitment.service.js';

/**
 * The recruitment dashboard, the upcoming-interviews panel, and the lookups
 * every recruitment form needs.
 *
 * Every figure below is computed in the COMPANY's timezone, not the server's
 * and not the browser's. "Interviews today" is a calendar question and the
 * calendar in question is the office's - a UTC-based count would put a 9 a.m.
 * Karachi interview on the previous day and quietly report the wrong number to
 * whoever runs hiring.
 *
 * The figures are also SCOPED, which is easy to miss on a dashboard. A caller
 * without `recruitment.manage` sees the openings they are named on, and a
 * caller without `interview.manage` sees the interviews they are on - the same
 * filters the list endpoints use, because a dashboard that aggregates rows the
 * reader may not open is a way of leaking exactly the thing the filters exist
 * to protect. A hiring manager's "open positions: 2" is their own two.
 */

export const recruitmentDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.RECRUITMENT_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const timezone = await companyTimezone(auth.companyId);

    const today = todayInZone(timezone);
    const { from: dayStart, to: dayEnd } = dayBoundsInZone(today, timezone);

    // The first of this month in the company's zone, for "hired this month".
    const monthStart = instantInZone(`${today.slice(0, 7)}-01`, 0, 0, timezone);

    const openingScope = jobOpeningFilter(actor);
    const interviewScope = interviewFilter(actor);

    const openingWhere: Prisma.JobOpeningWhereInput | null =
      openingScope === null
        ? null
        : { AND: [{ companyId: auth.companyId }, openingScope, { status: 'OPEN' }] };

    const liveOpeningWhere: Prisma.JobOpeningWhereInput | null =
      openingScope === null
        ? null
        : {
            AND: [
              { companyId: auth.companyId },
              openingScope,
              { status: { in: [...JOB_OPENING_LIVE_STATUSES] } },
            ],
          };

    const interviewBase: Prisma.InterviewWhereInput | null =
      interviewScope === null ? null : { AND: [{ companyId: auth.companyId }, interviewScope] };

    const [openPositions, vacancySum, interviewsToday, upcomingInterviews] = await Promise.all([
      openingWhere ? prisma.jobOpening.count({ where: openingWhere }) : 0,
      liveOpeningWhere
        ? prisma.jobOpening.aggregate({ where: liveOpeningWhere, _sum: { vacancies: true } })
        : null,
      interviewBase
        ? prisma.interview.count({
            where: {
              AND: [
                interviewBase,
                { startsAt: { gte: dayStart, lt: dayEnd } },
                // A cancelled interview is not something happening today.
                { status: { notIn: ['CANCELLED'] } },
              ],
            },
          })
        : 0,
      interviewBase
        ? prisma.interview.count({
            where: {
              AND: [
                interviewBase,
                { startsAt: { gte: dayEnd } },
                { status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } },
              ],
            },
          })
        : 0,
    ]);

    /*
     * The candidate and offer figures need `candidate.read`. Reported as ZERO
     * rather than omitted for a caller without it, because the shape of a
     * dashboard payload should not depend on who is reading it - and a hiring
     * manager seeing "candidates: 0" on a screen that offers them no candidate
     * list is a consistent absence rather than a broken card.
     */
    const [activeCandidates, candidatesInInterview, hiredThisMonth] = actor.canReadCandidates
      ? await Promise.all([
          prisma.candidate.count({
            where: {
              companyId: auth.companyId,
              stage: { notIn: ['REJECTED', 'WITHDRAWN', 'HIRED'] },
            },
          }),
          prisma.candidate.count({
            where: { companyId: auth.companyId, stage: 'INTERVIEW' },
          }),
          prisma.candidate.count({
            where: { companyId: auth.companyId, hiredAt: { gte: monthStart } },
          }),
        ])
      : [0, 0, 0];

    const offersPending = actor.canReadCandidates
      ? await prisma.offer.count({
          where: { companyId: auth.companyId, status: { in: [...OFFER_PENDING_STATUSES] } },
        })
      : 0;

    const dashboard: RecruitmentDashboard = {
      openPositions,
      openVacancies: vacancySum?._sum.vacancies ?? 0,
      activeCandidates,
      candidatesInInterview,
      interviewsToday,
      upcomingInterviews,
      offersPending,
      hiredThisMonth,
      today,
      timezone,
    };

    return reply.send({ data: dashboard });
  });

  /**
   * The upcoming-interviews panel - section 19.
   *
   * Today first, then the next fortnight, each line carrying what somebody
   * needs to decide whether to click: the time, the candidate, the role, the
   * type and who is on the panel. `when` is computed here rather than in the
   * browser for the same reason the counts are: which interviews are "today"
   * is a question about the office's calendar.
   *
   * It carries no candidate salary, no notes and no document - so an
   * interviewer's copy of this panel is the same shape as HR's, narrowed to
   * their own interviews by the scope filter.
   */
  app.get('/upcoming-interviews', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(
      z.object({
        days: z.coerce.number().int().min(1).max(60).default(14),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        scope: z.enum(['all', 'mine']).optional(),
      }),
      request.query,
    );

    const scope = interviewFilter(actor);
    if (scope === null) return reply.send({ data: [] });

    const timezone = await companyTimezone(auth.companyId);
    const today = todayInZone(timezone);
    const { from: dayStart, to: dayEnd } = dayBoundsInZone(today, timezone);
    const horizon = new Date(dayStart.getTime() + query.days * 86_400_000);

    const rows = await prisma.interview.findMany({
      where: {
        AND: [
          { companyId: auth.companyId },
          scope,
          // From the start of TODAY, not from now: an interview at 10 a.m. is
          // still today's business at 11, and dropping it off the panel the
          // moment it starts is how somebody loses the link they were about to
          // click.
          { startsAt: { gte: dayStart, lt: horizon } },
          { status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] } },
          query.scope === 'mine' && actor.employeeId
            ? { participants: { some: { employeeId: actor.employeeId } } }
            : {},
        ],
      },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
      include: {
        candidate: { select: { id: true, fullName: true } },
        jobOpening: { select: { title: true } },
        participants: {
          orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
          include: { employee: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    const data: UpcomingInterview[] = rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timezone: row.timezone,
      candidateId: row.candidateId,
      candidateName: row.candidate.fullName,
      jobTitle: row.jobOpening?.title ?? null,
      type: row.type as InterviewType,
      round: row.round as InterviewRound,
      status: row.status as never,
      interviewerNames: row.participants.map((participant) =>
        `${participant.employee.firstName} ${participant.employee.lastName}`.trim(),
      ),
      when: row.startsAt < dayEnd ? 'TODAY' : 'UPCOMING',
    }));

    return reply.send({ data });
  });

  /**
   * Who can be put on a panel, and who can own a vacancy.
   *
   * EXISTING employees, which is section 7: interviewers are HRMS people and no
   * duplicate user record is ever created for one. Terminated and resigned
   * employees are excluded, because somebody who has left should not appear on
   * a panel picker - but note that they are NOT excluded from an interview that
   * already exists, so a panel that included somebody who has since left still
   * shows their name and their evaluation.
   *
   * `hasLogin` is here so the scheduling form can say "two of these three
   * people have no login and will not be notified" BEFORE somebody books,
   * rather than leaving them to wonder why nobody turned up.
   */
  app.get('/interviewers', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(
      z.object({
        q: z.string().trim().max(200).optional(),
        departmentId: z.string().trim().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      request.query,
    );

    const rows = await prisma.employee.findMany({
      where: {
        companyId: auth.companyId,
        status: { notIn: ['TERMINATED', 'RESIGNED'] },
        ...(query.departmentId ? { departmentId: query.departmentId } : {}),
        ...(query.q
          ? {
              OR: [
                { firstName: { contains: query.q, mode: 'insensitive' } },
                { lastName: { contains: query.q, mode: 'insensitive' } },
                { employeeNumber: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        userId: true,
        designation: { select: { name: true } },
        department: { select: { name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: query.limit,
    });

    const data: InterviewerOption[] = rows.map((row) => ({
      employeeId: row.id,
      fullName: `${row.firstName} ${row.lastName}`.trim(),
      jobTitle: row.designation?.name ?? row.jobTitle,
      departmentName: row.department?.name ?? null,
      hasLogin: row.userId !== null,
    }));

    return reply.send({ data });
  });
};
