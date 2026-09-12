import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  medicalPolicyHistoryQuerySchema,
  medicalPolicySchema,
  type MedicalPolicyRecord,
  type MedicalPolicyView,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  currentMedicalPolicy,
  medicalPolicyAuthorNames,
  medicalPolicyHistory,
  saveMedicalPolicy,
  scheduledMedicalPolicy,
  toMedicalPolicyRecord,
} from './medical-policy.service.js';

/**
 * Settings -> Medical -> Medical Policy, as an API.
 *
 * Company configuration, and gated as such: `medical.policy.read` to see the
 * rules, `medical.policy.manage` to change them. Neither is the same thing as
 * `medical.read`, which is somebody's own benefit - an employee can be told
 * what they are entitled to without being able to see, let alone edit, the
 * rules that decided it.
 */

const buildMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});

export const medicalPolicyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The policy in force, plus whether the caller may change it.
   *
   * `canManage` is the server's own answer, so the screen never has to guess
   * from a permission list - and hiding the save button was never the gate
   * anyway: the PUT below checks again.
   */
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_POLICY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const now = new Date();

      const [policy, scheduled, company] = await Promise.all([
        currentMedicalPolicy(auth.companyId, now),
        scheduledMedicalPolicy(auth.companyId, now),
        prisma.company.findUniqueOrThrow({
          where: { id: auth.companyId },
          select: { currency: true },
        }),
      ]);

      const names = await medicalPolicyAuthorNames([policy.createdBy, scheduled?.createdBy ?? null]);

      const data: MedicalPolicyView = {
        policy: toMedicalPolicyRecord(policy, {
          createdByName: policy.createdBy ? (names.get(policy.createdBy) ?? null) : null,
          isCurrent: true,
        }),
        scheduled: scheduled
          ? toMedicalPolicyRecord(scheduled, {
              createdByName: scheduled.createdBy
                ? (names.get(scheduled.createdBy) ?? null)
                : null,
              isCurrent: false,
            })
          : null,
        canManage: auth.permissions.has(PERMISSIONS.MEDICAL_POLICY_MANAGE),
        // The company's own currency. Nothing in this module assumes one.
        currency: company.currency,
      };

      return reply.send({ data });
    },
  );

  /**
   * Save a new version.
   *
   * An insert, never an update: the version that governed a claim submitted
   * yesterday has to survive today's change, or a claim already decided stops
   * being explicable. Nothing about an existing claim, dependent or employee is
   * read or written here.
   */
  app.put(
    '/',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_POLICY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(medicalPolicySchema, request.body);
      const now = new Date();

      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
      if (Number.isNaN(effectiveFrom.getTime())) {
        throw new ValidationError({ effectiveFrom: ['That is not a valid date.'] });
      }

      const before = await currentMedicalPolicy(auth.companyId, now);

      let created;
      try {
        created = await saveMedicalPolicy({
          companyId: auth.companyId,
          values: input,
          userId: auth.userId,
          effectiveFrom,
        });
      } catch (error) {
        // The unique index on [companyId, effectiveFrom] did its job: somebody
        // else saved a version for this same instant.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError(
            'A policy version already starts at that moment. Reload the page and try again.',
          );
        }
        throw error;
      }

      const record = toMedicalPolicyRecord(created, { createdByName: null, isCurrent: true });
      const previous = toMedicalPolicyRecord(before, { createdByName: null, isCurrent: false });

      /*
       * The audit entry, alongside the version history rather than instead of
       * it.
       *
       * The field-level "what moved" record IS the sequence of versions, and
       * GET /history derives it from them - a second copy of those values could
       * only agree or be wrong. What the audit log adds is what the version rows
       * cannot carry: who, from which address, with which user agent. Both
       * before and after go in so the trail stands on its own.
       */
      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'medical.policy.update',
        entityType: 'MedicalPolicy',
        entityId: created.id,
        summary: `Saved a medical policy effective ${effectiveFrom.toISOString()}`,
        before: previous as unknown as Record<string, unknown>,
        after: record as unknown as Record<string, unknown>,
        request,
      });

      return reply.send({ data: record });
    },
  );

  /** The change history: every version, and what moved between neighbours. */
  app.get(
    '/history',
    { preHandler: requirePermission(PERMISSIONS.MEDICAL_POLICY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(medicalPolicyHistoryQuerySchema, request.query);

      const { entries, total } = await medicalPolicyHistory(
        auth.companyId,
        query.page,
        query.limit,
      );

      return reply.send({ data: entries, meta: buildMeta(query.page, query.limit, total) });
    },
  );
};

export type { MedicalPolicyRecord };
