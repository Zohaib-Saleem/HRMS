import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  loanEligibilityQuerySchema,
  loanPolicyHistoryQuerySchema,
  loanPolicySchema,
  type LoanPolicyRecord,
  type LoanPolicyView,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope } from '../../auth/scope.js';
import { callerEmployeeOrThrow } from '../time/helpers.js';
import { evaluateLoanEligibility } from './loan-eligibility.service.js';
import {
  currentLoanPolicy,
  loanPolicyHistory,
  namesForUsers,
  saveLoanPolicy,
  scheduledLoanPolicy,
  toLoanPolicyRecord,
} from './loan-policy.service.js';

/**
 * The loan policy, and the eligibility question it answers.
 *
 * Two audiences on one prefix, separated by permission rather than by route
 * shape: `/loans/policy` is company configuration and needs
 * `loan.policy.read` / `loan.policy.manage`, while `/loans/eligibility` is
 * self-service and needs only the `loan.read` the loans module already
 * requires. An employee can ask whether THEY may borrow without being able to
 * see, let alone change, the rules that decide it.
 */

const buildMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});

export const loanPolicyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The policy in force, plus whether the caller may change it.
   *
   * `canManage` is the server's own answer, so the screen never has to guess
   * from a permission list - and hiding the save button was never the gate
   * anyway: the PUT below checks again.
   */
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LOAN_POLICY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const now = new Date();

      const [policy, scheduled, company] = await Promise.all([
        currentLoanPolicy(auth.companyId, now),
        scheduledLoanPolicy(auth.companyId, now),
        prisma.company.findUniqueOrThrow({
          where: { id: auth.companyId },
          select: { currency: true },
        }),
      ]);

      const names = await namesForUsers([policy.createdBy, scheduled?.createdBy ?? null]);

      const data: LoanPolicyView = {
        policy: toLoanPolicyRecord(policy, {
          createdByName: policy.createdBy ? (names.get(policy.createdBy) ?? null) : null,
          isCurrent: true,
        }),
        scheduled: scheduled
          ? toLoanPolicyRecord(scheduled, {
              createdByName: scheduled.createdBy
                ? (names.get(scheduled.createdBy) ?? null)
                : null,
              isCurrent: false,
            })
          : null,
        canManage: auth.permissions.has(PERMISSIONS.LOAN_POLICY_MANAGE),
        currency: company.currency,
      };

      return reply.send({ data });
    },
  );

  /**
   * Save a new version.
   *
   * An insert, never an update: the version that governed yesterday's
   * applications has to survive today's change, or a loan already granted stops
   * being explicable. Nothing about an existing loan is read or written here -
   * no principal, no schedule, no installment, no status.
   */
  app.put(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LOAN_POLICY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(loanPolicySchema, request.body);
      const now = new Date();

      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
      if (Number.isNaN(effectiveFrom.getTime())) {
        throw new ValidationError({ effectiveFrom: ['That is not a valid date.'] });
      }

      const before = await currentLoanPolicy(auth.companyId, now);

      let created;
      try {
        created = await saveLoanPolicy({
          companyId: auth.companyId,
          values: input,
          userId: auth.userId,
          effectiveFrom,
        });
      } catch (error) {
        // The unique index on [companyId, effectiveFrom] did its job: somebody
        // else saved a version for this same instant.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictError(
            'A policy version already starts at that moment. Reload the page and try again.',
          );
        }
        throw error;
      }

      const record = toLoanPolicyRecord(created, { createdByName: null, isCurrent: true });
      const previous = toLoanPolicyRecord(before, { createdByName: null, isCurrent: false });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.policy.update',
        entityType: 'LoanPolicy',
        entityId: created.id,
        summary: `Saved a loan policy effective ${effectiveFrom.toISOString()}`,
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
    { preHandler: requirePermission(PERMISSIONS.LOAN_POLICY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const query = parseOrThrow(loanPolicyHistoryQuerySchema, request.query);

      const { entries, total } = await loanPolicyHistory(
        auth.companyId,
        query.page,
        query.limit,
      );

      return reply.send({ data: entries, meta: buildMeta(query.page, query.limit, total) });
    },
  );
};

/**
 * "May I borrow, and how much?"
 *
 * Mounted on the loans prefix and gated on `loan.read` in its own right. The
 * subject defaults to the caller's own employee record; naming somebody else
 * needs the data scope to reach them, which an employee's OWN scope does not -
 * so `?employeeId=` cannot be used to go fishing for a colleague's salary.
 */
export const loanEligibilityRoutes: FastifyPluginAsync = async (app) => {
  /*
   * Gated here rather than inherited.
   *
   * This is a separate plugin from `loanRoutes`, and a Fastify hook is scoped
   * to the plugin that registers it - so the `loan.read` preHandler on the
   * loans module does NOT reach these routes. Mounting on the same `/loans`
   * prefix makes that easy to miss, which is exactly why it is spelled out.
   */
  app.addHook('preHandler', requirePermission(PERMISSIONS.LOAN_READ));

  app.get('/eligibility', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(loanEligibilityQuerySchema, request.query);

    let employeeId: string;
    if (query.employeeId) {
      await assertEmployeeInScope(auth, query.employeeId);
      employeeId = query.employeeId;
    } else {
      const self = await callerEmployeeOrThrow(auth);
      employeeId = self.id;
    }

    const result = await evaluateLoanEligibility({
      companyId: auth.companyId,
      employeeId,
      requestedAmount: query.principalAmount ?? null,
      requestedInstallments: query.installmentCount ?? null,
    });

    return reply.send({ data: result });
  });
};

export type { LoanPolicyRecord };
