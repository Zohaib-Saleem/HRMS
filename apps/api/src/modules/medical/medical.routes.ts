import type { FastifyPluginAsync } from 'fastify';
import {
  PERMISSIONS,
  idParamSchema,
  medicalBenefitQuerySchema,
  medicalDependentCreateSchema,
  medicalDependentQuerySchema,
  medicalDependentUpdateSchema,
  medicalEmployeeOverrideSchema,
  type MedicalBenefitView,
  type MedicalDependentRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ForbiddenError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { currentMedicalPolicy } from './medical-policy.service.js';
import { evaluateMedicalEligibility } from './medical-eligibility.service.js';
import {
  applyCoverage,
  benefitYearOf,
  dependentCoverage,
  dependentOrThrow,
  listDependents,
  resolveMedicalSubject,
} from './medical.service.js';
import { categoryUsage, yearPosition } from './medical-claim.service.js';

/**
 * An employee's medical benefit, and the dependents it reaches.
 *
 * Every route here is gated on `medical.read` and then narrowed AGAIN by
 * `resolveMedicalSubject`, which is what makes "employees may see only their
 * own medical information" true rather than aspirational: the permission gets
 * you to the module, and only your own record or `medical.manage` gets you to a
 * person. A `?employeeId=` naming a colleague is refused for an ordinary
 * employee and for a manager alike.
 *
 * Nothing in here is computed in the browser and sent back. The eligibility,
 * the limits and the coverage flags are all decided on the server from the
 * policy in force, on every request.
 */

const toDate = (value: string | null | undefined): Date | null =>
  value ? new Date(`${value}T00:00:00.000Z`) : null;

export const medicalRoutes: FastifyPluginAsync = async (app) => {
  /*
   * One gate for the whole plugin. A Fastify hook is scoped to the plugin that
   * registers it, so this reaches every route below and nothing outside.
   */
  app.addHook('preHandler', requirePermission(PERMISSIONS.MEDICAL_READ));

  /**
   * "What am I entitled to, and how much of it is left?"
   *
   * The employee's Medical screen in one request: eligibility, the annual
   * limit, what has been used, what remains, and who is covered.
   */
  app.get('/benefit', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(medicalBenefitQuerySchema, request.query);
    const subject = await resolveMedicalSubject(auth, query.employeeId);

    const now = new Date();
    /*
     * One policy read, passed onwards.
     *
     * Reading it twice could straddle the instant a scheduled version takes
     * effect and produce a screen whose eligibility came from one set of rules
     * and whose limits came from another.
     */
    const policy = await currentMedicalPolicy(auth.companyId, now);
    const year = benefitYearOf(now);

    const [employee, eligibility, dependents, position, usage] = await Promise.all([
      prisma.employee.findFirstOrThrow({
        where: { id: subject.employeeId, companyId: auth.companyId },
        select: { firstName: true, lastName: true, displayName: true },
      }),
      evaluateMedicalEligibility({
        companyId: auth.companyId,
        employeeId: subject.employeeId,
        now,
        policy,
      }),
      listDependents(auth.companyId, subject.employeeId),
      yearPosition({ companyId: auth.companyId, employeeId: subject.employeeId, year }),
      categoryUsage({ companyId: auth.companyId, employeeId: subject.employeeId, year, policy }),
    ]);

    // The employee's own limit when HR has set one, else the policy's.
    const annualLimit = eligibility.benefitLimit;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const data: MedicalBenefitView = {
      employeeId: subject.employeeId,
      employeeName:
        employee.displayName ?? `${employee.firstName} ${employee.lastName}`.trim(),
      currency: eligibility.currency,
      benefitYear: year,
      eligibility,
      annualLimit,
      used: position.used,
      pending: position.pending,
      // Never below zero. An over-payment is a thing to investigate, not a
      // negative entitlement to show somebody.
      remaining: Math.max(0, round2(annualLimit - position.used)),
      // What a NEW claim can draw on: pending claims have reserved their
      // amount, even though they have not spent it.
      available: Math.max(0, round2(annualLimit - position.used - position.pending)),
      categoryUsage: usage,
      canManageDependents: subject.canManage,
      // Never for somebody who is not eligible: the claim gate would refuse it
      // anyway, and offering the button only to refuse is worse than not.
      canSubmitClaim:
        eligibility.eligible &&
        (subject.isSelf && auth.permissions.has(PERMISSIONS.MEDICAL_CLAIM_REQUEST)
          ? true
          : subject.canManage),
      canEditOverride: subject.canManage && !subject.isSelf,
      canEditPolicy: auth.permissions.has(PERMISSIONS.MEDICAL_POLICY_MANAGE),
      dependentCoverage: dependentCoverage(policy),
      dependents: applyCoverage(dependents, policy),
    };

    return reply.send({ data });
  });

  /**
   * Set HR's per-employee decision: eligible, not eligible or follow the
   * policy, and an individual annual limit.
   *
   * `medical.manage` (Super Admin and HR), on somebody else's record only -
   * nobody grants themselves an exception to the benefit they are paid under.
   * A reason is compulsory whenever the result departs from the policy, and the
   * audit keeps the old and new values.
   */
  app.put('/override', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(medicalEmployeeOverrideSchema, request.body);
    const subject = await resolveMedicalSubject(auth, input.employeeId);
    requireDependentManagement(subject.canManage);
    if (subject.isSelf) {
      throw new ForbiddenError('You cannot set a medical override on your own record.');
    }

    const existing = await prisma.employee.findFirstOrThrow({
      where: { id: subject.employeeId, companyId: auth.companyId },
      select: {
        medicalEligibilityOverride: true,
        medicalAnnualLimitOverride: true,
        medicalOverrideNote: true,
      },
    });

    const followsPolicy = input.eligibility === 'FOLLOW_POLICY' && input.annualLimit === null;
    const data = {
      medicalEligibilityOverride:
        input.eligibility === 'FOLLOW_POLICY' ? null : input.eligibility,
      medicalAnnualLimitOverride: input.annualLimit,
      // Back to the policy clears the reason with it: a note describing an
      // exception that no longer exists would mislead the next reader.
      medicalOverrideNote: followsPolicy ? null : input.note,
    };

    await prisma.employee.update({ where: { id: subject.employeeId }, data });

    const changes = diff(
      {
        medicalEligibilityOverride: existing.medicalEligibilityOverride,
        medicalAnnualLimitOverride:
          existing.medicalAnnualLimitOverride === null
            ? null
            : Number(existing.medicalAnnualLimitOverride),
        medicalOverrideNote: existing.medicalOverrideNote,
      },
      data as unknown as Record<string, unknown>,
    );

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'medical.override.update',
      entityType: 'Employee',
      entityId: subject.employeeId,
      summary: followsPolicy
        ? 'Returned an employee to the medical policy'
        : `Set a medical override (${changes.changed.join(', ') || 'no field changes'})`,
      before: changes.before,
      after: changes.after,
      request,
    });

    const eligibility = await evaluateMedicalEligibility({
      companyId: auth.companyId,
      employeeId: subject.employeeId,
    });
    return reply.send({ data: eligibility });
  });

  /** An employee's dependents, with coverage resolved against the live policy. */
  app.get('/dependents', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(medicalDependentQuerySchema, request.query);
    const subject = await resolveMedicalSubject(auth, query.employeeId);

    const [policy, rows] = await Promise.all([
      currentMedicalPolicy(auth.companyId),
      listDependents(auth.companyId, subject.employeeId),
    ]);

    const data: MedicalDependentRecord[] = applyCoverage(rows, policy);
    return reply.send({ data });
  });

  /**
   * Record a dependent.
   *
   * Needs `medical.manage`, for their own record as much as anybody else's.
   * Dependents decide who a company pays for, so they are HR-maintained rather
   * than self-service - an employee can see exactly who is on their record and
   * who is covered, and cannot add to it.
   *
   * Over the policy's maximum is NOT an error. The record is kept and simply is
   * not covered; refusing it would lose the family's real shape and would mean
   * raising the maximum later covered nobody until somebody re-keyed them.
   */
  app.post('/dependents', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(medicalDependentCreateSchema, request.body);
    const subject = await resolveMedicalSubject(auth, input.employeeId);
    requireDependentManagement(subject.canManage);

    const created = await prisma.medicalDependent.create({
      data: {
        companyId: auth.companyId,
        employeeId: subject.employeeId,
        name: input.name,
        relationship: input.relationship,
        dateOfBirth: toDate(input.dateOfBirth),
        gender: input.gender,
        status: input.status,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'medical.dependent.create',
      entityType: 'MedicalDependent',
      entityId: created.id,
      // The relationship, not the name: an audit summary is read by people who
      // may have no business knowing who somebody's family are, and the row
      // itself carries the detail for those who do.
      summary: `Added a ${created.relationship.toLowerCase()} dependent`,
      request,
    });

    const policy = await currentMedicalPolicy(auth.companyId);
    const [record] = applyCoverage(
      await listDependents(auth.companyId, subject.employeeId),
      policy,
    ).filter((d) => d.id === created.id);

    return reply.code(201).send({ data: record });
  });

  /** Correct a dependent. A dependent never moves between employees. */
  app.patch('/dependents/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(medicalDependentUpdateSchema, request.body);

    const existing = await dependentOrThrow(auth.companyId, id);
    const subject = await resolveMedicalSubject(auth, existing.employeeId);
    requireDependentManagement(subject.canManage);

    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.relationship !== undefined ? { relationship: input.relationship } : {}),
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: toDate(input.dateOfBirth) } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };

    await prisma.medicalDependent.update({
      where: { id: existing.id },
      data: { ...data, updatedBy: auth.userId },
    });

    /**
     * Old and new value, field by field, for the fields that actually
     * changed. The summary stays impersonal - it is what the audit list shows
     * to anybody with `audit.read` - and the values sit in the before/after
     * columns the audit screen opens on demand, the same place every other
     * edit in the product keeps them.
     */
    const changes = diff(
      existing as unknown as Record<string, unknown>,
      data as unknown as Record<string, unknown>,
    );

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'medical.dependent.update',
      entityType: 'MedicalDependent',
      entityId: existing.id,
      summary: `Updated a medical dependent (${changes.changed.join(', ') || 'no field changes'})`,
      before: changes.before,
      after: changes.after,
      request,
    });

    const policy = await currentMedicalPolicy(auth.companyId);
    const [record] = applyCoverage(
      await listDependents(auth.companyId, subject.employeeId),
      policy,
    ).filter((d) => d.id === existing.id);

    return reply.send({ data: record });
  });

  /**
   * Remove a dependent.
   *
   * A hard delete, and only while nothing refers to them. Once a claim names a
   * dependent, deleting the record would leave a paid claim describing somebody
   * who no longer exists - so a dependent with claim history is marked INACTIVE
   * instead, which is what the status is for.
   */
  app.delete('/dependents/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const existing = await dependentOrThrow(auth.companyId, id);
    const subject = await resolveMedicalSubject(auth, existing.employeeId);
    requireDependentManagement(subject.canManage);

    const claims = await prisma.medicalClaim.count({ where: { dependentId: existing.id } });
    if (claims > 0) {
      await prisma.medicalDependent.update({
        where: { id: existing.id },
        data: { status: 'INACTIVE', updatedBy: auth.userId },
      });
    } else {
      await prisma.medicalDependent.delete({ where: { id: existing.id } });
    }

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: claims > 0 ? 'medical.dependent.deactivate' : 'medical.dependent.delete',
      entityType: 'MedicalDependent',
      entityId: existing.id,
      summary: claims > 0 ? 'Deactivated a dependent with claim history' : 'Removed a dependent',
      request,
    });

    return reply.code(204).send();
  });
};

function requireDependentManagement(canManage: boolean): void {
  if (!canManage) {
    throw new ForbiddenError('You do not have permission to change medical dependents.');
  }
}
