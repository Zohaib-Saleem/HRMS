import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  JOB_OPENING_SORT_FIELDS,
  JOB_OPENING_STATUS_LABELS,
  PERMISSIONS,
  idParamSchema,
  jobOpeningInputSchema,
  jobOpeningQuerySchema,
  jobOpeningStatusSchema,
  jobOpeningUpdateSchema,
  jobOpeningNeedsReason,
  type JobOpeningStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  JOB_OPENING_INCLUDE,
  assertOpeningReferences,
  jobOpeningFilter,
  nextReference,
  resolveActor,
  toJobOpeningRecord,
} from './recruitment.service.js';

/**
 * Job openings: the vacancies a company is hiring for.
 *
 * Two grants and a deliberate gap between them. `recruitment.read` opens this
 * plugin, and on its own it returns the openings the caller is NAMED on - as
 * hiring manager or as recruiter - because a vacancy belongs to the people
 * running it. `recruitment.manage` both widens the reads to the whole company
 * and unlocks every write. The narrowing is a WHERE clause built by
 * `jobOpeningFilter`, so an opening that is not the caller's is absent from the
 * query rather than fetched and then hidden, and a guessed id answers 404.
 *
 * Openings are never deleted. CLOSED and CANCELLED are statuses, they carry a
 * reason, and they keep every application filed against the vacancy - because
 * "we interviewed six people for a job we then cancelled" is a fact about how
 * this company treats candidates, and a DELETE would quietly dispose of it.
 */

/** A date-only string as a `@db.Date` column value, pinned to UTC midnight. */
function dateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

export const jobOpeningRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.RECRUITMENT_READ));

  /**
   * The list.
   *
   * Every filter section 24 asks for - department, team, hiring manager,
   * status, opening date - plus a text search across the title, the reference
   * and the skills. The search is `insensitive` `contains` on three columns
   * rather than a full-text index, which is the honest shape for a table this
   * size and matches what the rest of the product does.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const query = parseOrThrow(jobOpeningQuerySchema, request.query);

    const scope = jobOpeningFilter(actor);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.JobOpeningWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scope,
        query.status ? { status: query.status } : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.teamId ? { teamId: query.teamId } : {},
        query.hiringManagerId ? { hiringManagerId: query.hiringManagerId } : {},
        query.recruiterId ? { recruiterId: query.recruiterId } : {},
        query.from ? { openingDate: { gte: dateColumn(query.from) ?? undefined } } : {},
        query.to ? { openingDate: { lte: dateColumn(query.to) ?? undefined } } : {},
        query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { reference: { contains: query.q, mode: 'insensitive' } },
                { skills: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.jobOpening.count({ where }),
      prisma.jobOpening.findMany({
        where,
        skip,
        take,
        include: JOB_OPENING_INCLUDE,
        orderBy: buildOrderBy(query.sort, query.order, JOB_OPENING_SORT_FIELDS, 'createdAt'),
      }),
    ]);

    /*
     * How many of each opening's applications reached HIRED, in one grouped
     * query rather than one per row. It is the figure that answers "two
     * vacancies, one filled" on the list, and doing it per row would be a
     * query per opening on a page of twenty.
     */
    const hired = await prisma.candidateApplication.groupBy({
      by: ['jobOpeningId'],
      where: { jobOpeningId: { in: rows.map((row) => row.id) }, stage: 'HIRED' },
      _count: { _all: true },
    });
    const hiredByOpening = new Map(hired.map((row) => [row.jobOpeningId, row._count._all]));

    return reply.send({
      data: rows.map((row) => toJobOpeningRecord(row, hiredByOpening.get(row.id) ?? 0)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const scope = jobOpeningFilter(actor);
    if (scope === null) throw new NotFoundError('Job opening');

    const row = await prisma.jobOpening.findFirst({
      where: { AND: [{ id, companyId: auth.companyId }, scope] },
      include: JOB_OPENING_INCLUDE,
    });
    if (!row) throw new NotFoundError('Job opening');

    const hiredCount = await prisma.candidateApplication.count({
      where: { jobOpeningId: row.id, stage: 'HIRED' },
    });

    return reply.send({ data: toJobOpeningRecord(row, hiredCount) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(jobOpeningInputSchema, request.body);

      await assertOpeningReferences(auth.companyId, input);

      /*
       * The reference is generated and retried on the unique index rather than
       * trusted from a read, which is the only arrangement that survives two
       * people creating an opening in the same second - the same approach the
       * lunch order number takes.
       */
      const created = await createWithReference(auth.companyId, async (reference) =>
        prisma.jobOpening.create({
          data: {
            companyId: auth.companyId,
            reference,
            title: input.title,
            departmentId: input.departmentId,
            teamId: input.teamId,
            locationId: input.locationId,
            employmentType: input.employmentType,
            expectedEmploymentStatus: input.expectedEmploymentStatus ?? null,
            vacancies: input.vacancies,
            hiringManagerId: input.hiringManagerId,
            recruiterId: input.recruiterId,
            description: input.description,
            requirements: input.requirements,
            skills: input.skills,
            minExperienceYears: input.minExperienceYears ?? null,
            salaryMin: input.salaryMin,
            salaryMax: input.salaryMax,
            salaryCurrency: input.salaryCurrency,
            openingDate: dateColumn(input.openingDate),
            closingDate: dateColumn(input.closingDate),
            status: input.status,
          },
          include: JOB_OPENING_INCLUDE,
        }),
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'job_opening.created',
        entityType: 'JobOpening',
        entityId: created.id,
        summary: `Created job opening ${created.reference} - ${created.title} (${JOB_OPENING_STATUS_LABELS[created.status as JobOpeningStatus]})`,
        after: {
          reference: created.reference,
          title: created.title,
          vacancies: created.vacancies,
          status: created.status,
          departmentId: created.departmentId,
        },
        request,
      });

      return reply.code(201).send({ data: toJobOpeningRecord(created, 0) });
    },
  );

  /**
   * Editing an opening.
   *
   * The status is deliberately not editable here - it has its own endpoint
   * below, because closing or cancelling needs a reason and a reason attached
   * to a general-purpose save is a reason that gets forgotten.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(jobOpeningUpdateSchema, request.body);

      const before = await prisma.jobOpening.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Job opening');

      await assertOpeningReferences(auth.companyId, input);

      const salaryMin = input.salaryMin !== undefined ? input.salaryMin : Number(before.salaryMin ?? NaN);
      const salaryMax = input.salaryMax !== undefined ? input.salaryMax : Number(before.salaryMax ?? NaN);
      if (
        salaryMin !== null &&
        salaryMax !== null &&
        !Number.isNaN(salaryMin) &&
        !Number.isNaN(salaryMax) &&
        salaryMax < salaryMin
      ) {
        throw new ValidationError({
          salaryMax: ['The top of the range cannot be below the bottom.'],
        });
      }

      const updated = await prisma.jobOpening.update({
        where: { id: before.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
          ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
          ...(input.expectedEmploymentStatus !== undefined
            ? { expectedEmploymentStatus: input.expectedEmploymentStatus ?? null }
            : {}),
          ...(input.vacancies !== undefined ? { vacancies: input.vacancies } : {}),
          ...(input.hiringManagerId !== undefined
            ? { hiringManagerId: input.hiringManagerId }
            : {}),
          ...(input.recruiterId !== undefined ? { recruiterId: input.recruiterId } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.minExperienceYears !== undefined
            ? { minExperienceYears: input.minExperienceYears ?? null }
            : {}),
          ...(input.salaryMin !== undefined ? { salaryMin: input.salaryMin } : {}),
          ...(input.salaryMax !== undefined ? { salaryMax: input.salaryMax } : {}),
          ...(input.salaryCurrency !== undefined ? { salaryCurrency: input.salaryCurrency } : {}),
          ...(input.openingDate !== undefined
            ? { openingDate: dateColumn(input.openingDate) }
            : {}),
          ...(input.closingDate !== undefined
            ? { closingDate: dateColumn(input.closingDate) }
            : {}),
        },
        include: JOB_OPENING_INCLUDE,
      });

      const changes = diff(
        {
          title: before.title,
          departmentId: before.departmentId,
          teamId: before.teamId,
          locationId: before.locationId,
          vacancies: before.vacancies,
          hiringManagerId: before.hiringManagerId,
          recruiterId: before.recruiterId,
          employmentType: before.employmentType,
          expectedEmploymentStatus: before.expectedEmploymentStatus,
        },
        {
          title: updated.title,
          departmentId: updated.departmentId,
          teamId: updated.teamId,
          locationId: updated.locationId,
          vacancies: updated.vacancies,
          hiringManagerId: updated.hiringManagerId,
          recruiterId: updated.recruiterId,
          employmentType: updated.employmentType,
          expectedEmploymentStatus: updated.expectedEmploymentStatus,
        },
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'job_opening.updated',
        entityType: 'JobOpening',
        entityId: updated.id,
        summary: `Updated job opening ${updated.reference} - ${updated.title}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      const hiredCount = await prisma.candidateApplication.count({
        where: { jobOpeningId: updated.id, stage: 'HIRED' },
      });

      return reply.send({ data: toJobOpeningRecord(updated, hiredCount) });
    },
  );

  /**
   * Moving an opening's status.
   *
   * Its own endpoint because closing and cancelling need a reason, and because
   * the two endings are worth auditing under their own verb rather than as
   * "updated". `job_opening.closed` is what an HR report looks for; finding it
   * buried in a diff of fifteen fields would be worse than not recording it.
   */
  app.post(
    '/:id/status',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(jobOpeningStatusSchema, request.body);

      const before = await prisma.jobOpening.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, reference: true, title: true, status: true },
      });
      if (!before) throw new NotFoundError('Job opening');

      if (before.status === input.status) {
        throw new ConflictError(
          `That opening is already ${JOB_OPENING_STATUS_LABELS[input.status].toLowerCase()}.`,
        );
      }

      if (jobOpeningNeedsReason(input.status) && !input.reason) {
        throw new ValidationError({
          reason: ['Say why the opening is being closed or cancelled.'],
        });
      }

      const terminal = jobOpeningNeedsReason(input.status);

      const updated = await prisma.jobOpening.update({
        where: { id: before.id },
        data: {
          status: input.status,
          // Cleared when an opening is re-opened, so a reason never outlives
          // the ending it explains.
          closedAt: terminal ? new Date() : null,
          closedReason: terminal ? input.reason : null,
        },
        include: JOB_OPENING_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: input.status === 'CLOSED' ? 'job_opening.closed' : 'job_opening.updated',
        entityType: 'JobOpening',
        entityId: updated.id,
        summary: `${before.reference} - ${before.title}: ${JOB_OPENING_STATUS_LABELS[before.status as JobOpeningStatus]} -> ${JOB_OPENING_STATUS_LABELS[input.status]}${input.reason ? ` (${input.reason})` : ''}`,
        before: { status: before.status },
        after: { status: input.status, reason: input.reason ?? null },
        request,
      });

      const hiredCount = await prisma.candidateApplication.count({
        where: { jobOpeningId: updated.id, stage: 'HIRED' },
      });

      return reply.send({ data: toJobOpeningRecord(updated, hiredCount) });
    },
  );

  /**
   * The pipeline for one opening: every candidate against it, by stage.
   *
   * Reachable with `recruitment.read` on an opening the caller may see, and it
   * carries no restricted candidate field at all - name, stage, when they moved
   * and nothing else. A hiring manager can therefore see their own board
   * without holding a candidate grant, and still cannot see what anybody on it
   * is earning.
   */
  app.get('/:id/pipeline', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const scope = jobOpeningFilter(actor);
    if (scope === null) throw new NotFoundError('Job opening');

    const opening = await prisma.jobOpening.findFirst({
      where: { AND: [{ id, companyId: auth.companyId }, scope] },
      select: { id: true },
    });
    if (!opening) throw new NotFoundError('Job opening');

    const applications = await prisma.candidateApplication.findMany({
      where: { jobOpeningId: opening.id, companyId: auth.companyId },
      orderBy: { stageChangedAt: 'desc' },
      select: {
        id: true,
        stage: true,
        stageChangedAt: true,
        appliedAt: true,
        outcomeReason: true,
        candidate: { select: { id: true, fullName: true, reference: true } },
      },
    });

    return reply.send({
      data: applications.map((application) => ({
        applicationId: application.id,
        candidateId: application.candidate.id,
        candidateName: application.candidate.fullName,
        candidateReference: application.candidate.reference,
        stage: application.stage,
        stageChangedAt: application.stageChangedAt.toISOString(),
        appliedAt: application.appliedAt.toISOString(),
        outcomeReason: application.outcomeReason,
      })),
    });
  });
};

/**
 * Creates a row with a generated reference, retrying on a collision.
 *
 * The generator reads the highest reference issued so far, which two
 * simultaneous creates would both read as the same number. The unique index is
 * what actually decides, and this is what turns its rejection into a second
 * attempt rather than a 500 - the same arrangement the lunch order number uses.
 */
async function createWithReference<T>(
  companyId: string,
  create: (reference: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = await nextReference(companyId, 'job');
    try {
      return await create(reference);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'P2002' || attempt === 4) throw error;
    }
  }
  throw new ConflictError('Could not allocate a reference for that opening. Try again.');
}
