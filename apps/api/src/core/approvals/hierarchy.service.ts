import type { Prisma } from '@prisma/client';
import {
  APPROVAL_STAGE_LABELS,
  DEFAULT_APPROVAL_STAGES,
  type ApprovalStage,
  type ApprovalStageDefinition,
  type ApprovalStageMode,
  type ApprovalSubjectType,
} from '@hrms/shared';
import { prisma } from '../db.js';

/**
 * The organisation hierarchy, turned into an approval chain.
 *
 * This file answers one question and answers it in one place: GIVEN A PERSON
 * AND A KIND OF REQUEST, WHO HAS TO SIGN, IN WHAT ORDER, AND HOW MANY OF THEM
 * AT EACH RUNG. Everything else in the approval engine is a state machine over
 * the answer.
 *
 * Four rules run through it, and each exists because its absence produces a
 * specific, observed failure:
 *
 * 1. A STAGE IS A JOB, NOT A PERSON, AND IS NEVER INFERRED. `TEAM_MANAGER`
 *    reads `team_managers`. `HR_MANAGER` and `CEO` read
 *    `approval_stage_assignees`. Nothing here looks at a job title, a
 *    designation, a department name, a role name or an employee's name. A
 *    company with a "Manager, Facilities" does not thereby acquire an
 *    approver.
 *
 * 2. A STAGE NEVER RESOLVES TO SOMEBODY WHO CANNOT ACT. The requester is
 *    removed from every stage - nobody approves their own request, and a team
 *    manager raising leave must not be handed their own first rung. Employees
 *    whose status is not ACTIVE are removed too, WHATEVER THE ROSTER SAYS, so
 *    a manager terminated last night does not become the reason nobody's leave
 *    can move today.
 *
 * 3. NOBODY APPEARS TWICE IN ONE CHAIN. If the person named as HR Manager also
 *    manages the requester's team, they fill the earlier stage and are struck
 *    from the later one. This is not tidiness: the engine refuses to let one
 *    user decide two steps of the same request - deliberately, because a
 *    two-person chain that one person can satisfy is not a chain - so a
 *    duplicate would produce a request that becomes permanently stuck at the
 *    stage its only approver is forbidden to decide.
 *
 * 4. A STAGE THAT RESOLVES TO NOBODY IS SKIPPED, AND THE SKIP IS RECORDED. A
 *    company that has not yet named a CEO gets a working two-stage chain and a
 *    line in the request's history saying the CEO stage was skipped because
 *    nobody fills it. The alternative - refusing the request - means a company
 *    cannot approve a single day's leave until somebody has visited a settings
 *    screen, which is how a feature gets switched off in its first week.
 */

export interface ResolvedStage {
  stage: ApprovalStage;
  mode: ApprovalStageMode;
  /** In order. The first is written to `approverEmployeeId` when it is alone. */
  approverEmployeeIds: string[];
}

export interface SkippedStage {
  stage: ApprovalStage;
  reason: string;
}

export interface ResolvedChain {
  stages: ResolvedStage[];
  skipped: SkippedStage[];
  /** True when no stored workflow applied and the built-in default was used. */
  isDefault: boolean;
}

/**
 * The stage definitions in force for one company and one subject type.
 *
 * A stored workflow wins; otherwise the built-in default. An INACTIVE workflow
 * is treated as absent rather than as an empty chain - switching one off means
 * "go back to the default", not "let everything through unapproved".
 */
export async function workflowStagesFor(
  companyId: string,
  subjectType: ApprovalSubjectType,
): Promise<{ stages: readonly ApprovalStageDefinition[]; isDefault: boolean }> {
  const workflow = await prisma.approvalWorkflow.findFirst({
    where: { companyId, subjectType, isActive: true },
    include: { stages: { where: { isActive: true }, orderBy: { stageOrder: 'asc' } } },
  });

  if (!workflow || workflow.stages.length === 0) {
    return { stages: DEFAULT_APPROVAL_STAGES[subjectType], isDefault: true };
  }

  return {
    stages: workflow.stages.map((row) => ({
      stage: row.stage as ApprovalStage,
      mode: row.mode as ApprovalStageMode,
    })),
    isDefault: false,
  };
}

/** Employee ids that are usable as approvers: this company, and at work. */
async function activeEmployeeIds(companyId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.employee.findMany({
    where: { companyId, id: { in: [...new Set(ids)] }, status: 'ACTIVE' },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** The active managers of one team, in the order they were appointed. */
export async function activeTeamManagerIds(companyId: string, teamId: string): Promise<string[]> {
  const rows = await prisma.teamManager.findMany({
    where: { companyId, teamId, isActive: true },
    orderBy: { assignedAt: 'asc' },
    select: { employeeId: true },
  });
  return rows.map((row) => row.employeeId);
}

/** The people named for a company-wide stage, in the order they were named. */
export async function stageAssigneeIds(
  companyId: string,
  stage: ApprovalStage,
): Promise<string[]> {
  const rows = await prisma.approvalStageAssignee.findMany({
    where: { companyId, stage, isActive: true },
    orderBy: { assignedAt: 'asc' },
    select: { employeeId: true },
  });
  return rows.map((row) => row.employeeId);
}

/** The requester's own facts, read once and reused by every stage. */
interface RequesterContext {
  id: string;
  teamId: string | null;
  managerId: string | null;
  secondaryManagerId: string | null;
  departmentHeadId: string | null;
}

async function requesterContext(
  companyId: string,
  employeeId: string,
): Promise<RequesterContext | null> {
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, companyId },
    select: {
      id: true,
      teamId: true,
      managerId: true,
      secondaryManagerId: true,
      department: { select: { headEmployeeId: true } },
    },
  });
  if (!employee) return null;

  return {
    id: employee.id,
    teamId: employee.teamId,
    managerId: employee.managerId,
    secondaryManagerId: employee.secondaryManagerId,
    departmentHeadId: employee.department?.headEmployeeId ?? null,
  };
}

/** Candidates for one stage, before any filtering. */
async function candidatesFor(
  companyId: string,
  stage: ApprovalStage,
  requester: RequesterContext,
): Promise<{ ids: string[]; emptyReason: string }> {
  switch (stage) {
    case 'TEAM_MANAGER': {
      if (!requester.teamId) {
        return { ids: [], emptyReason: 'the requester is not on a team' };
      }
      const ids = await activeTeamManagerIds(companyId, requester.teamId);
      return { ids, emptyReason: 'their team has no active manager who can decide it' };
    }
    case 'HR_MANAGER':
      return {
        ids: await stageAssigneeIds(companyId, 'HR_MANAGER'),
        emptyReason: 'nobody is named as HR Manager',
      };
    case 'CEO':
      return {
        ids: await stageAssigneeIds(companyId, 'CEO'),
        emptyReason: 'nobody is named as CEO',
      };
    case 'LINE_MANAGER': {
      /*
       * The chain this product had before stages existed, preserved exactly:
       * the reporting manager and the second manager where a matrix
       * organisation has set one, falling back to the department head so that
       * an employee with no manager is not left unable to request anything.
       */
      const ids = [requester.managerId, requester.secondaryManagerId].filter(
        (id): id is string => Boolean(id),
      );
      if (ids.length === 0 && requester.departmentHeadId) ids.push(requester.departmentHeadId);
      return { ids, emptyReason: 'they have no reporting manager and their department has no head' };
    }
    case 'DEPARTMENT_HEAD':
      return {
        ids: requester.departmentHeadId ? [requester.departmentHeadId] : [],
        emptyReason: 'their department has no head',
      };
    default:
      return { ids: [], emptyReason: 'that stage cannot be filled' };
  }
}

/**
 * Turn the configured chain into the people who will actually be asked.
 *
 * The four rules at the top of this file are applied here, in this order:
 * candidates, minus the requester, minus anybody not ACTIVE, minus anybody
 * already used by an earlier stage. What survives is the stage; what does not
 * is a skip with a sentence attached.
 */
export async function resolveApprovalChain(
  companyId: string,
  subjectType: ApprovalSubjectType,
  requesterEmployeeId: string,
): Promise<ResolvedChain> {
  const requester = await requesterContext(companyId, requesterEmployeeId);
  if (!requester) return { stages: [], skipped: [], isDefault: true };

  const { stages: definitions, isDefault } = await workflowStagesFor(companyId, subjectType);

  const resolved: ResolvedStage[] = [];
  const skipped: SkippedStage[] = [];
  const usedAlready = new Set<string>();

  for (const definition of definitions) {
    const { ids, emptyReason } = await candidatesFor(companyId, definition.stage, requester);

    const unique = [...new Set(ids)].filter((id) => id !== requesterEmployeeId);
    const active = await activeEmployeeIds(companyId, unique);
    const approverEmployeeIds = unique.filter((id) => active.has(id) && !usedAlready.has(id));

    if (approverEmployeeIds.length === 0) {
      skipped.push({
        stage: definition.stage,
        reason:
          unique.length === 0
            ? emptyReason
            : 'everybody who fills it has already been asked earlier in this chain, or has left',
      });
      continue;
    }

    for (const id of approverEmployeeIds) usedAlready.add(id);
    resolved.push({
      stage: definition.stage,
      mode: definition.mode,
      approverEmployeeIds,
    });
  }

  /*
   * LAST RESORT. A configured chain that resolves to nobody at all - a company
   * with no team managers, no named HR and no named CEO - falls back to the
   * line manager, which is what every request in this product used before this
   * feature existed. If that is empty too the caller raises the ordinary "no
   * approver could be determined" error, which names the fix.
   */
  if (resolved.length === 0) {
    const { ids, emptyReason } = await candidatesFor(companyId, 'LINE_MANAGER', requester);
    const unique = [...new Set(ids)].filter((id) => id !== requesterEmployeeId);
    const active = await activeEmployeeIds(companyId, unique);
    const fallback = unique.filter((id) => active.has(id));

    if (fallback.length > 0) {
      resolved.push({ stage: 'LINE_MANAGER', mode: 'ALL', approverEmployeeIds: fallback });
    } else {
      skipped.push({ stage: 'LINE_MANAGER', reason: emptyReason });
    }
  }

  return { stages: resolved, skipped, isDefault };
}

/** A sentence describing a skip, for the request history. */
export function describeSkip(skip: SkippedStage): string {
  return `${APPROVAL_STAGE_LABELS[skip.stage]} stage skipped: ${skip.reason}.`;
}

/**
 * How many people each stage would resolve to for a company RIGHT NOW,
 * ignoring any particular requester.
 *
 * Used by the settings screen to warn that a configured stage is empty. It
 * cannot answer `TEAM_MANAGER` with a single number - that depends on whose
 * request it is - so it reports how many teams have at least one active
 * manager, which is the number an administrator actually wants to see.
 */
export async function stageCoverage(
  companyId: string,
): Promise<Record<ApprovalStage, number> & { teamsWithoutManager: number }> {
  const [hr, ceo, teamsTotal, teamsCovered, headCount] = await Promise.all([
    prisma.approvalStageAssignee.count({
      where: { companyId, stage: 'HR_MANAGER', isActive: true, employee: { status: 'ACTIVE' } },
    }),
    prisma.approvalStageAssignee.count({
      where: { companyId, stage: 'CEO', isActive: true, employee: { status: 'ACTIVE' } },
    }),
    prisma.team.count({ where: { companyId, isActive: true } }),
    prisma.team.count({
      where: {
        companyId,
        isActive: true,
        managers: { some: { isActive: true, employee: { status: 'ACTIVE' } } },
      },
    }),
    prisma.department.count({ where: { companyId, isActive: true, headEmployeeId: { not: null } } }),
  ]);

  return {
    TEAM_MANAGER: teamsCovered,
    HR_MANAGER: hr,
    CEO: ceo,
    LINE_MANAGER: 0,
    DEPARTMENT_HEAD: headCount,
    teamsWithoutManager: teamsTotal - teamsCovered,
  };
}

/** The `where` fragment for "teams this employee actively manages". */
export function managedTeamWhere(employeeId: string): Prisma.TeamManagerWhereInput {
  return { employeeId, isActive: true };
}
