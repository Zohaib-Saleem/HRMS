import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  CANDIDATE_SORT_FIELDS,
  CANDIDATE_STAGE_LABELS,
  CANDIDATE_TERMINAL_STAGES,
  INTERVIEW_TYPE_LABELS,
  OFFER_STATUS_LABELS,
  PERMISSIONS,
  applicationCreateSchema,
  candidateInputSchema,
  candidateQuerySchema,
  candidateUpdateSchema,
  canTransitionCandidate,
  idParamSchema,
  isJobOpeningAccepting,
  stageChangeSchema,
  stageNeedsReason,
  type CandidateStage,
  type CandidateTimelineEntry,
  type JobOpeningStatus,
} from '@hrms/shared';
import { z } from 'zod';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  CANDIDATE_INCLUDE,
  nextReference,
  refreshCandidateStage,
  resolveActor,
  toCandidateRecord,
} from './recruitment.service.js';

/**
 * Candidates: people who have applied, and the pipeline they move through.
 *
 * The rule this whole file exists to hold is the one in section 3 and section
 * 5: A CANDIDATE IS NOT AN EMPLOYEE, AND IS NOT DUPLICATED PER VACANCY.
 * Nothing here writes to the employees table - that is `conversion.routes.ts`,
 * behind its own grant - and a person who applies for three roles is one
 * candidate row with three applications, which is what the unique index on
 * (companyId, email) enforces and what `POST /` turns into a readable error
 * rather than a 500.
 *
 * Two grants, and the gap between them is where candidate privacy lives.
 * `candidate.read` opens this plugin and returns everything about a candidate
 * EXCEPT the restricted block - what they earn now, what they are asking for,
 * and the notes HR has written. `candidate.manage` restores that block and
 * unlocks every write. The block is OMITTED from the response rather than
 * nulled, so a reader can tell "you may not see this" from "we do not know".
 *
 * The stage lives on the APPLICATION. `Candidate.stage` is a derived summary
 * kept for the list screen and recomputed by `refreshCandidateStage` after
 * every move; no decision anywhere reads it.
 */

export const candidateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.CANDIDATE_READ));

  /**
   * The list, with every filter section 24 asks for.
   *
   * The text search spans name, email, phone and reference; skills have their
   * own parameter because "React" as a skill and "React" in somebody's name are
   * different questions. Filtering by job opening or department goes through
   * the applications relation, which is what makes "who is in the pipeline for
   * Development" answerable without denormalising a department onto a person.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(candidateQuerySchema, request.query);

    const applicationFilter: Prisma.CandidateApplicationWhereInput = {
      ...(query.jobOpeningId ? { jobOpeningId: query.jobOpeningId } : {}),
      ...(query.departmentId ? { jobOpening: { departmentId: query.departmentId } } : {}),
    };
    const hasApplicationFilter = Object.keys(applicationFilter).length > 0;

    const where: Prisma.CandidateWhereInput = {
      AND: [
        { companyId: auth.companyId },
        query.stage ? { stage: query.stage } : {},
        query.recruiterId ? { recruiterId: query.recruiterId } : {},
        query.skills ? { skills: { contains: query.skills, mode: 'insensitive' } } : {},
        query.live === 'true' ? { stage: { notIn: [...CANDIDATE_TERMINAL_STAGES] } } : {},
        hasApplicationFilter ? { applications: { some: applicationFilter } } : {},
        query.q
          ? {
              OR: [
                { fullName: { contains: query.q, mode: 'insensitive' } },
                { email: { contains: query.q, mode: 'insensitive' } },
                { phone: { contains: query.q, mode: 'insensitive' } },
                { reference: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.candidate.count({ where }),
      prisma.candidate.findMany({
        where,
        skip,
        take,
        include: CANDIDATE_INCLUDE,
        orderBy: buildOrderBy(query.sort, query.order, CANDIDATE_SORT_FIELDS, 'createdAt'),
      }),
    ]);

    return reply.send({
      data: rows.map((row) => toCandidateRecord(row, actor.canManageCandidates)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * The board.
   *
   * Every live candidate, grouped into the seven pipeline columns. Deliberately
   * not paginated: a board with a "next page" is not a board, and the query is
   * bounded by excluding the terminal stages plus a hard ceiling, so a company
   * with four thousand historical CVs does not render four thousand cards.
   */
  app.get('/board', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(
      z.object({
        jobOpeningId: z.string().trim().max(64).optional(),
        departmentId: z.string().trim().max(64).optional(),
        recruiterId: z.string().trim().max(64).optional(),
      }),
      request.query,
    );

    const applicationFilter: Prisma.CandidateApplicationWhereInput = {
      ...(query.jobOpeningId ? { jobOpeningId: query.jobOpeningId } : {}),
      ...(query.departmentId ? { jobOpening: { departmentId: query.departmentId } } : {}),
    };
    const hasApplicationFilter = Object.keys(applicationFilter).length > 0;

    const rows = await prisma.candidate.findMany({
      where: {
        AND: [
          { companyId: auth.companyId },
          { stage: { notIn: [...CANDIDATE_TERMINAL_STAGES] } },
          query.recruiterId ? { recruiterId: query.recruiterId } : {},
          hasApplicationFilter ? { applications: { some: applicationFilter } } : {},
        ],
      },
      include: CANDIDATE_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 400,
    });

    return reply.send({
      data: rows.map((row) => toCandidateRecord(row, actor.canManageCandidates)),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.candidate.findFirst({
      where: { id, companyId: auth.companyId },
      include: CANDIDATE_INCLUDE,
    });
    if (!row) throw new NotFoundError('Candidate');

    return reply.send({ data: toCandidateRecord(row, actor.canManageCandidates) });
  });

  /**
   * Adding a candidate, optionally against a vacancy in the same action.
   *
   * The optional `jobOpeningId` is section 29's flow made real: a recruiter
   * adding somebody for a specific job should not have to save a person and
   * then go and attach them to a role on a second screen.
   *
   * A duplicate email is a FIELD ERROR naming the existing candidate, not a
   * 500 and not a second row. That is the whole of the "do not duplicate the
   * candidate record for every job" rule, and it is held by the database.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(candidateInputSchema, request.body);

      const clash = await prisma.candidate.findFirst({
        where: { companyId: auth.companyId, email: input.email },
        select: { id: true, fullName: true, reference: true },
      });
      if (clash) {
        throw new ValidationError({
          email: [
            `${clash.fullName} (${clash.reference}) already has that email address. Add them to the job opening instead of creating a second record.`,
          ],
        });
      }

      if (input.recruiterId) {
        const recruiter = await prisma.employee.findFirst({
          where: { id: input.recruiterId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!recruiter) {
          throw new ValidationError({ recruiterId: ['That employee does not exist.'] });
        }
      }

      const opening = input.jobOpeningId
        ? await assertOpeningAccepts(auth.companyId, input.jobOpeningId)
        : null;

      const created = await createCandidateWithReference(auth.companyId, (reference) =>
        prisma.candidate.create({
          data: {
            companyId: auth.companyId,
            reference,
            fullName: input.fullName,
            email: input.email,
            phone: input.phone,
            currentLocation: input.currentLocation,
            linkedinUrl: input.linkedinUrl,
            portfolioUrl: input.portfolioUrl,
            skills: input.skills,
            experienceYears: input.experienceYears ?? null,
            currentCompany: input.currentCompany,
            currentTitle: input.currentTitle,
            currentSalary: input.currentSalary,
            expectedSalary: input.expectedSalary,
            salaryCurrency: input.salaryCurrency,
            noticePeriodDays: input.noticePeriodDays ?? null,
            source: input.source,
            notes: input.notes,
            recruiterId: input.recruiterId,
            stage: 'NEW',
            ...(opening
              ? {
                  applications: {
                    create: {
                      companyId: auth.companyId,
                      jobOpeningId: opening.id,
                      stage: 'NEW',
                      stageChangedBy: auth.userId,
                    },
                  },
                }
              : {}),
          },
          include: CANDIDATE_INCLUDE,
        }),
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'candidate.created',
        entityType: 'Candidate',
        entityId: created.id,
        summary: `Added candidate ${created.fullName} (${created.reference})${opening ? ` for ${opening.title}` : ''}`,
        // Facts about the record, never the restricted block: the audit log is
        // read by people who may not hold `candidate.manage`, and what somebody
        // is asking to be paid is not a fact that belongs in it.
        after: {
          reference: created.reference,
          fullName: created.fullName,
          source: created.source,
          jobOpeningId: opening?.id ?? null,
        },
        request,
      });

      return reply.code(201).send({ data: toCandidateRecord(created, true) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(candidateUpdateSchema, request.body);

      const before = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Candidate');

      if (input.email !== undefined && input.email !== before.email) {
        const clash = await prisma.candidate.findFirst({
          where: { companyId: auth.companyId, email: input.email, NOT: { id: before.id } },
          select: { reference: true, fullName: true },
        });
        if (clash) {
          throw new ValidationError({
            email: [`${clash.fullName} (${clash.reference}) already has that email address.`],
          });
        }
      }

      if (input.recruiterId) {
        const recruiter = await prisma.employee.findFirst({
          where: { id: input.recruiterId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!recruiter) {
          throw new ValidationError({ recruiterId: ['That employee does not exist.'] });
        }
      }

      const updated = await prisma.candidate.update({
        where: { id: before.id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.currentLocation !== undefined
            ? { currentLocation: input.currentLocation }
            : {}),
          ...(input.linkedinUrl !== undefined ? { linkedinUrl: input.linkedinUrl } : {}),
          ...(input.portfolioUrl !== undefined ? { portfolioUrl: input.portfolioUrl } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.experienceYears !== undefined
            ? { experienceYears: input.experienceYears ?? null }
            : {}),
          ...(input.currentCompany !== undefined ? { currentCompany: input.currentCompany } : {}),
          ...(input.currentTitle !== undefined ? { currentTitle: input.currentTitle } : {}),
          ...(input.currentSalary !== undefined ? { currentSalary: input.currentSalary } : {}),
          ...(input.expectedSalary !== undefined ? { expectedSalary: input.expectedSalary } : {}),
          ...(input.salaryCurrency !== undefined ? { salaryCurrency: input.salaryCurrency } : {}),
          ...(input.noticePeriodDays !== undefined
            ? { noticePeriodDays: input.noticePeriodDays ?? null }
            : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.recruiterId !== undefined ? { recruiterId: input.recruiterId } : {}),
        },
        include: CANDIDATE_INCLUDE,
      });

      /*
       * The diff deliberately excludes the restricted columns. A salary change
       * IS recorded - the `changed` list below names the field - but the
       * before and after VALUES are not written into a log that a holder of
       * `audit.read` alone can open. Section 23 asks for exactly this: audit
       * the action, not the sensitive payload.
       */
      const changes = diff(
        {
          fullName: before.fullName,
          email: before.email,
          phone: before.phone,
          currentLocation: before.currentLocation,
          skills: before.skills,
          experienceYears: before.experienceYears,
          currentCompany: before.currentCompany,
          source: before.source,
          recruiterId: before.recruiterId,
        },
        {
          fullName: updated.fullName,
          email: updated.email,
          phone: updated.phone,
          currentLocation: updated.currentLocation,
          skills: updated.skills,
          experienceYears: updated.experienceYears,
          currentCompany: updated.currentCompany,
          source: updated.source,
          recruiterId: updated.recruiterId,
        },
      );

      const restrictedTouched = [
        input.currentSalary !== undefined && Number(before.currentSalary ?? NaN) !== input.currentSalary,
        input.expectedSalary !== undefined && Number(before.expectedSalary ?? NaN) !== input.expectedSalary,
        input.notes !== undefined && before.notes !== input.notes,
      ].some(Boolean);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'candidate.updated',
        entityType: 'Candidate',
        entityId: updated.id,
        summary: `Updated candidate ${updated.fullName} (${updated.reference})${restrictedTouched ? ', including restricted details' : ''}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: toCandidateRecord(updated, true) });
    },
  );

  /** Putting an existing candidate against another vacancy. */
  app.post(
    '/:id/applications',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(applicationCreateSchema, request.body);

      const candidate = await prisma.candidate.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, fullName: true, reference: true },
      });
      if (!candidate) throw new NotFoundError('Candidate');

      const opening = await assertOpeningAccepts(auth.companyId, input.jobOpeningId);

      const existing = await prisma.candidateApplication.findUnique({
        where: {
          candidateId_jobOpeningId: { candidateId: candidate.id, jobOpeningId: opening.id },
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(`${candidate.fullName} has already applied for ${opening.title}.`);
      }

      const created = await prisma.candidateApplication.create({
        data: {
          companyId: auth.companyId,
          candidateId: candidate.id,
          jobOpeningId: opening.id,
          stage: 'NEW',
          stageChangedBy: auth.userId,
        },
      });

      await refreshCandidateStage(candidate.id);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'candidate.updated',
        entityType: 'Candidate',
        entityId: candidate.id,
        summary: `${candidate.fullName} (${candidate.reference}) applied for ${opening.reference} - ${opening.title}`,
        after: { applicationId: created.id, jobOpeningId: opening.id },
        request,
      });

      const row = await prisma.candidate.findUniqueOrThrow({
        where: { id: candidate.id },
        include: CANDIDATE_INCLUDE,
      });

      return reply.code(201).send({ data: toCandidateRecord(row, true) });
    },
  );

  /**
   * Moving an application along the pipeline.
   *
   * The stage is written to the APPLICATION, checked against the shared
   * transition map, and the candidate's summary stage is recomputed from it.
   * Three things follow from that and all three are deliberate:
   *
   *   - the transition map is shared, so a move the UI offers is a move the
   *     server allows, and a move it does not offer is refused here regardless
   *     of what the request says;
   *   - REJECTED and WITHDRAWN require a reason, because a rejection with no
   *     reason is the answer nobody can use when the CV arrives again;
   *   - HIRED is reachable only from OFFER, and reaching it does NOT create an
   *     employee. Conversion is a separate, permissioned, reviewed action.
   */
  app.post(
    '/applications/:id/stage',
    { preHandler: requirePermission(PERMISSIONS.CANDIDATE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(stageChangeSchema, request.body);

      const application = await prisma.candidateApplication.findFirst({
        where: { id, companyId: auth.companyId },
        include: {
          candidate: { select: { id: true, fullName: true, reference: true } },
          jobOpening: { select: { id: true, title: true, reference: true } },
        },
      });
      if (!application) throw new NotFoundError('Application');

      const from = application.stage as CandidateStage;
      const to = input.stage;

      if (from === to) {
        throw new ConflictError(
          `${application.candidate.fullName} is already at ${CANDIDATE_STAGE_LABELS[to]}.`,
        );
      }

      if (!canTransitionCandidate(from, to)) {
        throw new ConflictError(
          `A candidate cannot go from ${CANDIDATE_STAGE_LABELS[from]} to ${CANDIDATE_STAGE_LABELS[to]}.`,
        );
      }

      if (stageNeedsReason(to) && !input.reason) {
        throw new ValidationError({
          reason: [`Say why ${application.candidate.fullName} is being marked ${CANDIDATE_STAGE_LABELS[to].toLowerCase()}.`],
        });
      }

      await prisma.candidateApplication.update({
        where: { id: application.id },
        data: {
          stage: to,
          stageChangedAt: new Date(),
          stageChangedBy: auth.userId,
          // Cleared on the way back out of a terminal stage, so a reason never
          // outlives the outcome it explains.
          outcomeReason: stageNeedsReason(to) ? (input.reason ?? null) : null,
        },
      });

      await refreshCandidateStage(application.candidateId);

      /*
       * Its own audit verb per outcome. Section 23 asks for
       * candidate.stage_changed, candidate.rejected and candidate.withdrawn
       * separately, and they are genuinely different questions: "how does our
       * pipeline move" versus "who did we turn down, and why".
       */
      const action =
        to === 'REJECTED'
          ? 'candidate.rejected'
          : to === 'WITHDRAWN'
            ? 'candidate.withdrawn'
            : 'candidate.stage_changed';

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action,
        entityType: 'Candidate',
        entityId: application.candidateId,
        summary: `${application.candidate.fullName} (${application.candidate.reference}) for ${application.jobOpening.title}: ${CANDIDATE_STAGE_LABELS[from]} -> ${CANDIDATE_STAGE_LABELS[to]}${input.reason ? ` (${input.reason})` : ''}`,
        before: { stage: from },
        after: { stage: to, reason: input.reason ?? null, applicationId: application.id },
        request,
      });

      const row = await prisma.candidate.findUniqueOrThrow({
        where: { id: application.candidateId },
        include: CANDIDATE_INCLUDE,
      });
      const actor = await resolveActor(auth);

      return reply.send({ data: toCandidateRecord(row, actor.canManageCandidates) });
    },
  );

  /**
   * The candidate's timeline.
   *
   * A READ layer over rows other tables already own - applications, interviews,
   * evaluations, offers, documents - normalised into one shape and sorted. No
   * timeline table, no write path, so it cannot disagree with what it
   * describes. The same reasoning the employee timeline is built on.
   *
   * What it does NOT contain is any restricted value: an offer's salary is
   * absent from the entry and the CONFIDENTIAL documents are filtered out for a
   * caller without `candidate.manage`, so the timeline cannot become a way
   * around the restricted block.
   */
  app.get('/:id/timeline', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const candidate = await prisma.candidate.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, fullName: true, createdAt: true, hiredAt: true, hiredEmployeeId: true },
    });
    if (!candidate) throw new NotFoundError('Candidate');

    const [applications, interviews, offers, documents, scheduleChanges, evaluations] =
      await Promise.all([
        prisma.candidateApplication.findMany({
          where: { candidateId: candidate.id },
          include: { jobOpening: { select: { title: true } } },
        }),
        prisma.interview.findMany({
          where: { candidateId: candidate.id },
          include: { jobOpening: { select: { title: true } } },
        }),
        prisma.offer.findMany({ where: { candidateId: candidate.id } }),
        prisma.candidateDocument.findMany({
          where: {
            candidateId: candidate.id,
            // A confidential file is absent from an ordinary reader's timeline
            // the way it is absent from their document list.
            ...(actor.canManageCandidates ? {} : { isConfidential: false }),
          },
          include: { uploadedBy: { select: { firstName: true, lastName: true } } },
        }),
        prisma.interviewScheduleChange.findMany({
          where: { interview: { candidateId: candidate.id } },
        }),
        prisma.interviewEvaluation.findMany({
          where: { interview: { candidateId: candidate.id } },
          include: {
            participant: {
              include: { employee: { select: { firstName: true, lastName: true } } },
            },
          },
        }),
      ]);

    const entries: CandidateTimelineEntry[] = [
      {
        at: candidate.createdAt.toISOString(),
        kind: 'CANDIDATE_CREATED',
        title: 'Candidate created',
        detail: null,
        actorName: null,
      },
    ];

    for (const application of applications) {
      entries.push({
        at: application.appliedAt.toISOString(),
        kind: 'APPLIED',
        title: `Applied for ${application.jobOpening.title}`,
        detail: null,
        actorName: null,
      });
      // The stage change is only worth an entry once it has actually moved.
      if (application.stageChangedAt.getTime() !== application.appliedAt.getTime()) {
        entries.push({
          at: application.stageChangedAt.toISOString(),
          kind: 'STAGE_CHANGED',
          title: `${CANDIDATE_STAGE_LABELS[application.stage as CandidateStage]} - ${application.jobOpening.title}`,
          detail: application.outcomeReason,
          actorName: null,
        });
      }
    }

    for (const interview of interviews) {
      entries.push({
        at: interview.createdAt.toISOString(),
        kind: 'INTERVIEW_SCHEDULED',
        title: `${INTERVIEW_TYPE_LABELS[interview.type]} scheduled`,
        detail: interview.jobOpening?.title ?? null,
        actorName: null,
      });
      if (interview.completedAt) {
        entries.push({
          at: interview.completedAt.toISOString(),
          kind: 'INTERVIEW_COMPLETED',
          title: `${INTERVIEW_TYPE_LABELS[interview.type]} completed`,
          detail: null,
          actorName: null,
        });
      }
      if (interview.cancelledAt) {
        entries.push({
          at: interview.cancelledAt.toISOString(),
          kind: 'INTERVIEW_CANCELLED',
          title: `${INTERVIEW_TYPE_LABELS[interview.type]} cancelled`,
          detail: interview.cancelledReason,
          actorName: null,
        });
      }
    }

    for (const change of scheduleChanges) {
      entries.push({
        at: change.createdAt.toISOString(),
        kind: 'INTERVIEW_RESCHEDULED',
        title: 'Interview rescheduled',
        detail: change.reason,
        actorName: null,
      });
    }

    for (const evaluation of evaluations) {
      entries.push({
        at: evaluation.submittedAt.toISOString(),
        kind: 'EVALUATION_SUBMITTED',
        title: 'Evaluation submitted',
        detail: `${evaluation.participant.employee.firstName} ${evaluation.participant.employee.lastName}`.trim(),
        actorName: null,
      });
    }

    for (const offer of offers) {
      entries.push({
        at: offer.createdAt.toISOString(),
        kind: 'OFFER_CREATED',
        title: 'Offer drafted',
        // Deliberately no salary. An offer's figure is a restricted value and
        // the timeline is not a way around the restricted block.
        detail: offer.proposedTitle,
        actorName: null,
      });
      if (offer.sentAt) {
        entries.push({
          at: offer.sentAt.toISOString(),
          kind: 'OFFER_SENT',
          title: 'Offer sent',
          detail: null,
          actorName: null,
        });
      }
      if (offer.respondedAt) {
        entries.push({
          at: offer.respondedAt.toISOString(),
          kind: 'OFFER_ANSWERED',
          title: `Offer ${OFFER_STATUS_LABELS[offer.status as keyof typeof OFFER_STATUS_LABELS].toLowerCase()}`,
          detail: null,
          actorName: null,
        });
      }
    }

    for (const document of documents) {
      entries.push({
        at: document.createdAt.toISOString(),
        kind: 'DOCUMENT_UPLOADED',
        title: `Uploaded ${document.fileName}`,
        detail: null,
        actorName: document.uploadedBy
          ? `${document.uploadedBy.firstName} ${document.uploadedBy.lastName}`.trim()
          : null,
      });
    }

    if (candidate.hiredAt) {
      entries.push({
        at: candidate.hiredAt.toISOString(),
        kind: 'CONVERTED_TO_EMPLOYEE',
        title: 'Converted to an employee',
        detail: null,
        actorName: null,
      });
    }

    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    return reply.send({ data: entries });
  });
};

/**
 * Proves a vacancy exists here and is still taking candidates.
 *
 * The company id in the WHERE is what stops an opening from another
 * installation being named; the status check is what stops somebody being
 * filed against a cancelled vacancy, which would put them on a board for a job
 * that is not happening.
 */
async function assertOpeningAccepts(
  companyId: string,
  jobOpeningId: string,
): Promise<{ id: string; title: string; reference: string }> {
  const opening = await prisma.jobOpening.findFirst({
    where: { id: jobOpeningId, companyId },
    select: { id: true, title: true, reference: true, status: true },
  });
  if (!opening) {
    throw new ValidationError({ jobOpeningId: ['That job opening does not exist.'] });
  }
  if (!isJobOpeningAccepting(opening.status as JobOpeningStatus)) {
    throw new ValidationError({
      jobOpeningId: ['That opening is not accepting candidates. Only an Open vacancy can.'],
    });
  }
  return { id: opening.id, title: opening.title, reference: opening.reference };
}

/** Generates a candidate reference and retries on the unique index. */
async function createCandidateWithReference<T>(
  companyId: string,
  create: (reference: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = await nextReference(companyId, 'candidate');
    try {
      return await create(reference);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'P2002' || attempt === 4) throw error;
    }
  }
  throw new ConflictError('Could not allocate a reference for that candidate. Try again.');
}
