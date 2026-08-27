import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_SUBJECT_TYPES = [
  'ATTENDANCE_REGULARIZATION',
  'SHIFT_CHANGE',
  'TIMESHEET',
  'LEAVE_REQUEST',
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

export interface ApprovalStepRecord {
  id: string;
  stepOrder: number;
  status: ApprovalStatus;
  approverName: string | null;
  decidedAt: string | null;
  comment: string | null;
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
