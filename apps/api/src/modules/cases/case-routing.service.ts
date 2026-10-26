import type { CaseRoutingRuleRecord } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { eligibleAgentIds } from './case-desk.service.js';

/**
 * Who a new case goes to.
 *
 * Read once, when the case is filed, and never again: the rule decides the
 * first assignee, and from then on the case's own assignment history is the
 * record. Changing a rule tomorrow does not move a case filed today.
 *
 * Most specific active rule wins - the subcategory's, then the category's,
 * then the department's default. Within the rule, the responsible person
 * takes it when they can; the backup when they cannot. "Cannot" means the
 * account is not active, no longer holds a desk grant (so could not open the
 * case it was given), or is the very person who filed it - a manager's own
 * HR case does not land on their own desk.
 *
 * With no rule, or nobody in it able to take the case, the decision is "no
 * assignee", and the caller leaves the case unassigned and tells the queue
 * owners exactly as it always has. A case is never dropped.
 */

export interface RoutingDecision {
  ruleId: string | null;
  /** Which level matched, for the event message and the audit trail. */
  scope: 'SUBCATEGORY' | 'CATEGORY' | 'DEPARTMENT' | null;
  assigneeUserId: string | null;
  via: 'RESPONSIBLE' | 'BACKUP' | null;
  /** Told when the responsible person was passed over, or nobody could take it. */
  escalationUserId: string | null;
  /** The people the rule named who could not take the case, and why. */
  passedOver: Array<{ userId: string; reason: 'UNAVAILABLE' | 'IS_REQUESTER' }>;
}

const NO_RULE: RoutingDecision = {
  ruleId: null,
  scope: null,
  assigneeUserId: null,
  via: null,
  escalationUserId: null,
  passedOver: [],
};

export async function resolveCaseRouting(
  companyId: string,
  selection: { departmentId: string; categoryId: string; subcategoryId: string | null },
  requesterUserId: string | null,
): Promise<RoutingDecision> {
  const rules = await prisma.caseRoutingRule.findMany({
    where: {
      companyId,
      departmentId: selection.departmentId,
      isActive: true,
      OR: [
        { categoryId: null },
        { categoryId: selection.categoryId },
        ...(selection.subcategoryId ? [{ categoryId: selection.subcategoryId }] : []),
      ],
    },
  });

  const rule =
    (selection.subcategoryId && rules.find((r) => r.categoryId === selection.subcategoryId)) ||
    rules.find((r) => r.categoryId === selection.categoryId) ||
    rules.find((r) => r.categoryId === null) ||
    null;
  if (!rule) return NO_RULE;

  const scope: RoutingDecision['scope'] =
    rule.categoryId === null
      ? 'DEPARTMENT'
      : rule.categoryId === selection.subcategoryId
        ? 'SUBCATEGORY'
        : 'CATEGORY';

  const named = [rule.responsibleUserId, rule.backupUserId].filter(
    (id): id is string => typeof id === 'string',
  );
  const eligible = await eligibleAgentIds(companyId, named);

  const passedOver: RoutingDecision['passedOver'] = [];
  const pick = (userId: string | null): boolean => {
    if (!userId) return false;
    if (userId === requesterUserId) {
      passedOver.push({ userId, reason: 'IS_REQUESTER' });
      return false;
    }
    if (!eligible.has(userId)) {
      passedOver.push({ userId, reason: 'UNAVAILABLE' });
      return false;
    }
    return true;
  };

  if (pick(rule.responsibleUserId)) {
    return {
      ruleId: rule.id,
      scope,
      assigneeUserId: rule.responsibleUserId,
      via: 'RESPONSIBLE',
      escalationUserId: rule.escalationUserId,
      passedOver,
    };
  }
  if (pick(rule.backupUserId)) {
    return {
      ruleId: rule.id,
      scope,
      assigneeUserId: rule.backupUserId,
      via: 'BACKUP',
      escalationUserId: rule.escalationUserId,
      passedOver,
    };
  }
  return { ...NO_RULE, ruleId: rule.id, scope, escalationUserId: rule.escalationUserId, passedOver };
}

const userName = (u: { firstName: string; lastName: string; email?: string }) =>
  `${u.firstName} ${u.lastName}`.trim() || u.email || 'Unknown';

/** Every rule, labelled, with whether each named person can still take cases. */
export async function routingRuleRecords(companyId: string): Promise<CaseRoutingRuleRecord[]> {
  const rows = await prisma.caseRoutingRule.findMany({
    where: { companyId },
    include: {
      department: { select: { name: true } },
      category: { select: { name: true, parent: { select: { name: true } } } },
      responsible: { select: { id: true, firstName: true, lastName: true, email: true } },
      backup: { select: { id: true, firstName: true, lastName: true, email: true } },
      escalation: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: [{ department: { name: 'asc' } }, { createdAt: 'asc' }],
  });

  const ids = rows.flatMap((r) => [r.responsibleUserId, r.backupUserId, r.escalationUserId]);
  const eligible = await eligibleAgentIds(
    companyId,
    ids.filter((id): id is string => typeof id === 'string'),
  );
  const person = (u: { id: string; firstName: string; lastName: string; email: string } | null) =>
    u ? { userId: u.id, name: userName(u), eligible: eligible.has(u.id) } : null;

  return rows.map((r) => ({
    id: r.id,
    departmentId: r.departmentId,
    departmentName: r.department.name,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    parentCategoryName: r.category?.parent?.name ?? null,
    responsible: person(r.responsible)!,
    backup: person(r.backup),
    escalation: person(r.escalation),
    isActive: r.isActive,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
