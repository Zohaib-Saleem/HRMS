import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  MEDICAL_CATEGORY_LABELS,
  PERMISSIONS,
  idParamSchema,
  medicalClaimAssessmentQuerySchema,
  medicalClaimCancelSchema,
  medicalClaimDecisionSchema,
  medicalClaimPaySchema,
  medicalClaimQuerySchema,
  medicalClaimRejectSchema,
  medicalClaimSubmitSchema,
  splitContribution,
  type MedicalClaimDocumentType,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { notify } from '../../core/notifications/notification.service.js';
import { toCategoryRecords } from './medical-policy.service.js';
import { resolveMedicalSubject } from './medical.service.js';
import {
  CLAIM_INCLUDE,
  assessMedicalClaim,
  nextClaimNumber,
  toClaimDetail,
  toClaimRecord,
  withReviewerNames,
  type ClaimCallerContext,
  type ClaimRow,
} from './medical-claim.service.js';
import { currentMedicalPolicy } from './medical-policy.service.js';

/**
 * Medical claims.
 *
 * The life of a claim, and what each state costs:
 *
 *   PENDING             submitted           nothing paid; the amount is reserved
 *   APPROVED            agreed in full      nothing paid yet
 *   PARTIALLY_APPROVED  agreed for less     nothing paid yet
 *   PAID                money has gone out
 *   REJECTED/CANCELLED                      nothing paid, nothing reserved
 *
 * Agreeing a claim and paying it are separate acts, exactly as approving a loan
 * and releasing it are. The person who decides that money is owed need not be
 * the person who records that it left, and `medical.claim.approve` and
 * `medical.manage` are held separately so a company can keep them apart.
 *
 * THE ONE DEPARTURE FROM THE HOUSE PATTERN, stated plainly because it is
 * deliberate: a medical claim does NOT go through the shared approval engine.
 * That engine routes a request to the requester's line manager, and a claim
 * carries a treatment category, a provider and a dependent's name. A manager
 * has no business seeing any of it - the whole medical module is built so a
 * manager's reporting line reaches their own record and stops. Routing claims
 * through them would undo that in one line. So claims are decided by holders of
 * `medical.claim.approve`, which HR holds and a manager does not.
 */

const employeeLabel = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const round2 = (n: number) => Math.round(n * 100) / 100;
const toNumber = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);
const format = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

async function callerContext(auth: {
  companyId: string;
  userId: string;
  permissions: ReadonlySet<string>;
}): Promise<ClaimCallerContext> {
  const [self, company, policy] = await Promise.all([
    prisma.employee.findFirst({
      where: { companyId: auth.companyId, userId: auth.userId },
      select: { id: true },
    }),
    prisma.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { currency: true },
    }),
    currentMedicalPolicy(auth.companyId),
  ]);

  return {
    employeeId: self?.id ?? null,
    canDecide: auth.permissions.has(PERMISSIONS.MEDICAL_CLAIM_APPROVE),
    canManage: auth.permissions.has(PERMISSIONS.MEDICAL_MANAGE),
    currency: company.currency,
    allowEmployeeCancel: policy.allowEmployeeCancelPending,
  };
}

/** The claim, or a 404 that does not confirm another company's ids. */
async function claimOrThrow(companyId: string, id: string): Promise<ClaimRow> {
  const row = await prisma.medicalClaim.findFirst({
    where: { id, companyId },
    include: CLAIM_INCLUDE,
  });
  if (!row) throw new NotFoundError('Medical claim');
  return row;
}

/**
 * Refuse a claim the policy does not allow.
 *
 * The gate, and the only one that counts. The browser runs the same assessment
 * to draw its form, but nothing it sends is trusted here: the subject, the
 * policy, the dependents and every claim already on file are re-read inside
 * `assessMedicalClaim`, so a forged preview, an edited limit or a hand-rolled
 * POST all meet the same answer.
 *
 * `override` is how an authorised user allows a claim the rules refused - a
 * hardship case, a decision taken above them. It is refused in turn unless the
 * policy permits overrides, and the reason is mandatory when the policy says
 * so: an unexplained exception to a financial control is worth less than no
 * exception at all.
 */
async function assertClaimAllowed(input: {
  companyId: string;
  employeeId: string;
  category: Parameters<typeof assessMedicalClaim>[0]['category'];
  dependentId: string | null;
  treatmentDate: string | null;
  requestedAmount: number;
  documentTypes: readonly MedicalClaimDocumentType[];
  providerName: string | null;
  policy?: Awaited<ReturnType<typeof currentMedicalPolicy>>;
  excludeClaimId?: string;
  override?: { by: string; reason: string | null; request: FastifyRequest } | null;
}): Promise<void> {
  const result = await assessMedicalClaim({
    companyId: input.companyId,
    employeeId: input.employeeId,
    category: input.category,
    dependentId: input.dependentId,
    treatmentDate: input.treatmentDate,
    requestedAmount: input.requestedAmount,
    documentTypes: input.documentTypes,
    providerName: input.providerName,
    policy: input.policy,
    excludeClaimId: input.excludeClaimId,
  });

  if (result.allowed) return;

  const override = input.override ?? null;
  if (!override) {
    throw new ValidationError({ requestedAmount: result.reasons });
  }

  if (!result.overrideAllowed) {
    throw new ForbiddenError('The medical policy does not allow claim decisions to be overridden.');
  }
  if (result.requireOverrideReason && !override.reason) {
    throw new ValidationError({ overrideReason: ['Say why this claim is being allowed through.'] });
  }

  await recordAudit({
    companyId: input.companyId,
    actorId: override.by,
    action: 'medical.claim.override',
    entityType: 'Employee',
    entityId: input.employeeId,
    summary: `Overrode ${result.failedRules.length} medical claim rule(s): ${result.failedRules.join(', ')}`,
    after: {
      failedRules: result.failedRules,
      reasons: result.reasons,
      reason: override.reason,
      requestedAmount: input.requestedAmount,
      category: input.category,
    },
    request: override.request,
  });
}

export const medicalClaimRoutes: FastifyPluginAsync = async (app) => {
  /*
   * One gate for the whole plugin, then a second, narrower one per route.
   * `medical.read` gets you to the module; whose claims you can actually see is
   * decided by `resolveMedicalSubject` and by the scope filter below.
   */
  app.addHook('preHandler', requirePermission(PERMISSIONS.MEDICAL_READ));

  /**
   * The claims list.
   *
   * An employee sees their own and nothing else - not because the query says
   * so, but because a caller without medical oversight is pinned to their own
   * employee id before the query is built. A wide data scope does not widen
   * this.
   */
  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(medicalClaimQuerySchema, request.query);
    const caller = await callerContext(auth);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const oversight = caller.canDecide || caller.canManage;
    if (query.employeeId && query.employeeId !== caller.employeeId) {
      if (!oversight) throw new ForbiddenError('You do not have access to that employee.');
      await assertEmployeeInScope(auth, query.employeeId);
    }

    /*
     * Without oversight the subject is forced to the caller's own record, and
     * `__none__` is what a login with no employee record gets: an id nothing
     * matches, so the list is empty rather than unfiltered.
     */
    const subjectFilter: Prisma.MedicalClaimWhereInput = oversight
      ? query.view === 'mine'
        ? { employeeId: caller.employeeId ?? '__none__' }
        : {}
      : { employeeId: caller.employeeId ?? '__none__' };

    const where: Prisma.MedicalClaimWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        subjectFilter,
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.category ? { category: query.category } : {},
        query.employmentStatus ? { employee: { employmentStatus: query.employmentStatus } } : {},
        query.year
          ? {
              OR: [
                {
                  treatmentDate: {
                    gte: new Date(Date.UTC(query.year, 0, 1)),
                    lte: new Date(Date.UTC(query.year, 11, 31)),
                  },
                },
                // A claim with no treatment date belongs to the year it was
                // submitted in, exactly as the balance arithmetic counts it.
                {
                  treatmentDate: null,
                  submittedAt: {
                    gte: new Date(Date.UTC(query.year, 0, 1)),
                    lt: new Date(Date.UTC(query.year + 1, 0, 1)),
                  },
                },
              ],
            }
          : {},
        query.q
          ? {
              OR: [
                { claimNumber: { contains: query.q, mode: 'insensitive' } },
                { providerName: { contains: query.q, mode: 'insensitive' } },
                { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.medicalClaim.count({ where }),
      prisma.medicalClaim.findMany({
        where,
        skip,
        take,
        orderBy: [{ submittedAt: 'desc' }],
        include: CLAIM_INCLUDE,
      }),
    ]);

    const records = await withReviewerNames(
      rows.map((row) => toClaimRecord(row, caller)),
      rows,
    );

    return reply.send({ data: records, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * What a claim would look like before anybody commits to it.
   *
   * The submit form's preview: the split, the balances and every rule the claim
   * currently fails. Read-only and gated on the same subject rule as everything
   * else, so it cannot be used to probe a colleague's remaining balance.
   */
  app.get('/assessment', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(medicalClaimAssessmentQuerySchema, request.query);
    const subject = await resolveMedicalSubject(auth, query.employeeId);

    const assessment = await assessMedicalClaim({
      companyId: auth.companyId,
      employeeId: subject.employeeId,
      category: query.category,
      dependentId: query.dependentId ?? null,
      treatmentDate: query.treatmentDate || null,
      requestedAmount: query.requestedAmount ?? null,
      providerName: null,
    });

    /*
     * The preview never reports a missing document or a missing provider.
     *
     * Neither has been typed yet at the moment the form asks, so reporting them
     * would put two errors on a form the user has barely started. What they
     * are, the form is told separately in `requiredDocuments`, so it can mark
     * the fields required up front. The submit route checks what actually
     * arrived.
     */
    return reply.send({
      data: {
        ...assessment,
        failures: assessment.failures.filter(
          (f) => f.rule !== 'DOCUMENT_REQUIRED' && f.rule !== 'PROVIDER_REQUIRED',
        ),
        failedRules: assessment.failedRules.filter(
          (r) => r !== 'DOCUMENT_REQUIRED' && r !== 'PROVIDER_REQUIRED',
        ),
        reasons: assessment.failures
          .filter((f) => f.rule !== 'DOCUMENT_REQUIRED' && f.rule !== 'PROVIDER_REQUIRED')
          .map((f) => f.message),
        allowed: assessment.failures.every(
          (f) => f.rule === 'DOCUMENT_REQUIRED' || f.rule === 'PROVIDER_REQUIRED',
        ),
      },
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await claimOrThrow(auth.companyId, id);
    // The same two-door rule as everywhere else in the module: your own, or
    // oversight plus the data scope to reach them.
    await resolveMedicalSubject(auth, row.employeeId);

    const caller = await callerContext(auth);
    const [record] = await withReviewerNames([toClaimDetail(row, caller)], [row]);

    return reply.send({ data: record });
  });

  /**
   * Submit a claim.
   *
   * The claimant's own route. No override is offered here and none can be
   * passed: this is their own claim, and an employee waving themselves past the
   * rules is not an override, it is the absence of a rule. An authorised user
   * who wants to make an exception does it through the administrative route
   * below, where the decision carries their name.
   *
   * The policy version in force at this instant is pinned to the claim and
   * governs it for the rest of its life.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_CLAIM_REQUEST) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(medicalClaimSubmitSchema, request.body);
      const subject = await resolveMedicalSubject(auth, input.employeeId);

      /*
       * Recording a claim for somebody else is an administrative act.
       *
       * `medical.claim.request` reaches your own claim only. Naming another
       * employee needs `medical.manage`, and that is also the only way an
       * override can be supplied.
       */
      const onBehalf = !subject.isSelf;
      if (onBehalf && !subject.canManage) {
        throw new ForbiddenError('You do not have permission to record a claim for that employee.');
      }
      if (input.overrideReason !== null && !subject.canManage) {
        throw new ForbiddenError('You do not have permission to override the medical claim rules.');
      }

      const now = new Date();
      const policy = await currentMedicalPolicy(auth.companyId, now);
      const documentTypes = input.documents.map((d) => d.type);

      await assertClaimAllowed({
        companyId: auth.companyId,
        employeeId: subject.employeeId,
        category: input.category,
        dependentId: input.dependentId,
        treatmentDate: input.treatmentDate,
        requestedAmount: input.requestedAmount,
        documentTypes,
        providerName: input.providerName,
        policy,
        override:
          input.overrideReason === null || !subject.canManage
            ? null
            : { by: auth.userId, reason: input.overrideReason, request },
      });

      const category = toCategoryRecords(policy).find((c) => c.category === input.category)!;
      const split = splitContribution(input.requestedAmount, category.companyContributionPercent);

      /*
       * A policy that does not require a review settles the claim on arrival.
       *
       * That is what `requireHrApproval: false` means, and making it mean
       * nothing would be a setting that lies. The decision is recorded as
       * automatic - no reviewer, and a note saying so - rather than attributed
       * to the claimant.
       */
      const settleOnArrival = !policy.requireHrApproval;

      const created = await prisma.medicalClaim.create({
        data: {
          companyId: auth.companyId,
          employeeId: subject.employeeId,
          claimNumber: await nextClaimNumber(auth.companyId),
          dependentId: input.dependentId,
          category: input.category,
          treatmentDate: input.treatmentDate ? new Date(`${input.treatmentDate}T00:00:00.000Z`) : null,
          providerName: input.providerName,
          notes: input.notes,
          requestedAmount: input.requestedAmount,
          policyId: policy.id,
          submittedAt: now,
          overrideReason: input.overrideReason,
          createdBy: auth.userId,
          ...(settleOnArrival
            ? {
                status: 'APPROVED' as const,
                approvedAmount: input.requestedAmount,
                companyAmount: split.companyAmount,
                employeeAmount: split.employeeAmount,
                decidedAt: now,
                decisionNote: 'Approved automatically: the policy does not require a review.',
              }
            : { status: 'PENDING' as const }),
          documents: {
            create: input.documents.map((d) => ({
              companyId: auth.companyId,
              type: d.type,
              reference: d.reference,
              note: d.note,
              createdBy: auth.userId,
            })),
          },
        },
        include: CLAIM_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: onBehalf ? 'medical.claim.record' : 'medical.claim.submit',
        entityType: 'MedicalClaim',
        entityId: created.id,
        // The category and amount, never the notes: an audit summary is read by
        // people who have no business knowing what treatment somebody had.
        summary: `${onBehalf ? 'Recorded' : 'Submitted'} claim ${created.claimNumber}: ${MEDICAL_CATEGORY_LABELS[input.category]}, ${format(input.requestedAmount)}`,
        after: {
          claimNumber: created.claimNumber,
          category: input.category,
          requestedAmount: input.requestedAmount,
          policyId: policy.id,
          status: created.status,
        },
        request,
      });

      await notifyClaimApprovers(auth.companyId, created, request);

      const caller = await callerContext(auth);
      return reply.code(201).send({ data: toClaimDetail(created, caller) });
    },
  );

  /**
   * Decide a claim.
   *
   * Approving less than was asked for is a PARTIALLY_APPROVED claim, which the
   * policy has to allow. Approving more is refused outright: that is not a
   * decision about this claim.
   *
   * The split is recomputed from the version the claim was SUBMITTED under, not
   * from today's. A claim submitted in March under an 80/20 split settles at
   * 80/20 however often the policy has moved since - that is what pinning
   * `policyId` is for, and re-reading the live policy here would quietly undo
   * it.
   */
  app.post(
    '/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_CLAIM_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(medicalClaimDecisionSchema, request.body ?? {});

      const claim = await claimOrThrow(auth.companyId, id);
      await assertEmployeeInScope(auth, claim.employeeId);
      assertPending(claim.status);
      await assertNotOwnClaim(auth, claim.employeeId);

      const requested = toNumber(claim.requestedAmount);
      const approved = input.approvedAmount ?? requested;

      if (approved > requested) {
        throw new ValidationError({
          approvedAmount: ['A claim cannot be approved for more than was claimed.'],
        });
      }
      if (approved <= 0) {
        throw new ValidationError({
          approvedAmount: ['Approve an amount above zero, or reject the claim.'],
        });
      }

      // The version the claim was submitted under, read by id so a scheduled
      // policy change cannot slip in between submission and decision.
      const policy = await prisma.medicalPolicy.findUniqueOrThrow({
        where: { id: claim.policyId },
        include: { categories: true },
      });

      const partial = approved < requested;
      if (partial && !policy.allowPartialApproval) {
        throw new ValidationError({
          approvedAmount: [
            'The policy this claim was submitted under does not allow partial approval. Approve it in full or reject it.',
          ],
        });
      }

      const category = toCategoryRecords(policy).find((c) => c.category === claim.category)!;
      const split = splitContribution(approved, category.companyContributionPercent);

      /*
       * The limit is checked again, at the amount actually being approved.
       *
       * Between submission and this moment another claim may have been
       * approved, so the balance that was available then may be gone now. The
       * claim excludes ITSELF from the year's totals - it is reserved as
       * pending, and counting that reservation against the decision would make
       * every claim block itself.
       */
      await assertClaimAllowed({
        companyId: auth.companyId,
        employeeId: claim.employeeId,
        category: claim.category,
        dependentId: claim.dependentId,
        treatmentDate: claim.treatmentDate ? claim.treatmentDate.toISOString().slice(0, 10) : null,
        requestedAmount: approved,
        // Already satisfied at submission and not re-litigated at the decision:
        // the reviewer is looking at the paperwork, not retyping it.
        documentTypes: undefined as unknown as readonly MedicalClaimDocumentType[],
        providerName: claim.providerName,
        policy,
        excludeClaimId: claim.id,
        override:
          input.overrideReason === null
            ? null
            : { by: auth.userId, reason: input.overrideReason, request },
      });

      const now = new Date();
      await prisma.medicalClaim.update({
        where: { id: claim.id },
        data: {
          status: partial ? 'PARTIALLY_APPROVED' : 'APPROVED',
          approvedAmount: approved,
          companyAmount: split.companyAmount,
          employeeAmount: split.employeeAmount,
          decidedAt: now,
          reviewedByUserId: auth.userId,
          decisionNote: input.note,
          ...(input.overrideReason ? { overrideReason: input.overrideReason } : {}),
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'medical.claim.approve',
        entityType: 'MedicalClaim',
        entityId: claim.id,
        summary: `${partial ? 'Part-approved' : 'Approved'} claim ${claim.claimNumber} for ${employeeLabel(claim.employee)}: ${format(approved)} of ${format(requested)}`,
        before: { status: claim.status, approvedAmount: null },
        after: {
          status: partial ? 'PARTIALLY_APPROVED' : 'APPROVED',
          approvedAmount: approved,
          companyAmount: split.companyAmount,
          employeeAmount: split.employeeAmount,
          policyId: claim.policyId,
        },
        request,
      });

      await notifyClaimant(auth.companyId, claim, {
        type: 'APPROVAL_APPROVED',
        title: partial ? 'Medical claim part-approved' : 'Medical claim approved',
        message: partial
          ? `Claim ${claim.claimNumber} was approved for ${format(approved)} of the ${format(requested)} claimed.`
          : `Claim ${claim.claimNumber} was approved in full.`,
        logger: request.log,
      });

      return reply.send({ data: await reload(auth, claim.id) });
    },
  );

  app.post(
    '/:id/reject',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_CLAIM_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(medicalClaimRejectSchema, request.body);

      const claim = await claimOrThrow(auth.companyId, id);
      await assertEmployeeInScope(auth, claim.employeeId);
      assertPending(claim.status);
      await assertNotOwnClaim(auth, claim.employeeId);

      const now = new Date();
      await prisma.medicalClaim.update({
        where: { id: claim.id },
        data: {
          status: 'REJECTED',
          decidedAt: now,
          reviewedByUserId: auth.userId,
          rejectionReason: input.reason,
          // Explicitly zeroed rather than left null: a rejected claim has
          // consumed nothing, and the balance arithmetic should not have to
          // know which statuses mean "no money" to get that right.
          approvedAmount: 0,
          companyAmount: 0,
          employeeAmount: 0,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'medical.claim.reject',
        entityType: 'MedicalClaim',
        entityId: claim.id,
        summary: `Declined claim ${claim.claimNumber} for ${employeeLabel(claim.employee)}`,
        after: { status: 'REJECTED', reason: input.reason },
        request,
      });

      await notifyClaimant(auth.companyId, claim, {
        type: 'APPROVAL_REJECTED',
        title: 'Medical claim declined',
        message: `Claim ${claim.claimNumber} was declined. ${input.reason}`,
        logger: request.log,
      });

      return reply.send({ data: await reload(auth, claim.id) });
    },
  );

  /**
   * Withdraw a claim.
   *
   * The claimant's own, while nobody has decided it and while the policy allows
   * it - `allowEmployeeCancelPending` is a real switch, not decoration. An
   * administrator with `medical.manage` can withdraw one either way, which is
   * how a claim entered by mistake is taken back.
   */
  app.post('/:id/cancel', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(medicalClaimCancelSchema, request.body ?? {});

    const claim = await claimOrThrow(auth.companyId, id);
    const subject = await resolveMedicalSubject(auth, claim.employeeId);
    assertPending(claim.status);

    const policy = await currentMedicalPolicy(auth.companyId);

    if (subject.isSelf && !subject.canManage) {
      if (!auth.permissions.has(PERMISSIONS.MEDICAL_CLAIM_REQUEST)) {
        throw new ForbiddenError('You do not have permission to withdraw a claim.');
      }
      if (!policy.allowEmployeeCancelPending) {
        throw new ForbiddenError(
          'The medical policy does not let a claim be withdrawn once it has been submitted. Ask HR.',
        );
      }
    } else if (!subject.canManage) {
      throw new ForbiddenError('You do not have permission to withdraw that claim.');
    }

    const now = new Date();
    await prisma.medicalClaim.update({
      where: { id: claim.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledByUserId: auth.userId,
        decisionNote: input.reason,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'medical.claim.cancel',
      entityType: 'MedicalClaim',
      entityId: claim.id,
      summary: `Withdrew claim ${claim.claimNumber}`,
      after: { status: 'CANCELLED', reason: input.reason },
      request,
    });

    return reply.send({ data: await reload(auth, claim.id) });
  });

  /**
   * Record that an agreed claim has been paid.
   *
   * Gated on `medical.manage` rather than on the approval grant, for the same
   * reason a loan is approved by one person and released by another: agreeing
   * that money is owed and recording that it left are two decisions, and a
   * company that wants two pairs of eyes on a payment can now have them.
   *
   * No payroll integration. A medical reimbursement is not salary, and wiring
   * it into a payroll run would make it one.
   */
  app.post(
    '/:id/pay',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(medicalClaimPaySchema, request.body ?? {});

      const claim = await claimOrThrow(auth.companyId, id);
      await assertEmployeeInScope(auth, claim.employeeId);

      if (claim.status !== 'APPROVED' && claim.status !== 'PARTIALLY_APPROVED') {
        throw new ConflictError(
          claim.status === 'PAID'
            ? 'That claim has already been paid.'
            : `A claim cannot be paid while it is ${claim.status.toLowerCase().replace(/_/g, ' ')}.`,
        );
      }

      const paidAt = input.paidAt ? new Date(`${input.paidAt}T00:00:00.000Z`) : new Date();
      if (Number.isNaN(paidAt.getTime())) {
        throw new ValidationError({ paidAt: ['That is not a valid date.'] });
      }

      await prisma.medicalClaim.update({
        where: { id: claim.id },
        data: {
          status: 'PAID',
          paidAt,
          paidByUserId: auth.userId,
          paymentReference: input.paymentReference,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'medical.claim.pay',
        entityType: 'MedicalClaim',
        entityId: claim.id,
        summary: `Recorded payment of claim ${claim.claimNumber} for ${employeeLabel(claim.employee)}: ${format(toNumber(claim.companyAmount))}`,
        before: { status: claim.status },
        after: {
          status: 'PAID',
          paidAt: paidAt.toISOString(),
          paymentReference: input.paymentReference,
        },
        request,
      });

      await notifyClaimant(auth.companyId, claim, {
        type: 'SYSTEM',
        title: 'Medical claim paid',
        message: `Claim ${claim.claimNumber} has been paid: ${format(toNumber(claim.companyAmount))}.`,
        logger: request.log,
      });

      return reply.send({ data: await reload(auth, claim.id) });
    },
  );

  async function reload(
    auth: { companyId: string; userId: string; permissions: ReadonlySet<string> },
    id: string,
  ) {
    const row = await claimOrThrow(auth.companyId, id);
    const caller = await callerContext(auth);
    const [record] = await withReviewerNames([toClaimDetail(row, caller)], [row]);
    return record;
  }
};

function assertPending(status: string): void {
  if (status !== 'PENDING') {
    throw new ConflictError(
      `That claim has already been ${status.toLowerCase().replace(/_/g, ' ')}.`,
    );
  }
}

/** Nobody decides their own claim, whatever they hold. */
async function assertNotOwnClaim(
  auth: { companyId: string; userId: string },
  employeeId: string,
): Promise<void> {
  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });
  if (self && self.id === employeeId) {
    throw new ForbiddenError('A claim cannot be decided by the person who made it.');
  }
}

/** Tell the claimant what happened to their claim. */
async function notifyClaimant(
  companyId: string,
  claim: ClaimRow,
  input: {
    type: 'APPROVAL_APPROVED' | 'APPROVAL_REJECTED' | 'SYSTEM';
    title: string;
    message: string;
    logger: FastifyRequest['log'];
  },
): Promise<void> {
  const employee = await prisma.employee.findUnique({
    where: { id: claim.employeeId },
    select: { userId: true },
  });
  if (!employee?.userId) return;

  await notify({
    companyId,
    userId: employee.userId,
    type: input.type,
    title: input.title,
    // Deliberately carries the claim number and the money, and never the
    // category, the provider or the dependent. A notification is the least
    // controlled surface in the product - it can end up in an email preview on
    // a lock screen - so it says as little about the treatment as it can.
    message: input.message,
    entityType: 'MedicalClaim',
    entityId: claim.id,
    logger: input.logger,
  });
}

/**
 * Tell the people who can decide a claim that one has arrived.
 *
 * Resolved from the permission rather than from a named role, so a company that
 * invents a "Benefits Officer" role and grants it `medical.claim.approve` gets
 * the notifications without anybody editing this list. The claimant is never
 * notified as their own approver.
 */
async function notifyClaimApprovers(
  companyId: string,
  claim: ClaimRow,
  request: FastifyRequest,
): Promise<void> {
  if (claim.status !== 'PENDING') return;

  const users = await prisma.user.findMany({
    where: {
      companyId,
      status: 'ACTIVE',
      userRoles: {
        some: {
          role: {
            companyId,
            rolePermissions: {
              some: { permission: { key: PERMISSIONS.MEDICAL_CLAIM_APPROVE } },
            },
          },
        },
      },
      NOT: { employee: { id: claim.employeeId } },
    },
    select: { id: true },
  });

  for (const user of users) {
    await notify({
      companyId,
      userId: user.id,
      type: 'APPROVAL_REQUESTED',
      title: 'Medical claim to review',
      message: `Claim ${claim.claimNumber} is waiting for a decision.`,
      entityType: 'MedicalClaim',
      entityId: claim.id,
      logger: request.log,
    });
  }
}
