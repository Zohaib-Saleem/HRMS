import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  OFFER_STATUS_LABELS,
  PERMISSIONS,
  canTransitionOffer,
  idParamSchema,
  isJobOpeningAccepting,
  offerInputSchema,
  offerQuerySchema,
  offerStatusSchema,
  offerUpdateSchema,
  type JobOpeningStatus,
  type OfferStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { OFFER_INCLUDE, resolveActor, toOfferRecord } from './recruitment.service.js';

/**
 * Offers.
 *
 * Deliberately thin, and section 15 says why: this is not a contract system and
 * it is not payroll. An offer stores what was proposed - a designation, a
 * salary, an employment type, a joining date, a status - and creates NOTHING.
 * Accepting one writes no `EmployeeSalary`, no `PayrollProfile`, no
 * `EmployeeContract` and no employee. A new hire's pay is still set in payroll,
 * by a person, on purpose, after they exist.
 *
 * What the offer DOES do is carry a proposal forward: the conversion endpoint
 * reads the accepted offer to pre-fill the employee form, so the designation
 * and employment status HR agreed with the candidate are the ones suggested
 * rather than re-keyed. Suggested, and then reviewed - see `conversion.routes`.
 *
 * `recruitment.offer.manage` is its own grant, held apart from
 * `recruitment.manage`, because an offer is a commitment about money and the
 * person who arranges interviews need not be the person who makes one.
 *
 * Reading is on `recruitment.read` and is NOT narrowed the way openings are:
 * a plain reader who can reach the module can see the offers list. The figure
 * itself is the sensitive part, so a company that wants offers kept from
 * hiring managers withholds `recruitment.read` - which is the same decision
 * they already make about the dashboard.
 */

function dateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

export const offerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.RECRUITMENT_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(offerQuerySchema, request.query);

    const where: Prisma.OfferWhereInput = {
      AND: [
        { companyId: auth.companyId },
        query.status ? { status: query.status } : {},
        query.candidateId ? { candidateId: query.candidateId } : {},
        query.jobOpeningId ? { jobOpeningId: query.jobOpeningId } : {},
        query.q
          ? { candidate: { fullName: { contains: query.q, mode: 'insensitive' } } }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.offer.count({ where }),
      prisma.offer.findMany({
        where,
        skip,
        take,
        include: OFFER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return reply.send({
      data: rows.map(toOfferRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.offer.findFirst({
      where: { id, companyId: auth.companyId },
      include: OFFER_INCLUDE,
    });
    if (!row) throw new NotFoundError('Offer');

    return reply.send({ data: toOfferRecord(row) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_OFFER_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(offerInputSchema, request.body);

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

      if (input.designationId) {
        const designation = await prisma.designation.findFirst({
          where: { id: input.designationId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!designation) {
          throw new ValidationError({ designationId: ['That designation does not exist.'] });
        }
      }

      /*
       * One live offer per candidate at a time.
       *
       * Two open offers to the same person is not a scenario, it is a mistake -
       * and it is the mistake that produces two different promises about
       * salary. A superseded offer is answered (declined or expired) first,
       * which keeps what it promised on the record.
       */
      const live = await prisma.offer.findFirst({
        where: {
          candidateId: candidate.id,
          companyId: auth.companyId,
          status: { in: ['DRAFT', 'SENT'] },
        },
        select: { id: true, status: true },
      });
      if (live) {
        throw new ConflictError(
          `${candidate.fullName} already has a ${OFFER_STATUS_LABELS[live.status as OfferStatus].toLowerCase()} offer. Answer or withdraw that one first.`,
        );
      }

      const created = await prisma.offer.create({
        data: {
          companyId: auth.companyId,
          candidateId: candidate.id,
          jobOpeningId,
          applicationId,
          designationId: input.designationId,
          proposedTitle: input.proposedTitle,
          employmentType: input.employmentType,
          employmentStatus: input.employmentStatus,
          proposedSalary: input.proposedSalary,
          salaryCurrency: input.salaryCurrency,
          expectedJoiningDate: dateColumn(input.expectedJoiningDate),
          expiresAt: dateColumn(input.expiresAt),
          notes: input.notes,
          status: 'DRAFT',
        },
        include: OFFER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'offer.created',
        entityType: 'Offer',
        entityId: created.id,
        summary: `Drafted an offer for ${candidate.fullName} (${candidate.reference})`,
        /*
         * The terms, but not the figure. A salary is the sensitive part of an
         * offer and the audit log is read behind `audit.read` rather than
         * behind `recruitment.offer.manage` - so the fact of the offer is
         * logged and the money stays on the offer, where the grant that guards
         * it applies.
         */
        after: {
          candidateId: candidate.id,
          jobOpeningId,
          employmentType: input.employmentType,
          employmentStatus: input.employmentStatus,
          expectedJoiningDate: input.expectedJoiningDate,
          salaryProposed: input.proposedSalary !== null,
        },
        request,
      });

      return reply.code(201).send({ data: toOfferRecord(created) });
    },
  );

  /** Editing the terms. Only while nobody has been told about them. */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_OFFER_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(offerUpdateSchema, request.body);

      const before = await prisma.offer.findFirst({
        where: { id, companyId: auth.companyId },
        include: { candidate: { select: { fullName: true } } },
      });
      if (!before) throw new NotFoundError('Offer');

      /*
       * A DRAFT only. Once an offer has been sent, the candidate has seen
       * terms, and editing the record to say something else would leave no
       * trace of what they were actually promised. Changing a sent offer means
       * answering it and making a new one.
       */
      if (before.status !== 'DRAFT') {
        throw new ConflictError(
          `That offer has already been ${OFFER_STATUS_LABELS[before.status as OfferStatus].toLowerCase()}. Make a new offer rather than editing this one.`,
        );
      }

      if (input.designationId) {
        const designation = await prisma.designation.findFirst({
          where: { id: input.designationId, companyId: auth.companyId },
          select: { id: true },
        });
        if (!designation) {
          throw new ValidationError({ designationId: ['That designation does not exist.'] });
        }
      }

      const updated = await prisma.offer.update({
        where: { id: before.id },
        data: {
          ...(input.designationId !== undefined ? { designationId: input.designationId } : {}),
          ...(input.proposedTitle !== undefined ? { proposedTitle: input.proposedTitle } : {}),
          ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
          ...(input.employmentStatus !== undefined
            ? { employmentStatus: input.employmentStatus }
            : {}),
          ...(input.proposedSalary !== undefined ? { proposedSalary: input.proposedSalary } : {}),
          ...(input.salaryCurrency !== undefined ? { salaryCurrency: input.salaryCurrency } : {}),
          ...(input.expectedJoiningDate !== undefined
            ? { expectedJoiningDate: dateColumn(input.expectedJoiningDate) }
            : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: dateColumn(input.expiresAt) } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
        include: OFFER_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'offer.updated',
        entityType: 'Offer',
        entityId: updated.id,
        summary: `Updated the draft offer for ${before.candidate.fullName}`,
        after: {
          employmentType: updated.employmentType,
          employmentStatus: updated.employmentStatus,
          salaryProposed: updated.proposedSalary !== null,
        },
        request,
      });

      return reply.send({ data: toOfferRecord(updated) });
    },
  );

  /**
   * Sending an offer, or recording the answer to one.
   *
   * Checked against the shared transition map, so DRAFT -> ACCEPTED is refused:
   * a candidate cannot accept something nobody sent them, and allowing it would
   * produce a hire with no record of an offer having been made.
   *
   * An ACCEPTED offer moves the candidate's application to OFFER if it is not
   * already there - and stops. It does NOT mark them HIRED and it does not
   * create an employee: somebody accepting an offer and somebody starting work
   * are different days, and conversion is a deliberate, reviewed action behind
   * its own grant.
   */
  app.post(
    '/:id/status',
    { preHandler: requirePermission(PERMISSIONS.RECRUITMENT_OFFER_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(offerStatusSchema, request.body);

      const before = await prisma.offer.findFirst({
        where: { id, companyId: auth.companyId },
        include: { candidate: { select: { id: true, fullName: true, reference: true } } },
      });
      if (!before) throw new NotFoundError('Offer');

      const from = before.status as OfferStatus;
      const to = input.status;

      if (from === to) {
        throw new ConflictError(
          `That offer is already ${OFFER_STATUS_LABELS[to].toLowerCase()}.`,
        );
      }
      if (!canTransitionOffer(from, to)) {
        throw new ConflictError(
          `An offer cannot go from ${OFFER_STATUS_LABELS[from]} to ${OFFER_STATUS_LABELS[to]}.`,
        );
      }

      const answered = to === 'ACCEPTED' || to === 'DECLINED' || to === 'EXPIRED';

      const updated = await prisma.offer.update({
        where: { id: before.id },
        data: {
          status: to,
          ...(to === 'SENT' ? { sentAt: new Date() } : {}),
          ...(answered ? { respondedAt: new Date() } : {}),
          ...(input.reason ? { notes: appendNote(before.notes, input.reason) } : {}),
        },
        include: OFFER_INCLUDE,
      });

      /*
       * Nudging the application to OFFER, and only forward. If the candidate is
       * already at OFFER or beyond, nothing happens - this must never drag
       * somebody BACK from HIRED because an old offer was marked expired.
       */
      if (to === 'SENT' && before.applicationId) {
        await prisma.candidateApplication.updateMany({
          where: {
            id: before.applicationId,
            stage: { in: ['NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED'] },
          },
          data: { stage: 'OFFER', stageChangedAt: new Date(), stageChangedBy: auth.userId },
        });
        await prisma.candidate.updateMany({
          where: {
            id: before.candidateId,
            stage: { in: ['NEW', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'SELECTED'] },
          },
          data: { stage: 'OFFER' },
        });
      }

      const action =
        to === 'ACCEPTED'
          ? 'offer.accepted'
          : to === 'DECLINED'
            ? 'offer.declined'
            : 'offer.updated';

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action,
        entityType: 'Offer',
        entityId: updated.id,
        summary: `Offer for ${before.candidate.fullName} (${before.candidate.reference}): ${OFFER_STATUS_LABELS[from]} -> ${OFFER_STATUS_LABELS[to]}${input.reason ? ` (${input.reason})` : ''}`,
        before: { status: from },
        after: { status: to, reason: input.reason ?? null },
        request,
      });

      return reply.send({ data: toOfferRecord(updated) });
    },
  );
};

/** Keeps the existing note and adds the reason under it, rather than replacing. */
function appendNote(existing: string | null, addition: string): string {
  return existing ? `${existing}\n\n${addition}` : addition;
}

/** The same check the interview routes make, for the same reasons. */
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
      jobOpeningId: ['That opening is not open, so an offer cannot be made against it.'],
    });
  }

  const application = await prisma.candidateApplication.findUnique({
    where: { candidateId_jobOpeningId: { candidateId, jobOpeningId: opening.id } },
    select: { id: true },
  });

  return { jobOpeningId: opening.id, applicationId: application?.id ?? null };
}
