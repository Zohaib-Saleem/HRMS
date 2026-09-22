import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_SUBJECT_TYPES = [
  'ATTENDANCE_REGULARIZATION',
  'SHIFT_CHANGE',
  'TIMESHEET',
  'LEAVE_REQUEST',
  'LOAN_REQUEST',
  'ASSET_REQUEST',
] as const;
export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export const APPROVAL_SUBJECT_LABELS: Record<ApprovalSubjectType, string> = {
  ATTENDANCE_REGULARIZATION: 'Attendance correction',
  SHIFT_CHANGE: 'Shift change',
  TIMESHEET: 'Timesheet',
  LEAVE_REQUEST: 'Leave',
  LOAN_REQUEST: 'Loan',
  ASSET_REQUEST: 'Equipment request',
};

/**
 * Which rung of the organisation fills a stage.
 *
 * Mirrors the `ApprovalStage` enum in the database. `TEAM_MANAGER` is answered
 * by the team roster; `HR_MANAGER` and `CEO` by the people a company has
 * named; `LINE_MANAGER` and `DEPARTMENT_HEAD` are the chain that predates
 * stages, kept for the requests that still use it and as the fallback when a
 * company has configured no hierarchy at all.
 */
export const APPROVAL_STAGES = [
  'TEAM_MANAGER',
  'HR_MANAGER',
  'CEO',
  'LINE_MANAGER',
  'DEPARTMENT_HEAD',
] as const;
export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

export const APPROVAL_STAGE_LABELS: Record<ApprovalStage, string> = {
  TEAM_MANAGER: 'Team Manager',
  HR_MANAGER: 'HR Manager',
  CEO: 'CEO',
  LINE_MANAGER: 'Reporting manager',
  DEPARTMENT_HEAD: 'Department head',
};

export const APPROVAL_STAGE_DESCRIPTIONS: Record<ApprovalStage, string> = {
  TEAM_MANAGER:
    "The active managers of the requester's own team, read from the team roster. Never guessed from a job title or a role name.",
  HR_MANAGER: 'The people named as HR Manager for this company.',
  CEO: 'The people named as CEO for this company.',
  LINE_MANAGER: "The requester's own reporting manager, and their second manager where there is one.",
  DEPARTMENT_HEAD: "The head of the requester's department.",
};

/** How many of a stage's approvers must agree. */
export const APPROVAL_STAGE_MODES = ['ANY_ONE', 'ALL'] as const;
export type ApprovalStageMode = (typeof APPROVAL_STAGE_MODES)[number];

export const APPROVAL_STAGE_MODE_LABELS: Record<ApprovalStageMode, string> = {
  ANY_ONE: 'Any one approver',
  ALL: 'Every approver',
};

export const APPROVAL_STAGE_MODE_DESCRIPTIONS: Record<ApprovalStageMode, string> = {
  ANY_ONE:
    'The first decision carries the stage. With three team managers, whichever one gets there first signs for the team and the other two see a completed stage.',
  ALL: 'Every named approver has to approve before the request moves on. One rejection still ends it.',
};

/**
 * The chain a company gets when it has configured nothing.
 *
 * Stored nowhere until somebody changes it: an empty `approval_workflows`
 * table means "every company uses this", which is the state a fresh
 * installation boots into. A stage that resolves to nobody is skipped and the
 * skip is recorded on the request, so a company that has not yet named a CEO
 * still gets a working two-stage chain rather than requests that cannot move.
 */
export interface ApprovalStageDefinition {
  stage: ApprovalStage;
  mode: ApprovalStageMode;
}

export const DEFAULT_APPROVAL_STAGES: Record<ApprovalSubjectType, readonly ApprovalStageDefinition[]> = {
  LEAVE_REQUEST: [
    { stage: 'TEAM_MANAGER', mode: 'ANY_ONE' },
    { stage: 'HR_MANAGER', mode: 'ANY_ONE' },
    { stage: 'CEO', mode: 'ANY_ONE' },
  ],
  ASSET_REQUEST: [
    { stage: 'TEAM_MANAGER', mode: 'ANY_ONE' },
    { stage: 'HR_MANAGER', mode: 'ANY_ONE' },
    { stage: 'CEO', mode: 'ANY_ONE' },
  ],
  /*
   * The four below keep the chain they have always had: the requester's own
   * reporting manager, then the department head if there is no manager.
   *
   * Deliberately NOT moved onto the three-stage hierarchy. A forgotten
   * check-out is corrected by the person who can say whether you were at your
   * desk, and sending eleven of those a week to the CEO would empty the
   * meaning out of the CEO's approval queue within a month. A company that
   * wants otherwise configures it; the default declines to decide that for
   * them.
   */
  /*
   * ALL, and it is not an oversight. `LINE_MANAGER` resolves to the reporting
   * manager AND the second manager where a matrix organisation has set one,
   * and before stages existed those were two sequential steps that BOTH had to
   * approve. ANY_ONE here would quietly halve that requirement on the morning
   * of this release for every company using dual reporting.
   */
  ATTENDANCE_REGULARIZATION: [{ stage: 'LINE_MANAGER', mode: 'ALL' }],
  SHIFT_CHANGE: [{ stage: 'LINE_MANAGER', mode: 'ALL' }],
  TIMESHEET: [{ stage: 'LINE_MANAGER', mode: 'ALL' }],
  LOAN_REQUEST: [{ stage: 'LINE_MANAGER', mode: 'ALL' }],
};

export const approvalQuerySchema = paginationQuerySchema.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES).optional(),
  /** `inbox` limits the list to requests awaiting this caller's decision. */
  view: z.enum(['all', 'inbox', 'mine']).default('all'),
});

export const approvalDecisionSchema = z.object({
  comment: z.string().trim().max(1000).optional(),
});

export const approvalCancelSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

// ------------------------------------------------- the hierarchy, configured

const stageDefinitionSchema = z.object({
  stage: z.enum(APPROVAL_STAGES),
  mode: z.enum(APPROVAL_STAGE_MODES).default('ANY_ONE'),
});

export const approvalWorkflowUpdateSchema = z.object({
  subjectType: z.enum(APPROVAL_SUBJECT_TYPES),
  /**
   * The chain, in order. An EMPTY array is meaningful and allowed: it deletes
   * the company's override and returns that subject type to the built-in
   * default, which is a thing an administrator who has made a mess needs to be
   * able to do without knowing what the default was.
   */
  stages: z
    .array(stageDefinitionSchema)
    .max(6, 'A chain of more than six stages is a process nobody will finish.')
    .superRefine((stages, ctx) => {
      const seen = new Set<string>();
      for (const [index, entry] of stages.entries()) {
        if (seen.has(entry.stage)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'stage'],
            message: 'That stage is already in this chain. One rung each.',
          });
        }
        seen.add(entry.stage);
      }
    }),
});

export type ApprovalWorkflowUpdateInput = z.infer<typeof approvalWorkflowUpdateSchema>;

export const approvalStageAssigneeSchema = z.object({
  /// Only the company-wide stages can be filled by name. TEAM_MANAGER comes
  /// from the team roster, and accepting it here would create a second,
  /// disagreeing answer to "who manages this team".
  stage: z.enum(['HR_MANAGER', 'CEO'] as const),
  employeeId: z.string().trim().min(1, 'Choose an employee.'),
});

export type ApprovalStageAssigneeInput = z.infer<typeof approvalStageAssigneeSchema>;

export interface ApprovalStageAssigneeRecord {
  id: string;
  stage: ApprovalStage;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  designation: string | null;
  isActive: boolean;
  /** False when the person has left. A stage never resolves to them again. */
  isEmployed: boolean;
  assignedAt: string;
}

export interface ApprovalWorkflowStageRecord {
  stageOrder: number;
  stage: ApprovalStage;
  mode: ApprovalStageMode;
  /** How many people this stage would resolve to for the company right now. */
  resolvedApproverCount: number | null;
}

export interface ApprovalWorkflowRecord {
  subjectType: ApprovalSubjectType;
  subjectLabel: string;
  /** True when this is the built-in chain rather than a stored override. */
  isDefault: boolean;
  stages: ApprovalWorkflowStageRecord[];
}

/** Everything the approval-hierarchy screen needs, in one response. */
export interface ApprovalHierarchySettings {
  workflows: ApprovalWorkflowRecord[];
  assignees: ApprovalStageAssigneeRecord[];
  /**
   * Stages configured into a chain that would currently resolve to nobody, as
   * plain sentences. A configuration warning rather than an error: the chain
   * still works, it simply skips that rung, and an administrator ought to know
   * that before somebody's leave sails past the CEO.
   */
  warnings: string[];
  canManage: boolean;
}

/** One named approver on a step, as the approval screens show them. */
export interface ApprovalStepApproverRecord {
  employeeId: string;
  name: string;
  status: ApprovalStatus;
  decidedAt: string | null;
  comment: string | null;
  /** True when this is the caller. Drives "you" wording, never authority. */
  isMe: boolean;
}

export interface ApprovalStepRecord {
  id: string;
  stepOrder: number;
  status: ApprovalStatus;
  /**
   * The step's single named approver, where it has one. Null for a stage
   * filled by several people - read `approvers` instead, which is always
   * populated and is what the server checks.
   */
  approverName: string | null;
  decidedAt: string | null;
  comment: string | null;
  stage: ApprovalStage | null;
  stageLabel: string;
  mode: ApprovalStageMode;
  approvers: ApprovalStepApproverRecord[];
  /** Who actually signed, once somebody has. Empty while the step is open. */
  decidedByNames: string[];
}

export interface ApprovalEventRecord {
  id: string;
  action: string;
  fromStatus: ApprovalStatus | null;
  toStatus: ApprovalStatus;
  comment: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface ApprovalListItem {
  id: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  title: string;
  summary: string | null;
  status: ApprovalStatus;
  currentStep: number;
  totalSteps: number;
  requesterName: string;
  requesterEmployeeId: string;
  createdAt: string;
  decidedAt: string | null;
  /** True when this caller is the approver of the step awaiting a decision. */
  awaitingMyDecision: boolean;
}

export interface ApprovalDetail extends ApprovalListItem {
  steps: ApprovalStepRecord[];
  events: ApprovalEventRecord[];
  canDecide: boolean;
  canCancel: boolean;
}
