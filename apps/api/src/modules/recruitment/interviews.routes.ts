import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  INTERVIEW_BLOCKING_STATUSES,
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  PERMISSIONS,
  canRescheduleInterview,
  canTransitionInterview,
  idParamSchema,
  interviewCalendarQuerySchema,
  interviewConflictQuerySchema,
  interviewCreateSchema,
  interviewQuerySchema,
  interviewRescheduleSchema,
  interviewStatusSchema,
  interviewUpdateSchema,
  isJobOpeningAccepting,
  type InterviewConflict,
  type InterviewRecord,
  type InterviewStatus,
  type JobOpeningStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { dayBoundsInZone, instantInZone, todayInZone } from '../../core/zoned-time.js';
import {
  INTERVIEW_INCLUDE,
  companyTimezone,
  interviewFilter,
  resolveActor,
  resolveInterviewWindow,
  resolveInterviewers,
  toInterviewRecord,
  type RecruitmentActor,
} from './recruitment.service.js';
import { notifyPanel, type PanelNotice } from './interview-notifications.js';

/**
 * Interviews: the calendar, and the appointments on it.
 *
 * Two grants, and the gap between them is the whole of section 20.
 * `interview.read` opens this plugin and on its own returns the interviews the
 * caller has a SEAT on - a WHERE clause through `interview_participants`, so an
 * interviewer cannot browse the calendar, discover who else is being seen for a
 * role, or open an interview they were not invited to. A guessed id answers
 * 404, exactly as a made-up one does. `interview.manage` widens the reads to
 * the whole company and unlocks scheduling, rescheduling and cancelling.
 *
 * What an interviewer is shown ABOUT a candidate is bounded by the response
 * rather than by the query: `toInterviewRecord` carries the candidate's name,
 * reference, the role and the panel, and carries no salary, no HR note and no
 * document. An interviewer who wants more needs `candidate.read`, which is a
 * different grant on a different plugin.
 *
 * Three rules are worth stating before the routes:
 *
 *   - A CLASH IS A WARNING, NOT A REFUSAL. Double-booking a panellist is
 *     sometimes the right answer, and the failure mode to avoid is doing it
 *     SILENTLY. So scheduling refuses by default and reports who clashes with
 *     what; `allowConflicts` is how a human overrules that after reading it.
 *   - RESCHEDULING DOES NOT OVERWRITE HISTORY. The interview keeps its id, its
 *     panel and its evaluations - it is the same appointment - and the old time
 *     is written to `interview_schedule_changes` with a compulsory reason.
 *   - NOTIFICATION IS NOT DELIVERY. The response reports the in-app count and
 *     the email transport's own answer separately, so a console mail provider
 *     cannot be mistaken for a delivered email.
 */

/** Interviews starting within this window count as "upcoming" on a dashboard. */
const UPCOMING_WINDOW_DAYS = 14;

export const interviewRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.INTERVIEW_READ));

  /**
   * The list, with every filter section 24 asks for.
   *
   * `scope=mine` narrows to the caller's own seats and is resolved SERVER-SIDE
   * from the session - it is a word, not an employee id, for the same reason
   * the case queue's "assigned to me" is: the server is the only thing that can
   * be trusted to know whose session this is.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(interviewQuerySchema, request.query);

    const scope = interviewFilter(actor);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where = await buildInterviewWhere(actor, scope, query);

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.interview.count({ where }),
      prisma.interview.findMany({
        where,
        skip,
        take,
        include: INTERVIEW_INCLUDE,
        orderBy: { startsAt: query.order === 'asc' ? 'asc' : 'desc' },
      }),
    ]);

    return reply.send({
      data: rows.map(toInterviewRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * The calendar.
   *
   * A view and an anchor day rather than a from/to pair, because the window has
   * to be computed in the COMPANY's zone. A browser computing "this week"
   * computes it in the browser's zone, which is how a Monday interview
   * disappears from a Monday-to-Sunday week for somebody sitting five hours
   * west of the office.
   *
   * Not paginated: a month is bounded by being a month.
   */
  app.get('/calendar', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(interviewCalendarQuerySchema, request.query);

    const scope = interviewFilter(actor);
    const timezone = await companyTimezone(auth.companyId);

    if (scope === null) {
      return reply.send({
        data: [],
        range: { from: null, to: null, view: query.view, timezone },
      });
    }

    const anchor = query.day ?? todayInZone(timezone);
    const { from, to } = calendarWindow(anchor, query.view, timezone);

    const where: Prisma.InterviewWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scope,
        { startsAt: { gte: from, lt: to } },
        query.status ? { status: query.status } : {},
        query.type ? { type: query.type } : {},
        query.jobOpeningId ? { jobOpeningId: query.jobOpeningId } : {},
        query.departmentId ? { jobOpening: { departmentId: query.departmentId } } : {},
        query.interviewerId
          ? { participants: { some: { employeeId: query.interviewerId } } }
          : {},
        query.scope === 'mine' && actor.employeeId
          ? { participants: { some: { employeeId: actor.employeeId } } }
          : {},
      ],
    };

    const rows = await prisma.interview.findMany({
      where,
      include: INTERVIEW_INCLUDE,
      orderBy: { startsAt: 'asc' },
      take: 1000,
    });

    return reply.send({
      data: rows.map(toInterviewRecord),
      range: {
        from: from.toISOString(),
        to: to.toISOString(),
        view: query.view,
        timezone,
        anchor,
      },
    });
  });

  /**
   * Who would clash, asked before committing to a time.
   *
   * Reads the same `findConflicts` the scheduling endpoint does, so the warning
   * the form shows and the refusal the server produces cannot disagree. It is
   * gated on `interview.manage` because it answers a question about other
   * people's calendars.
   */
  app.get(
    '/conflicts',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(interviewConflictQuerySchema, request.query);

      const interviewerIds = query.interviewerIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (interviewerIds.length === 0) return reply.send({ data: [] });

      const { startsAt, endsAt } = resolveInterviewWindow(query);

      const conflicts = await findConflicts(
        auth.companyId,
        interviewerIds,
        startsAt,
        endsAt,
        query.excludeInterviewId ?? null,
      );

      return reply.send({ data: conflicts });
    },
  );

  /** The interviewer's own three figures, for their own screen. */
  app.get('/my-summary', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const timezone = await companyTimezone(auth.companyId);

    if (!actor.employeeId) {
      return reply.send({
        data: { today: 0, upcoming: 0, completed: 0, awaitingEvaluation: 0 },
      });
    }

    const today = todayInZone(timezone);
    const { from, to } = dayBoundsInZone(today, timezone);
    const mine: Prisma.InterviewWhereInput = {
      companyId: auth.companyId,
      participants: { some: { employeeId: actor.employeeId } },
    };

    const [todayCount, upcoming, completed, awaitingEvaluation] = await Promise.all([
      prisma.interview.count({
        where: { ...mine, startsAt: { gte: from, lt: to }, status: { notIn: ['CANCELLED'] } },
      }),
      prisma.interview.count({
        where: {
          ...mine,
          startsAt: { gte: to },
          status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] },
        },
      }),
      prisma.interview.count({ where: { ...mine, status: 'COMPLETED' } }),
      // Their own seats on finished interviews with no evaluation filed. The
      // absence of the row IS the pending state - there is no "draft" to find.
      prisma.interviewParticipant.count({
        where: {
          companyId: auth.companyId,
          employeeId: actor.employeeId,
          evaluation: { is: null },
          interview: { status: { in: ['COMPLETED', 'NO_SHOW'] } },
        },
      }),
    ]);

    return reply.send({
      data: { today: todayCount, upcoming, completed, awaitingEvaluation },
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const scope = interviewFilter(actor);
    if (scope === null) throw new NotFoundError('Interview');

    const row = await prisma.interview.findFirst({
      where: { AND: [{ id, companyId: auth.companyId }, scope] },
      include: INTERVIEW_INCLUDE,
    });
    if (!row) throw new NotFoundError('Interview');

    const changes = await prisma.interviewScheduleChange.findMany({
      where: { interviewId: row.id },
      orderBy: { createdAt: 'asc' },
    });

    const record: InterviewRecord = {
      ...toInterviewRecord(row),
      scheduleChanges: changes.map((change) => ({
        id: change.id,
        previousStartsAt: change.previousStartsAt.toISOString(),
        previousEndsAt: change.previousEndsAt.toISOString(),
        previousTimezone: change.previousTimezone,
        newStartsAt: change.newStartsAt.toISOString(),
        newEndsAt: change.newEndsAt.toISOString(),
        newTimezone: change.newTimezone,
        reason: change.reason,
        changedByName: null,
        createdAt: change.createdAt.toISOString(),
      })),
    };

    return reply.send({ data: record });
  });

  /**
   * Scheduling one.
   *
   * The order matters and is not incidental: the candidate and the vacancy are
   * proved to belong to this company FIRST, the panel is proved to be
   * employees of it SECOND, and only then are clashes checked - so an
   * unauthorised caller probing with foreign ids is refused before this
   * endpoint tells them anything about anybody's calendar.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = await resolveActor(auth);
      const input = parseOrThrow(interviewCreateSchema, request.body);

      const candidate = await prisma.candidate.findFirst({
        where: { id: input.candidateId, companyId: auth.companyId },
        select: { id: true, fullName: true, reference: true },
      });
      if (!candidate) {
        throw new ValidationError({ candidateId: ['That candidate does not exist.'] });
      }

      const { jobOpeningId, applicationId } = await resolveJobLink(
        auth.companyId,
        candidate.id,
        input.jobOpeningId,
        input.applicationId,
      );

      const interviewers = await resolveInterviewers(auth.companyId, input.interviewerIds);
      const { startsAt, endsAt } = resolveInterviewWindow(input);

      const conflicts = await findConflicts(
        auth.companyId,
        interviewers.map((i) => i.id),
        startsAt,
        endsAt,
        null,
      );

      if (conflicts.length > 0 && !input.allowConflicts) {
        throw new InterviewConflictError(conflicts);
      }

      const created = await prisma.interview.create({
        data: {
          companyId: auth.companyId,
          candidateId: candidate.id,
          jobOpeningId,
          applicationId,
          type: input.type,
          round: input.round,
          startsAt,
          endsAt,
          timezone: input.timezone,
          location: input.location,
          meetingLink: input.meetingLink,
          notes: input.notes,
          status: 'SCHEDULED',
          scheduledById: actor.employeeId,
          participants: {
            create: interviewers.map((interviewer) => ({
              companyId: auth.companyId,
              employeeId: interviewer.id,
              isLead: interviewer.id === input.leadInterviewerId,
            })),
          },
        },
        include: INTERVIEW_INCLUDE,
      });

      const record = toInterviewRecord(created);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'interview.created',
        entityType: 'Interview',
        entityId: created.id,
        summary: `Scheduled a ${INTERVIEW_TYPE_LABELS[input.type]} (${INTERVIEW_ROUND_LABELS[input.round]}) with ${candidate.fullName} for ${startsAt.toISOString()}`,
        after: {
          candidateId: candidate.id,
          jobOpeningId,
          type: input.type,
          round: input.round,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          timezone: input.timezone,
          interviewers: interviewers.map((i) => i.fullName),
          bookedOverConflicts: conflicts.length > 0,
        },
        request,
      });

      const notice = await notifyPanel(request, {
        kind: 'SCHEDULED',
        companyId: auth.companyId,
        interviewId: created.id,
        candidateName: candidate.fullName,
        jobTitle: record.jobTitle,
        type: input.type,
        round: input.round,
        startsAt,
        timezone: input.timezone,
        interviewers,
      });

      return reply.code(201).send({
        data: buildScheduleResult(record, notice, conflicts),
      });
    },
  );

  /**
   * Editing the things about an interview that are not its time.
   *
   * Changing the panel is here rather than on the reschedule endpoint because
   * it is not a reschedule - nobody's time moves - but it IS worth the clash
   * check, since adding a fourth interviewer to an existing slot can double-book
   * them exactly as scheduling can.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(interviewUpdateSchema, request.body);

      const before = await prisma.interview.findFirst({
        where: { id, companyId: auth.companyId },
        include: { candidate: { select: { fullName: true } }, participants: true },
      });
      if (!before) throw new NotFoundError('Interview');

      let conflicts: InterviewConflict[] = [];
      let interviewers: Awaited<ReturnType<typeof resolveInterviewers>> = [];

      if (input.interviewerIds) {
        interviewers = await resolveInterviewers(auth.companyId, input.interviewerIds);

        if (input.leadInterviewerId && !input.interviewerIds.includes(input.leadInterviewerId)) {
          throw new ValidationError({
            leadInterviewerId: ['The lead has to be one of the interviewers.'],
          });
        }

        /*
         * Only the people being ADDED are checked. Somebody already on this
         * panel clashes with this interview, which is not a clash, and
         * reporting it would make every panel edit look like a double-booking.
         */
        const existing = new Set(before.participants.map((p) => p.employeeId));
        const added = interviewers.filter((i) => !existing.has(i.id)).map((i) => i.id);

        if (added.length > 0) {
          conflicts = await findConflicts(
            auth.companyId,
            added,
            before.startsAt,
            before.endsAt,
            before.id,
          );
          if (conflicts.length > 0 && !input.allowConflicts) {
            throw new InterviewConflictError(conflicts);
          }
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        if (input.interviewerIds) {
          const keep = new Set(interviewers.map((i) => i.id));

          /*
           * Removing a seat removes that person's evaluation with it, by the
           * cascade on the participant. That is the right behaviour and is
           * worth being explicit about: an evaluation belongs to a seat on a
           * panel, and somebody taken off the panel has no seat to have had an
           * opinion from. Which is also why a panel edit that would drop a
           * FILED evaluation is refused below rather than performed quietly.
           */
          const dropping = before.participants.filter((p) => !keep.has(p.employeeId));
          if (dropping.length > 0) {
            const filed = await tx.interviewEvaluation.count({
              where: { participantId: { in: dropping.map((p) => p.id) } },
            });
            if (filed > 0) {
              throw new ConflictError(
                'One of the interviewers you are removing has already submitted an evaluation. Their feedback is part of the record and cannot be dropped this way.',
              );
            }
            await tx.interviewParticipant.deleteMany({
              where: { id: { in: dropping.map((p) => p.id) } },
            });
          }

          const have = new Set(before.participants.map((p) => p.employeeId));
          for (const interviewer of interviewers) {
            if (have.has(interviewer.id)) {
              await tx.interviewParticipant.updateMany({
                where: { interviewId: before.id, employeeId: interviewer.id },
                data: { isLead: interviewer.id === input.leadInterviewerId },
              });
            } else {
              await tx.interviewParticipant.create({
                data: {
                  companyId: auth.companyId,
                  interviewId: before.id,
                  employeeId: interviewer.id,
                  isLead: interviewer.id === input.leadInterviewerId,
                },
              });
            }
          }
        }

        return tx.interview.update({
          where: { id: before.id },
          data: {
            ...(input.type !== undefined ? { type: input.type } : {}),
            ...(input.round !== undefined ? { round: input.round } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.meetingLink !== undefined ? { meetingLink: input.meetingLink } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          },
          include: INTERVIEW_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'interview.updated',
        entityType: 'Interview',
        entityId: updated.id,
        summary: `Updated the ${INTERVIEW_TYPE_LABELS[updated.type]} with ${before.candidate.fullName}`,
        after: {
          type: updated.type,
          round: updated.round,
          ...(input.interviewerIds ? { interviewers: interviewers.map((i) => i.fullName) } : {}),
        },
        request,
      });

      return reply.send({ data: toInterviewRecord(updated) });
    },
  );

  /**
   * Moving one to a new time.
   *
   * Section 10, in one endpoint. The interview keeps its id - it is the same
   * appointment, with the same panel and the same evaluations - and the old
   * time is written to `interview_schedule_changes` with the reason, so
   * "Originally 10:00, rescheduled to 14:00, because the interviewer was
   * unavailable" survives as a record rather than as an overwritten column.
   *
   * The status becomes RESCHEDULED, which is a status this endpoint PRODUCES
   * and nobody picks: it is absent from every manual transition list.
   */
  app.post(
    '/:id/reschedule',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = await resolveActor(auth);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(interviewRescheduleSchema, request.body);

      const before = await prisma.interview.findFirst({
        where: { id, companyId: auth.companyId },
        include: {
          candidate: { select: { fullName: true } },
          jobOpening: { select: { title: true } },
          participants: { select: { employeeId: true } },
        },
      });
      if (!before) throw new NotFoundError('Interview');

      if (!canRescheduleInterview(before.status as InterviewStatus)) {
        throw new ConflictError(
          `A ${INTERVIEW_STATUS_LABELS[before.status as InterviewStatus].toLowerCase()} interview cannot be moved. Schedule a new one instead.`,
        );
      }

      const { startsAt, endsAt } = resolveInterviewWindow(input);

      if (
        startsAt.getTime() === before.startsAt.getTime() &&
        endsAt.getTime() === before.endsAt.getTime() &&
        input.timezone === before.timezone
      ) {
        throw new ConflictError('That is the time the interview is already at.');
      }

      const panelIds = before.participants.map((p) => p.employeeId);
      const conflicts = await findConflicts(
        auth.companyId,
        panelIds,
        startsAt,
        endsAt,
        before.id,
      );
      if (conflicts.length > 0 && !input.allowConflicts) {
        throw new InterviewConflictError(conflicts);
      }

      // The history row and the move, together. Either both happen or neither
      // does: a moved interview with no record of where it moved from is the
      // exact outcome section 10 forbids.
      const updated = await prisma.$transaction(async (tx) => {
        await tx.interviewScheduleChange.create({
          data: {
            companyId: auth.companyId,
            interviewId: before.id,
            previousStartsAt: before.startsAt,
            previousEndsAt: before.endsAt,
            previousTimezone: before.timezone,
            newStartsAt: startsAt,
            newEndsAt: endsAt,
            newTimezone: input.timezone,
            reason: input.reason,
            changedById: actor.employeeId,
          },
        });

        return tx.interview.update({
          where: { id: before.id },
          data: {
            startsAt,
            endsAt,
            timezone: input.timezone,
            status: 'RESCHEDULED',
            // A panellist's confirmation was for the OLD time and does not
            // carry over. Leaving it would show a panel as confirmed for an
            // appointment none of them has seen.
            participants: { updateMany: { where: {}, data: { confirmedAt: null } } },
          },
          include: INTERVIEW_INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'interview.rescheduled',
        entityType: 'Interview',
        entityId: updated.id,
        summary: `Moved the ${INTERVIEW_TYPE_LABELS[updated.type]} with ${before.candidate.fullName} from ${before.startsAt.toISOString()} to ${startsAt.toISOString()} (${input.reason})`,
        before: {
          startsAt: before.startsAt.toISOString(),
          endsAt: before.endsAt.toISOString(),
          timezone: before.timezone,
        },
        after: {
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          timezone: input.timezone,
          reason: input.reason,
          bookedOverConflicts: conflicts.length > 0,
        },
        request,
      });

      const interviewers = await resolveInterviewers(auth.companyId, panelIds);
      const record = toInterviewRecord(updated);

      const notice = await notifyPanel(request, {
        kind: 'RESCHEDULED',
        companyId: auth.companyId,
        interviewId: updated.id,
        candidateName: before.candidate.fullName,
        jobTitle: before.jobOpening?.title ?? null,
        type: updated.type,
        round: updated.round,
        startsAt,
        timezone: input.timezone,
        previousStartsAt: before.startsAt,
        previousTimezone: before.timezone,
        reason: input.reason,
        interviewers,
      });

      return reply.send({ data: buildScheduleResult(record, notice, conflicts) });
    },
  );

  /**
   * Moving an interview's status: confirmed, completed, cancelled, no-show.
   *
   * Every move is checked against the shared transition map, so this grant buys
   * the workflow rather than a free hand. Cancelling needs a reason, and a
   * cancelled interview is never deleted - the row stays, which is how
   * "we cancelled on this candidate twice" remains a fact about us.
   */
  app.post(
    '/:id/status',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(interviewStatusSchema, request.body);

      const before = await prisma.interview.findFirst({
        where: { id, companyId: auth.companyId },
        include: {
          candidate: { select: { fullName: true } },
          jobOpening: { select: { title: true } },
          participants: { select: { employeeId: true } },
        },
      });
      if (!before) throw new NotFoundError('Interview');

      const from = before.status as InterviewStatus;
      const to = input.status;

      if (from === to) {
        throw new ConflictError(
          `That interview is already ${INTERVIEW_STATUS_LABELS[to].toLowerCase()}.`,
        );
      }
      if (!canTransitionInterview(from, to)) {
        throw new ConflictError(
          `An interview cannot go from ${INTERVIEW_STATUS_LABELS[from]} to ${INTERVIEW_STATUS_LABELS[to]}.`,
        );
      }
      if (to === 'CANCELLED' && !input.reason) {
        throw new ValidationError({ reason: ['Say why the interview is being cancelled.'] });
      }

      const updated = await prisma.interview.update({
        where: { id: before.id },
        data: {
          status: to,
          ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}),
          ...(to === 'CANCELLED'
            ? { cancelledAt: new Date(), cancelledReason: input.reason ?? null }
            : {}),
        },
        include: INTERVIEW_INCLUDE,
      });

      const action =
        to === 'CANCELLED'
          ? 'interview.cancelled'
          : to === 'COMPLETED'
            ? 'interview.completed'
            : 'interview.updated';

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action,
        entityType: 'Interview',
        entityId: updated.id,
        summary: `${INTERVIEW_TYPE_LABELS[updated.type]} with ${before.candidate.fullName}: ${INTERVIEW_STATUS_LABELS[from]} -> ${INTERVIEW_STATUS_LABELS[to]}${input.reason ? ` (${input.reason})` : ''}`,
        before: { status: from },
        after: { status: to, reason: input.reason ?? null },
        request,
      });

      /*
       * Two notices, and only two. A cancellation tells the panel it is off; a
       * completion tells them their evaluation is outstanding, which is the
       * "evaluation pending" notification section 21 asks for and is the only
       * thing that ever prompts for one. Nothing is sent for CONFIRMED - the
       * panel confirmed it, so telling them about it is noise.
       */
      if (to === 'CANCELLED' || to === 'COMPLETED') {
        const interviewers = await resolveInterviewers(
          auth.companyId,
          before.participants.map((p) => p.employeeId),
        );
        await notifyPanel(request, {
          kind: to === 'CANCELLED' ? 'CANCELLED' : 'EVALUATION_PENDING',
          companyId: auth.companyId,
          interviewId: updated.id,
          candidateName: before.candidate.fullName,
          jobTitle: before.jobOpening?.title ?? null,
          type: updated.type,
          round: updated.round,
          startsAt: updated.startsAt,
          timezone: updated.timezone,
          reason: input.reason ?? undefined,
          interviewers,
        });
      }

      return reply.send({ data: toInterviewRecord(updated) });
    },
  );

  /**
   * A panellist saying they will be there.
   *
   * The one write on this plugin an ordinary `interview.read` holder may
   * perform, and it reaches exactly one row: their own seat, found by
   * (interviewId, their employee id). There is no request shape that confirms
   * on somebody else's behalf.
   */
  app.post('/:id/confirm', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    if (!actor.employeeId) {
      throw new ConflictError('Your login is not linked to an employee record.');
    }

    const participant = await prisma.interviewParticipant.findFirst({
      where: { interviewId: id, employeeId: actor.employeeId, companyId: auth.companyId },
      select: { id: true, interview: { select: { id: true, status: true } } },
    });
    if (!participant) throw new NotFoundError('Interview');

    await prisma.interviewParticipant.update({
      where: { id: participant.id },
      data: { confirmedAt: new Date() },
    });

    /*
     * The interview itself becomes CONFIRMED only when EVERY seat has. One
     * panellist saying yes does not mean the appointment is settled, and
     * flipping the status on the first confirmation would tell a coordinator
     * the panel is ready when two of three have not answered.
     */
    const outstanding = await prisma.interviewParticipant.count({
      where: { interviewId: id, confirmedAt: null },
    });

    if (
      outstanding === 0 &&
      (participant.interview.status === 'SCHEDULED' ||
        participant.interview.status === 'RESCHEDULED')
    ) {
      await prisma.interview.update({ where: { id }, data: { status: 'CONFIRMED' } });
    }

    const row = await prisma.interview.findUniqueOrThrow({
      where: { id },
      include: INTERVIEW_INCLUDE,
    });

    return reply.send({ data: toInterviewRecord(row) });
  });
};

/**
 * A 409 that carries the clashes with it.
 *
 * The body names who is busy, with what, and when - because "there is a
 * conflict" is not something a coordinator can act on, and "Ahmed Khan is
 * already with Usman Ahmed from 10:00 to 11:00" is.
 */
class InterviewConflictError extends ConflictError {
  constructor(conflicts: InterviewConflict[]) {
    const names = [...new Set(conflicts.map((c) => c.fullName))];
    super(
      `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} already interviewing at that time. Choose another slot, or book it anyway.`,
    );
    (this as unknown as { details: Record<string, string[]> }).details = {
      conflicts: conflicts.map(
        (c) => `${c.fullName} - ${c.candidateName}, ${c.startsAt} to ${c.endsAt}`,
      ),
    };
  }
}

/**
 * Which of these interviewers are already busy in this window.
 *
 * Overlap is `existing.startsAt < proposed.endsAt AND existing.endsAt >
 * proposed.startsAt`, which is the standard half-open test: an interview ending
 * at 11:00 does not clash with one starting at 11:00, and back-to-back slots
 * are the normal way a panel day is built.
 *
 * Only the statuses in `INTERVIEW_BLOCKING_STATUSES` count. A cancelled
 * interview frees its slot; a completed one still occupied it, which matters
 * when somebody is booking into the past to correct a record.
 */
async function findConflicts(
  companyId: string,
  employeeIds: readonly string[],
  startsAt: Date,
  endsAt: Date,
  excludeInterviewId: string | null,
): Promise<InterviewConflict[]> {
  if (employeeIds.length === 0) return [];

  const rows = await prisma.interviewParticipant.findMany({
    where: {
      companyId,
      employeeId: { in: [...employeeIds] },
      interview: {
        companyId,
        status: { in: [...INTERVIEW_BLOCKING_STATUSES] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(excludeInterviewId ? { id: { not: excludeInterviewId } } : {}),
      },
    },
    include: {
      employee: { select: { firstName: true, lastName: true } },
      interview: {
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          candidate: { select: { fullName: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    employeeId: row.employeeId,
    fullName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
    interviewId: row.interview.id,
    candidateName: row.interview.candidate.fullName,
    startsAt: row.interview.startsAt.toISOString(),
    endsAt: row.interview.endsAt.toISOString(),
    status: row.interview.status as InterviewStatus,
  }));
}

/**
 * Proves the vacancy and the application belong together and to this candidate.
 *
 * Both ids are optional on the request - an exploratory conversation has
 * neither - but a named application must belong to the named candidate, or an
 * interview would attach to somebody else's pipeline. Given a job opening and
 * no application, the candidate's existing application for that job is used,
 * which is what makes the common case one field on the form.
 */
async function resolveJobLink(
  companyId: string,
  candidateId: string,
  jobOpeningId: string | null,
  applicationId: string | null,
): Promise<{ jobOpeningId: string | null; applicationId: string | null }> {
  if (applicationId) {
    const application = await prisma.candidateApplication.findFirst({
      where: { id: applicationId, candidateId, companyId },
      select: { id: true, jobOpeningId: true },
    });
    if (!application) {
      throw new ValidationError({
        applicationId: ['That application does not belong to this candidate.'],
      });
    }
    return { jobOpeningId: application.jobOpeningId, applicationId: application.id };
  }

  if (!jobOpeningId) return { jobOpeningId: null, applicationId: null };

  const opening = await prisma.jobOpening.findFirst({
    where: { id: jobOpeningId, companyId },
    select: { id: true, status: true },
  });
  if (!opening) {
    throw new ValidationError({ jobOpeningId: ['That job opening does not exist.'] });
  }
  if (!isJobOpeningAccepting(opening.status as JobOpeningStatus)) {
    throw new ValidationError({
      jobOpeningId: ['That opening is not open, so interviews cannot be arranged against it.'],
    });
  }

  const application = await prisma.candidateApplication.findUnique({
    where: { candidateId_jobOpeningId: { candidateId, jobOpeningId: opening.id } },
    select: { id: true },
  });

  return { jobOpeningId: opening.id, applicationId: application?.id ?? null };
}

/** Applies the list filters shared by the list endpoint. */
async function buildInterviewWhere(
  actor: RecruitmentActor,
  scope: Prisma.InterviewWhereInput,
  query: {
    status?: string;
    type?: string;
    interviewerId?: string;
    candidateId?: string;
    jobOpeningId?: string;
    departmentId?: string;
    from?: string;
    to?: string;
    scope?: string;
    q?: string;
  },
): Promise<Prisma.InterviewWhereInput> {
  const timezone = await companyTimezone(actor.auth.companyId);

  const fromInstant = query.from ? instantInZone(query.from.slice(0, 10), 0, 0, timezone) : null;
  const toInstant = query.to
    ? // Exclusive end of the named day, so `to=2026-09-18` includes that whole
      // day rather than stopping at its midnight.
      new Date(instantInZone(query.to.slice(0, 10), 0, 0, timezone).getTime() + 86_400_000)
    : null;

  return {
    AND: [
      { companyId: actor.auth.companyId },
      scope,
      query.status ? { status: query.status as InterviewStatus } : {},
      query.type ? { type: query.type as never } : {},
      query.candidateId ? { candidateId: query.candidateId } : {},
      query.jobOpeningId ? { jobOpeningId: query.jobOpeningId } : {},
      query.departmentId ? { jobOpening: { departmentId: query.departmentId } } : {},
      query.interviewerId ? { participants: { some: { employeeId: query.interviewerId } } } : {},
      query.scope === 'mine' && actor.employeeId
        ? { participants: { some: { employeeId: actor.employeeId } } }
        : {},
      fromInstant ? { startsAt: { gte: fromInstant } } : {},
      toInstant ? { startsAt: { lt: toInstant } } : {},
      query.q
        ? {
            OR: [
              { candidate: { fullName: { contains: query.q, mode: 'insensitive' } } },
              { jobOpening: { title: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  };
}

/**
 * The window a calendar view covers, in the company's zone.
 *
 * The week starts on Monday, matching how the rest of this product reads a
 * week. A month runs from the 1st to the 1st, so the grid the client draws can
 * pad the edges itself without the server guessing how many leading blanks it
 * wants.
 */
function calendarWindow(
  anchor: string,
  view: 'day' | 'week' | 'month',
  timezone: string,
): { from: Date; to: Date } {
  const [year, month, day] = anchor.split('-').map(Number);

  if (view === 'day') return dayBoundsInZone(anchor, timezone);

  if (view === 'week') {
    const anchorUtc = new Date(Date.UTC(year!, month! - 1, day!));
    // getUTCDay: 0 is Sunday. Monday-first means Sunday is six days in.
    const offset = (anchorUtc.getUTCDay() + 6) % 7;
    const monday = new Date(anchorUtc.getTime() - offset * 86_400_000);
    const nextMonday = new Date(monday.getTime() + 7 * 86_400_000);
    return {
      from: instantInZone(monday.toISOString().slice(0, 10), 0, 0, timezone),
      to: instantInZone(nextMonday.toISOString().slice(0, 10), 0, 0, timezone),
    };
  }

  const first = new Date(Date.UTC(year!, month! - 1, 1)).toISOString().slice(0, 10);
  const nextFirst = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 10);
  return {
    from: instantInZone(first, 0, 0, timezone),
    to: instantInZone(nextFirst, 0, 0, timezone),
  };
}

/**
 * Assembles the scheduling response.
 *
 * `emailStatus` is passed through from the notification service VERBATIM and
 * is never flattened into "sent". Section 21 is explicit: if mail is going to
 * the console provider, the UI must not claim an email was delivered. The
 * in-app count and the transport's own answer are two different facts and are
 * reported as two.
 */
function buildScheduleResult(
  interview: InterviewRecord,
  notice: PanelNotice,
  conflicts: InterviewConflict[],
) {
  return {
    interview,
    notified: notice.notified,
    emailStatus: notice.emailStatus,
    emailProvider: notice.emailProvider,
    conflicts,
  };
}

/** Exported for the dashboard, which asks the same "what is coming up" question. */
export const UPCOMING_WINDOW_MS = UPCOMING_WINDOW_DAYS * 86_400_000;

/** Narrow request type so the notification helper can log through Fastify. */
export type InterviewRequest = FastifyRequest;

export const interviewParamsSchema = z.object({ id: z.string().min(1) });
