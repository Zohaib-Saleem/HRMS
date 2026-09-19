import type { Prisma } from '@prisma/client';
import { assetClearanceState } from '@hrms/shared';
import type {
  AssetAcknowledgementStatus,
  AssetAssignmentStatus,
  AssetCondition,
  AssetStatus,
  EmployeeAssetClearance,
  EmployeeAssetRow,
} from '@hrms/shared';
import { isLeaving } from './asset-lifecycle.service.js';

/**
 * An asset seen from a PERSON rather than from the register.
 *
 * The same rows, read the other way round: "what has Ahmed got" instead of
 * "who has this laptop". One mapper for both the employee profile tab and the
 * employee's own dashboard card, because a second copy is how the profile ends
 * up showing a serial number the dashboard does not.
 */

export const EMPLOYEE_ASSET_INCLUDE = {
  asset: {
    select: {
      id: true,
      assetTag: true,
      name: true,
      serialNumber: true,
      status: true,
      currentValue: true,
      category: { select: { name: true } },
    },
  },
} satisfies Prisma.AssetAssignmentInclude;

type Row = Prisma.AssetAssignmentGetPayload<{ include: typeof EMPLOYEE_ASSET_INCLUDE }>;

export function toEmployeeAssetRow(row: Row): EmployeeAssetRow {
  return {
    assignmentId: row.id,
    assetId: row.asset.id,
    assetTag: row.asset.assetTag,
    name: row.asset.name,
    categoryName: row.asset.category?.name ?? null,
    serialNumber: row.asset.serialNumber,
    assignedAt: row.assignedAt.toISOString(),
    returnedAt: row.returnedAt?.toISOString() ?? null,
    conditionAtAssignment: (row.conditionAtAssignment as AssetCondition | null) ?? null,
    conditionAtReturn: (row.conditionAtReturn as AssetCondition | null) ?? null,
    accessoriesIssued: row.accessoriesIssued,
    accessoriesMissing: row.accessoriesMissing,
    assignmentStatus: row.status as AssetAssignmentStatus,
    assetStatus: row.asset.status as AssetStatus,
    acknowledgementStatus: row.acknowledgementStatus as AssetAcknowledgementStatus,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    currentValue: row.asset.currentValue === null ? null : Number(row.asset.currentValue),
  };
}

/**
 * Asset clearance for somebody on their way out.
 *
 * COUNTS, never actions, and that is section 11's explicit instruction: nothing
 * here marks an asset returned. A clearance screen that could tick its own
 * boxes is a screen that says the laptop came back when it did not; HR records
 * the real return through the return endpoint, and this counts the result.
 *
 * `pending` is the number that matters and it is deliberately the ACTIVE
 * handovers - what this person is still holding on the day they leave. An asset
 * they lost or broke is counted separately AND stays in `pending`, because
 * neither of those is the same as having handed it back and both still need
 * settling.
 */
export function buildClearance(
  employeeStatus: string,
  rows: readonly EmployeeAssetRow[],
): EmployeeAssetClearance {
  const active = rows.filter((row) => row.assignmentStatus === 'ACTIVE');

  const returned = rows.filter((row) => row.assignmentStatus === 'RETURNED').length;

  const clearance: EmployeeAssetClearance = {
    applies: isLeaving(employeeStatus),
    assigned: rows.length,
    returned,
    pending: active.length,
    damaged: active.filter((row) => row.assetStatus === 'DAMAGED').length,
    lost: active.filter((row) => row.assetStatus === 'LOST').length,
    cleared: active.length === 0,
    /*
     * The headline, derived by the shared function rather than by a ternary
     * here. Section 7 asks for three states and the middle one is the reason:
     * somebody who has handed back the laptop and still has the monitor is
     * PARTIALLY CLEARED, and reporting them as PENDING - which a boolean must -
     * sends HR looking for everything when they are waiting on one thing.
     */
    state: assetClearanceState({ returned, pending: active.length }),
  };

  return clearance;
}

/** What somebody is holding right now is worth this much. */
export function totalCurrentValue(rows: readonly EmployeeAssetRow[]): number {
  return rows.reduce((total, row) => total + (row.currentValue ?? 0), 0);
}
