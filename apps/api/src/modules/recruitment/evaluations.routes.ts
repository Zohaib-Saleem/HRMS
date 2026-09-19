import type { FastifyPluginAsync } from 'fastify';
import {
  INTERVIEW_RECOMMENDATION_LABELS,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPE_LABELS,
  PERMISSIONS,
  canEvaluateInterview,
  evaluationInputSchema,
  idParamSchema,
  type InterviewEvaluationSummary,
  type InterviewStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  EVALUATION_INCLUDE,
  interviewOrThrow,
  ownParticipantOrThrow,
  resolveActor,
  toEvaluationRecord,
} from './recruitment.service.js';

/**
 * Interview evaluations: what each panellist thought.
 *
 * Section 11 and section 12 in one plugin, and three rules carry the whole of
 * both.
 *
 * ONE SEAT, ONE EVALUATION, AND NOBODY OVERWRITES ANYBODY. Every write goes
 * through `ownParticipantOrThrow`, which finds the caller's seat by
 * (interviewId, the caller's OWN employee id) - so there is no request shape
 * that files an opinion in somebody else's name, and none that reaches
 * somebody else's row to edit it. The unique index on participantId is the
 * database saying the same thing, so a race cannot produce two.
 *
 * AN EVALUATION IS ADVICE, NOT ARITHMETIC. Nothing here averages the scores,
 * ranks candidates, or moves anybody's stage. A panel that disagrees produces
 * a visible disagreement, which is the useful outcome; a mean score would hide
 * it behind a number. Moving the candidate on remains a person's decision on
 * the pipeline, behind `candidate.manage`.
 *
 * FEEDBACK COMES AFTER THE INTERVIEW. `canEvaluateInterview` allows COMPLETED
 * and NO_SHOW and nothing else: an interview that has not happened has nothing
 * to evaluate. NO_SHOW is included because "they did not turn up" is itself
 * feedback worth recording, and the alternative is an interviewer with nowhere
 * to put it.
 *
 * Reading is wider than writing, deliberately. Anybody who may read the
 * interview may read its evaluations - a panellist seeing what the rest of the
 * panel said is the entire point of a panel - and that read is already narrowed
 * by `interviewFilter`, so an interviewer sees the evaluations on THEIR
 * interviews and no others.
 */

export const evaluationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.INTERVIEW_READ));

  /**
   * Every evaluation on one interview, plus who has not filed.
   *
   * `pending` is a list of names rather than an absent key, because section 12
   * asks for "HR Manager: Pending" to be VISIBLE. A missing evaluation is an
   * absence with a name on it, not a row of zeros, and the two must never be
   * rendered the same way.
   */
  app.get('/:id/evaluations', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    // The interview is reached through the caller's own scope first, so an
    // interviewer cannot read the panel feedback on a conversation they were
    // not part of by guessing an id.
    const interview = await interviewOrThrow(actor, id);

    const [evaluations, participants] = await Promise.all([
      prisma.interviewEvaluation.findMany({
        where: { interviewId: interview.id, companyId: auth.companyId },
        include: EVALUATION_INCLUDE,
        orderBy: { submittedAt: 'asc' },
      }),
      prisma.interviewParticipant.findMany({
        where: { interviewId: interview.id, evaluation: { is: null } },
        include: { employee: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    const summary: InterviewEvaluationSummary = {
      interviewId: interview.id,
      evaluations: evaluations.map((row) => toEvaluationRecord(row, actor.employeeId)),
      pending: participants.map((participant) => ({
        employeeId: participant.employeeId,
        fullName:
          `${participant.employee.firstName} ${participant.employee.lastName}`.trim(),
      })),
    };

    return reply.send({ data: summary });
  });

  /**
   * Filing your own evaluation.
   *
   * An upsert on the caller's own seat: submitting twice revises their own
   * feedback rather than creating a second row or failing. Revising is the
   * right behaviour - an interviewer who remembers something an hour later
   * should not have to ask HR to delete a row - and it is still confined to
   * their own opinion, because the seat is resolved from the session.
   */
  app.post(
    '/:id/evaluations',
    { preHandler: requirePermission(PERMISSIONS.INTERVIEW_EVALUATE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const actor = await resolveActor(auth);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(evaluationInputSchema, request.body);

      const interview = await interviewOrThrow(actor, id);

      if (!canEvaluateInterview(interview.status)) {
        throw new ConflictError(
          `That interview is ${INTERVIEW_STATUS_LABELS[interview.status as InterviewStatus].toLowerCase()}. Feedback can be submitted once it has been marked complete.`,
        );
      }

      const participant = await ownParticipantOrThrow(actor, interview.id);

      const existing = await prisma.interviewEvaluation.findUnique({
        where: { participantId: participant.id },
        select: { id: true },
      });

      const saved = await prisma.interviewEvaluation.upsert({
        where: { participantId: participant.id },
        create: {
          companyId: auth.companyId,
          interviewId: interview.id,
          participantId: participant.id,
          technicalScore: input.technicalScore,
          problemSolvingScore: input.problemSolvingScore,
          communicationScore: input.communicationScore,
          experienceScore: input.experienceScore,
          cultureFitScore: input.cultureFitScore,
          recommendation: input.recommendation,
          comments: input.comments,
        },
        update: {
          technicalScore: input.technicalScore,
          problemSolvingScore: input.problemSolvingScore,
          communicationScore: input.communicationScore,
          experienceScore: input.experienceScore,
          cultureFitScore: input.cultureFitScore,
          recommendation: input.recommendation,
          comments: input.comments,
          submittedAt: new Date(),
        },
        include: EVALUATION_INCLUDE,
      });

      const candidate = await prisma.candidate.findUniqueOrThrow({
        where: { id: interview.candidateId },
        select: { fullName: true, reference: true },
      });
      const detail = await prisma.interview.findUniqueOrThrow({
        where: { id: interview.id },
        select: { type: true },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'interview.evaluation_created',
        entityType: 'Interview',
        entityId: interview.id,
        summary: `${saved.participant.employee.firstName} ${saved.participant.employee.lastName} ${existing ? 'revised their' : 'submitted an'} evaluation for the ${INTERVIEW_TYPE_LABELS[detail.type]} with ${candidate.fullName} (${candidate.reference}): ${INTERVIEW_RECOMMENDATION_LABELS[input.recommendation]}`,
        /*
         * The recommendation and the fact of the scores, not the comments. An
         * interviewer's written opinion of a named person is exactly the kind
         * of thing section 23 means by "do not store unnecessary sensitive
         * information in audit logs" - it lives on the evaluation, which is
         * read behind a permission, rather than in a log read behind another.
         */
        after: {
          recommendation: input.recommendation,
          scored: [
            input.technicalScore,
            input.problemSolvingScore,
            input.communicationScore,
            input.experienceScore,
            input.cultureFitScore,
          ].filter((value) => value !== null).length,
          revised: existing !== null,
        },
        request,
      });

      return reply
        .code(existing ? 200 : 201)
        .send({ data: toEvaluationRecord(saved, actor.employeeId) });
    },
  );

  /**
   * Every evaluation for one candidate, across every interview they sat.
   *
   * The Evaluations tab on the candidate profile. Gated on `interview.read` and
   * narrowed by the same scope as everything else here - so a panellist opening
   * it sees the feedback from the interviews they were on, and HR sees all of
   * it. What nobody gets from this endpoint is a candidate's salary, notes or
   * documents: it carries evaluations.
   */
  app.get('/by-candidate/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const candidate = await prisma.candidate.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true },
    });
    if (!candidate) throw new NotFoundError('Candidate');

    // Only the interviews this caller may read. An interviewer therefore sees
    // their own rounds' feedback and not the rest of the panel's process.
    const visible = await prisma.interview.findMany({
      where: {
        companyId: auth.companyId,
        candidateId: candidate.id,
        ...(actor.canManageInterviews
          ? {}
          : actor.employeeId
            ? { participants: { some: { employeeId: actor.employeeId } } }
            : { id: '__none__' }),
      },
      select: { id: true, type: true, round: true, startsAt: true, status: true },
      orderBy: { startsAt: 'asc' },
    });

    if (visible.length === 0) return reply.send({ data: [] });

    const evaluations = await prisma.interviewEvaluation.findMany({
      where: { interviewId: { in: visible.map((row) => row.id) } },
      include: EVALUATION_INCLUDE,
      orderBy: { submittedAt: 'asc' },
    });

    const byInterview = new Map(visible.map((row) => [row.id, row]));

    return reply.send({
      data: evaluations.map((row) => {
        const interview = byInterview.get(row.interviewId)!;
        return {
          ...toEvaluationRecord(row, actor.employeeId),
          interviewType: interview.type,
          interviewRound: interview.round,
          interviewStartsAt: interview.startsAt.toISOString(),
        };
      }),
    });
  });
};
