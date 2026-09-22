import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import {
  APPROVAL_STAGE_LABELS,
  type ApprovalStage,
  type AssetRequestDetail,
  type AssetRequestItemRecord,
  type AssetRequestListItem,
  type AssetRequestStatus,
} from '@hrms/shared';

/**
 * Turning asset-request rows into the shapes the screens read.
 *
 * The counting lives here rather than in the routes because "how much of this
 * has actually been delivered" is asked by three different endpoints, and a
 * second implementation of it is a second answer.
 *
 * DELIVERY IS COUNTED FROM ASSIGNMENTS. Not from a column somebody remembers
 * to update: an asset was delivered when there is an assignment row for it
 * pointing at the request line, which is the same row the register reads to
 * say who is holding the laptop. One fact, one place.
 */

export const ASSET_REQUEST_INCLUDE = {
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      employeeNumber: true,
      team: { select: { name: true } },
    },
  },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      category: { select: { id: true, name: true } },
      assignments: {
        orderBy: { assignedAt: 'asc' },
        include: { asset: { select: { id: true, assetTag: true, name: true } } },
      },
    },
  },
} satisfies Prisma.AssetRequestInclude;

export type AssetRequestRow = Prisma.AssetRequestGetPayload<{
  include: typeof ASSET_REQUEST_INCLUDE;
}>;

/**
 * As much of an approval as these screens need.
 *
 * Fetched separately rather than through a relation, and that is not an
 * oversight: the approval engine stores `(subjectType, subjectId)` and holds
 * NO foreign key to any domain table, precisely so that it can be shared by
 * leave, loans, timesheets and this without depending on any of them. Leave
 * does the same thing with the same column.
 */
export interface ApprovalSnapshot {
  status: string;
  currentStep: number;
  steps: Array<{
    stepOrder: number;
    stage: string | null;
    status: string;
    approvers: Array<{ employeeId: string; status: string }>;
  }>;
}

/** One query for a whole page of requests, keyed by approval id. */
export async function approvalSnapshots(
  approvalIds: readonly (string | null)[],
): Promise<Map<string, ApprovalSnapshot>> {
  const ids = [...new Set(approvalIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const rows = await prisma.approvalRequest.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      currentStep: true,
      steps: {
        orderBy: { stepOrder: 'asc' },
        select: {
          stepOrder: true,
          stage: true,
          status: true,
          approvers: { select: { employeeId: true, status: true } },
        },
      },
    },
  });

  return new Map(rows.map((row) => [row.id, row as ApprovalSnapshot]));
}

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

export function toItemRecord(item: AssetRequestRow['items'][number]): AssetRequestItemRecord {
  const fulfilledCount = item.assignments.length;
  return {
    id: item.id,
    categoryId: item.categoryId,
    categoryName: item.category.name,
    quantity: item.quantity,
    notes: item.notes,
    fulfilledCount,
    declinedAt: item.declinedAt?.toISOString() ?? null,
    declineReason: item.declineReason,
    issuedAssets: item.assignments.map((a) => ({
      assetId: a.asset.id,
      assetTag: a.asset.assetTag,
      name: a.asset.name,
      assignedAt: a.assignedAt.toISOString(),
    })),
    isSettled: Boolean(item.declinedAt) || fulfilledCount >= item.quantity,
  };
}

/** The rung the request is sitting on, in words. Null once it is decided. */
export function currentStageLabel(approval: ApprovalSnapshot | undefined): string | null {
  if (!approval || approval.status !== 'PENDING') return null;
  const step = approval.steps.find((s) => s.stepOrder === approval.currentStep);
  if (!step) return null;
  const stage = step.stage as ApprovalStage | null;
  return stage ? APPROVAL_STAGE_LABELS[stage] : `Step ${step.stepOrder}`;
}

/** True when this employee has an open seat on the step that is waiting. */
export function awaitsDecisionBy(
  approval: ApprovalSnapshot | undefined,
  employeeId: string | null,
): boolean {
  if (!employeeId) return false;
  if (!approval || approval.status !== 'PENDING') return false;
  const step = approval.steps.find((s) => s.stepOrder === approval.currentStep);
  if (!step || step.status !== 'PENDING') return false;
  return step.approvers.some((a) => a.employeeId === employeeId && a.status === 'PENDING');
}

export function toListItem(
  row: AssetRequestRow,
  callerEmployeeId: string | null,
  approval?: ApprovalSnapshot,
): AssetRequestListItem {
  const items = row.items.map(toItemRecord);
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    teamName: row.employee.team?.name ?? null,
    status: row.status as AssetRequestStatus,
    justification: row.justification,
    neededBy: row.neededBy ? row.neededBy.toISOString().slice(0, 10) : null,
    itemCount: items.length,
    fulfilledCount: items.reduce((sum, item) => sum + item.fulfilledCount, 0),
    requestedCount: items.reduce((sum, item) => sum + item.quantity, 0),
    approvalRequestId: row.approvalRequestId,
    currentStageLabel: currentStageLabel(approval),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    awaitingMyDecision: awaitsDecisionBy(approval, callerEmployeeId),
  };
}

export function toDetail(
  row: AssetRequestRow,
  callerEmployeeId: string | null,
  canFulfil: boolean,
  approval?: ApprovalSnapshot,
): AssetRequestDetail {
  return {
    ...toListItem(row, callerEmployeeId, approval),
    items: row.items.map(toItemRecord),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    canCancel: row.status === 'PENDING' && callerEmployeeId === row.employeeId,
    /*
     * Never offered while the chain is still running, whatever the caller
     * holds. This is the UI half of the rule; the route refuses the call as
     * well, and that is the half that matters.
     */
    canFulfil: canFulfil && row.status === 'APPROVED',
  };
}

/** True when nothing on the request is outstanding any more. */
export function isFullySettled(row: AssetRequestRow): boolean {
  return row.items.every((item) => Boolean(item.declinedAt) || item.assignments.length >= item.quantity);
}
