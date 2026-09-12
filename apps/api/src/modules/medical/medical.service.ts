import type { MedicalDependent } from '@prisma/client';
import {
  MEDICAL_CONSUMING_CLAIM_STATUSES,
  MEDICAL_RELATIONSHIP_LABELS,
  PERMISSIONS,
  type MedicalDependentCoverage,
  type MedicalDependentRecord,
  type MedicalGender,
  type MedicalRelationship,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ForbiddenError, NotFoundError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { assertEmployeeInScope } from '../../auth/scope.js';
import type { MedicalPolicyRow } from './medical-policy.service.js';

/**
 * The employee side of the medical module: who may see whose record, which
 * dependents the policy actually covers, and how much of the benefit is left.
 */

// --- access ------------------------------------------------------------------

export interface MedicalSubject {
  employeeId: string;
  /** True when the caller is looking at their own record. */
  isSelf: boolean;
  /** Whether the caller may add, edit or remove this employee's dependents. */
  canManage: boolean;
  /** Whether the caller may decide this employee's medical claims. */
  canDecideClaims: boolean;
}

/**
 * Whether a caller may look past their own medical record at all.
 *
 * Two grants open that door, and both are deliberate HR grants rather than a
 * side effect of a wide data scope. `medical.manage` is the obvious one.
 * `medical.claim.approve` is here because a reviewer cannot decide a claim they
 * cannot read - and a claim for a dependent cannot be decided without seeing
 * whether the policy covers that dependent. A grant that let somebody approve
 * claims but not open them would be a grant that does nothing.
 */
export function holdsMedicalOversight(auth: AuthContext): boolean {
  return (
    auth.permissions.has(PERMISSIONS.MEDICAL_MANAGE) ||
    auth.permissions.has(PERMISSIONS.MEDICAL_CLAIM_APPROVE)
  );
}

/**
 * Who the caller is allowed to ask about.
 *
 * Medical data is the one place in this product where a wide DATA SCOPE is
 * deliberately not sufficient on its own. Everywhere else, "which employees may
 * I see?" is answered by the scope alone - which is right for attendance and
 * leave, and wrong here: a manager holds REPORTS_AND_OWN, and a reporting line
 * is not a reason to read somebody's dependents or their medical entitlement.
 *
 * So there are two doors and they are different sizes:
 *
 *   - Your own record. Any holder of `medical.read` reaches it, whatever their
 *     scope. This is what lets a manager see their own benefit while seeing
 *     nothing of their team's.
 *   - Anybody else's. Needs `medical.manage` or `medical.claim.approve` AND the
 *     data scope to reach that employee. HR holds both grants; an employee
 *     holds neither, and a manager holds only the scope, which on its own opens
 *     nothing.
 *
 * An employee with no linked employee record has no medical record to see, and
 * asking about somebody else is refused before their id is ever looked up.
 */
export async function resolveMedicalSubject(
  auth: AuthContext,
  requestedEmployeeId?: string,
): Promise<MedicalSubject> {
  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });

  const canManage = auth.permissions.has(PERMISSIONS.MEDICAL_MANAGE);
  const canDecideClaims = auth.permissions.has(PERMISSIONS.MEDICAL_CLAIM_APPROVE);
  const employeeId = requestedEmployeeId ?? self?.id;

  if (!employeeId) {
    throw new ForbiddenError(
      'Your login is not linked to an employee record, so there is no medical benefit to show.',
    );
  }

  if (self && employeeId === self.id) {
    return { employeeId, isSelf: true, canManage, canDecideClaims };
  }

  if (!holdsMedicalOversight(auth)) {
    // Deliberately the same message the scope check gives, and deliberately
    // before any lookup: a different message here would confirm whether an id
    // exists to somebody who may not know that.
    throw new ForbiddenError('You do not have access to that employee.');
  }

  await assertEmployeeInScope(auth, employeeId);
  return { employeeId, isSelf: false, canManage, canDecideClaims };
}

// --- dependents --------------------------------------------------------------

/**
 * How many of each relationship the policy covers.
 *
 * Spouse is one. The policy expresses spouse cover as a yes-or-no rather than a
 * count, so what it grants is cover for a spouse, singular - inventing a second
 * from a setting nobody wrote would be exactly the kind of implicit rule this
 * module exists to avoid.
 */
function coveredSlots(policy: MedicalPolicyRow): Record<MedicalRelationship, number> {
  return {
    SPOUSE: policy.spouseCovered ? 1 : 0,
    CHILD: policy.childrenCovered ? policy.maxChildren : 0,
    PARENT: policy.parentsCovered ? policy.maxParents : 0,
  };
}

export function dependentCoverage(policy: MedicalPolicyRow): MedicalDependentCoverage {
  return {
    spouseCovered: policy.spouseCovered,
    childrenCovered: policy.childrenCovered,
    maxChildren: policy.maxChildren,
    parentsCovered: policy.parentsCovered,
    maxParents: policy.maxParents,
    sharesEmployeeLimit: policy.dependentsShareEmployeeLimit,
    separateAnnualLimit: policy.dependentsShareEmployeeLimit
      ? null
      : Number(policy.dependentAnnualLimit),
  };
}

/**
 * Which dependents the policy in force actually covers.
 *
 * Derived on every read, never stored. Three consequences, and all three are
 * the reason:
 *
 *   - Recording a dependent and covering one are different acts. A fourth child
 *     under a three-child policy is recorded and is simply not covered; nothing
 *     is rejected, nothing is lost, and the family's real shape stays on file.
 *   - Raising the maximum covers them, immediately, with nobody re-keying
 *     anything. Lowering it uncovers the last one just as directly.
 *   - A stored flag would go on describing the policy as it was on the day the
 *     record was created, which is the wrong answer to "who is covered now".
 *
 * Slots go in registration order, oldest record first. It has to be SOME order
 * or the third child is whichever one the query planner returned today; created
 * order is the one an employee can predict and HR can explain, and it is the
 * order the [employeeId, relationship, createdAt] index returns.
 *
 * An INACTIVE dependent is never covered and never consumes a slot.
 */
export function applyCoverage(
  dependents: readonly MedicalDependent[],
  policy: MedicalPolicyRow,
): MedicalDependentRecord[] {
  const slots = coveredSlots(policy);
  const used: Record<MedicalRelationship, number> = { SPOUSE: 0, CHILD: 0, PARENT: 0 };

  const ordered = [...dependents].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );

  return ordered.map((row) => {
    const relationship = row.relationship as MedicalRelationship;
    const label = MEDICAL_RELATIONSHIP_LABELS[relationship].toLowerCase();

    let covered = false;
    let coverageNote: string | null = null;

    if (row.status !== 'ACTIVE') {
      coverageNote = 'Marked inactive, so not covered.';
    } else if (!policy.enabled) {
      coverageNote = 'The company medical benefit is switched off.';
    } else if (slots[relationship] === 0) {
      coverageNote = `The policy does not cover a ${label}.`;
    } else if (used[relationship] >= slots[relationship]) {
      coverageNote = `The policy covers ${slots[relationship]} ${
        relationship === 'CHILD' ? 'children' : `${label}${slots[relationship] === 1 ? '' : 's'}`
      }, and that many are already registered ahead of this one.`;
    } else {
      covered = true;
      used[relationship] += 1;
    }

    return {
      id: row.id,
      employeeId: row.employeeId,
      name: row.name,
      relationship,
      dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: (row.gender as MedicalGender | null) ?? null,
      status: row.status,
      covered,
      coverageNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

export async function listDependents(
  companyId: string,
  employeeId: string,
): Promise<MedicalDependent[]> {
  return prisma.medicalDependent.findMany({
    where: { companyId, employeeId },
    orderBy: [{ relationship: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * One dependent, scoped to the company.
 *
 * The companyId in the filter is not decoration: without it, an id from another
 * tenant would resolve, and the caller's own access check would then be run
 * against the wrong employee.
 */
export async function dependentOrThrow(
  companyId: string,
  id: string,
): Promise<MedicalDependent> {
  const row = await prisma.medicalDependent.findFirst({ where: { id, companyId } });
  if (!row) throw new NotFoundError('That dependent no longer exists.');
  return row;
}

// --- the benefit balance -----------------------------------------------------

/**
 * The benefit year.
 *
 * The calendar year, which is what the annual limit is described in and what
 * everybody in the company already means by "this year". A policy-anniversary
 * year would be defensible too, and is deliberately not guessed at here: it
 * would be a rule nobody configured.
 */
export const benefitYearOf = (now: Date): number => now.getUTCFullYear();

/**
 * Where the year's arithmetic lives.
 *
 * `yearPosition` and `categoryUsage` are in medical-claim.service.ts, beside the
 * rules that read them, rather than here. They sum claim rows, and this file is
 * imported BY the claim service - keeping them there is what stops the two
 * importing each other.
 */
