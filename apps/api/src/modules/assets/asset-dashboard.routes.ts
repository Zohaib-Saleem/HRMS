import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  EMPTY_ASSET_SUMMARY,
  PERMISSIONS,
  assetClearanceState,
  assetDashboardQuerySchema,
  type AssetAlertRow,
  type AssetAlerts,
  type AssetBreakdownSlice,
  type AssetClearanceRow,
  type AssetDashboard,
  type AssetStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { addDays, assetToday, dateColumn, daysBetween } from './assets.service.js';

/**
 * The asset dashboard.
 *
 * ONE ENDPOINT, and the shared DTO says why: every figure on this screen is a
 * question about the same rows asked at the same instant. Nine endpoints would
 * answer them at nine instants, which on a register somebody is actively
 * editing produces a page whose tiles do not add up to its own charts - and the
 * person reading it has no way to tell that from a bug in the arithmetic.
 *
 * GATED ON `asset.read.all`, NOT ON `asset.read`, and this is the one endpoint
 * in the module where the wide grant is the entry condition rather than a
 * widening of it. The reason is that there is no honest narrow version of this
 * screen: "total assets: 1, none under repair, no warranties expiring" is not a
 * smaller dashboard, it is a misleading one. An employee's own view of their
 * kit is `/assets/my`, which answers the question they actually have.
 *
 * Because the gate is the wide grant, there is no scope filter below - the
 * company boundary IS the filter. That is deliberate and it is the only place
 * in this module where `assetScopeFilter` is absent; every other read builds
 * its WHERE from it.
 */

/**
 * How many rows an alert carries, however many it counts.
 *
 * The counts are exact and unbounded; the ROWS are capped, because an alert
 * list is a thing somebody acts on this morning and a register with four
 * hundred expiring warranties needs a filtered list screen rather than a longer
 * dashboard. The count keeps telling the truth about the size of the problem
 * while the rows stay the shortlist, which is the split section 8 asks for.
 */
const ALERT_ROW_LIMIT = 50;

/** On their way out, or already gone. The same pair `isLeaving` tests. */
const LEAVING = ['RESIGNED', 'TERMINATED'] as const;

/**
 * Statuses a warranty alert ignores.
 *
 * A disposed laptop's warranty running out is not anybody's problem - the thing
 * it covered is gone. Retired is the same argument one step earlier: the asset
 * is out of service on purpose, and putting it on a list of things to chase
 * would train people to ignore the list.
 */
const NOT_IN_SERVICE: AssetStatus[] = ['RETIRED', 'DISPOSED'];

/** A `@db.Date` column as `yyyy-MM-dd`, with no timezone in the answer. */
function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function personName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/**
 * What an alert row needs, and nothing else.
 *
 * Its own select rather than `ASSET_INCLUDE`, because the alert row is
 * deliberately the smallest thing somebody can decide from - the DTO makes that
 * point and this is where it is kept. Reusing the register's include would pull
 * the site, the department and every money column into six queries that display
 * none of them.
 */
const ALERT_SELECT = {
  id: true,
  assetTag: true,
  name: true,
  status: true,
  warrantyEnd: true,
  category: { select: { name: true } },
  assignments: {
    where: { status: 'ACTIVE' as const },
    orderBy: { assignedAt: 'desc' as const },
    take: 1,
    select: {
      assignedAt: true,
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.AssetSelect;

type AlertAsset = Prisma.AssetGetPayload<{ select: typeof ALERT_SELECT }>;

/**
 * An asset as an alert names it.
 *
 * `date` carries whichever date put the row on THIS list - the warranty end for
 * a warranty alert, the handover date for an asset still out with somebody who
 * has left - and `days` is measured against the company's today, computed here
 * rather than in the browser. A browser in another timezone would otherwise
 * report a warranty as expiring tomorrow when the office's calendar says it
 * expired yesterday.
 */
function toAlertRow(asset: AlertAsset, today: string, kind: 'warranty' | 'holding'): AssetAlertRow {
  const active = asset.assignments[0];
  const date =
    kind === 'warranty' ? toDateOnly(asset.warrantyEnd) : (active?.assignedAt.toISOString().slice(0, 10) ?? null);

  return {
    id: asset.id,
    assetTag: asset.assetTag,
    name: asset.name,
    status: asset.status as AssetStatus,
    categoryName: asset.category?.name ?? null,
    holderName: active ? personName(active.employee) : null,
    holderEmployeeId: active?.employee.id ?? null,
    date,
    days: date === null ? null : daysBetween(today, date),
  };
}

/**
 * A grouped result as a list of slices, with the names filled in.
 *
 * `groupBy` returns ids, so the labels come from one lookup of the whole
 * catalogue rather than from an include per group - two queries instead of one
 * per slice. The null key is kept rather than dropped: an asset filed under
 * nothing is a real asset, and dropping its bucket would make the slices stop
 * summing to the total above them, which is the fastest way to make a dashboard
 * untrustworthy.
 */
function toSlices(
  groups: { key: string | null; count: number; purchaseValue: number; currentValue: number }[],
  labels: Map<string, string>,
  unfiled: string,
): AssetBreakdownSlice[] {
  return groups
    .map((group) => ({
      key: group.key,
      label: group.key === null ? unfiled : (labels.get(group.key) ?? unfiled),
      count: group.count,
      purchaseValue: group.purchaseValue,
      currentValue: group.currentValue,
    }))
    .sort((a, b) => {
      // The unfiled bucket sits last however big it is: it is the residue, not
      // a category somebody chose, and leading with it reads as a data problem
      // rather than as the answer to "what do we own".
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

/** `_sum` of a Decimal column as a number, with the empty group as zero. */
function sum(value: Prisma.Decimal | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export const assetDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_READ_ALL));

  app.get('/dashboard', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { warrantyDays } = parseOrThrow(assetDashboardQuerySchema, request.query);

    const today = await assetToday(auth.companyId);
    const horizon = addDays(today, warrantyDays);

    const company: Prisma.AssetWhereInput = { companyId: auth.companyId };

    /*
     * The warranty window and the leaver clauses, named once and then used by
     * both the count and the rows. Two copies of "expiring" is how a tile ends
     * up disagreeing with the list it opens.
     */
    const expiring: Prisma.AssetWhereInput = {
      ...company,
      status: { notIn: NOT_IN_SERVICE },
      warrantyEnd: { gte: dateColumn(today)!, lte: dateColumn(horizon)! },
    };

    const stillOut: Prisma.AssetWhereInput = {
      ...company,
      assignments: { some: { status: 'ACTIVE', employee: { status: { in: [...LEAVING] } } } },
    };

    const leavers: Prisma.EmployeeWhereInput = {
      companyId: auth.companyId,
      status: { in: [...LEAVING] },
      assetAssignments: { some: { status: 'ACTIVE' } },
    };

    const [
      byStatus,
      byCategory,
      byDepartment,
      categories,
      departments,
      warrantyCount,
      warrantyRows,
      notReturnedCount,
      notReturnedRows,
      clearanceCount,
      clearanceRows,
    ] = await Promise.all([
      prisma.asset.groupBy({
        by: ['status'],
        where: company,
        _count: { _all: true },
        _sum: { purchasePrice: true, currentValue: true },
      }),
      prisma.asset.groupBy({
        by: ['categoryId'],
        where: company,
        _count: { _all: true },
        _sum: { purchasePrice: true, currentValue: true },
      }),
      prisma.asset.groupBy({
        by: ['departmentId'],
        where: company,
        _count: { _all: true },
        _sum: { purchasePrice: true, currentValue: true },
      }),
      prisma.assetCategory.findMany({
        where: { companyId: auth.companyId },
        select: { id: true, name: true, parent: { select: { name: true } } },
      }),
      prisma.department.findMany({
        where: { companyId: auth.companyId },
        select: { id: true, name: true },
      }),
      prisma.asset.count({ where: expiring }),
      prisma.asset.findMany({
        where: expiring,
        select: ALERT_SELECT,
        orderBy: { warrantyEnd: 'asc' },
        take: ALERT_ROW_LIMIT,
      }),
      prisma.asset.count({ where: stillOut }),
      prisma.asset.findMany({
        where: stillOut,
        select: ALERT_SELECT,
        orderBy: { assetTag: 'asc' },
        take: ALERT_ROW_LIMIT,
      }),
      prisma.employee.count({ where: leavers }),
      prisma.employee.findMany({
        where: leavers,
        select: {
          id: true,
          employeeNumber: true,
          firstName: true,
          lastName: true,
          status: true,
          department: { select: { name: true } },
          // Every handover this person has ever had, so the clearance state can
          // tell "handed back two of three" from "handed back nothing". Both
          // counts come off the same rows; asking the database for two counts
          // per leaver would be a query per person.
          assetAssignments: { select: { status: true } },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: ALERT_ROW_LIMIT,
      }),
    ]);

    const statuses = { ...EMPTY_ASSET_SUMMARY.byStatus };
    let total = 0;
    let totalPurchaseValue = 0;
    let totalCurrentValue = 0;
    for (const row of byStatus) {
      const status = row.status as AssetStatus;
      statuses[status] = row._count._all;
      total += row._count._all;
      totalPurchaseValue += sum(row._sum?.purchasePrice);
      totalCurrentValue += sum(row._sum?.currentValue);
    }

    /*
     * A category reads as its group and its own name together - "IT Equipment ›
     * Laptop" - which is the same label the register's filter offers. A slice
     * labelled "Laptop" alone is ambiguous the moment a second group has one.
     */
    const categoryLabels = new Map(
      categories.map((row) => [
        row.id,
        row.parent ? `${row.parent.name} › ${row.name}` : row.name,
      ]),
    );
    const departmentLabels = new Map(departments.map((row) => [row.id, row.name]));

    const clearance: AssetClearanceRow[] = clearanceRows.map((employee) => {
      const pending = employee.assetAssignments.filter((row) => row.status === 'ACTIVE').length;
      const returned = employee.assetAssignments.filter((row) => row.status === 'RETURNED').length;

      return {
        employeeId: employee.id,
        employeeNumber: employee.employeeNumber,
        fullName: personName(employee),
        departmentName: employee.department?.name ?? null,
        employmentStatus: employee.status,
        pending,
        returned,
        // The shared function, never a ternary here: the API and the browser
        // must not be able to disagree about what "partially cleared" means.
        state: assetClearanceState({ returned, pending }),
      };
    });

    const alerts: AssetAlerts = {
      warrantyExpiring: warrantyCount,
      /*
       * Three of the six are read straight off the status counts above rather
       * than counted again. They ARE the status counts - an asset under repair
       * is an asset whose status is UNDER_REPAIR - and a second query would be
       * a second chance to disagree with the tiles.
       */
      underRepair: statuses.UNDER_REPAIR,
      lost: statuses.LOST,
      damaged: statuses.DAMAGED,
      notReturned: notReturnedCount,
      employeesPendingClearance: clearanceCount,
      warrantyExpiringRows: warrantyRows.map((row) => toAlertRow(row, today, 'warranty')),
      notReturnedRows: notReturnedRows.map((row) => toAlertRow(row, today, 'holding')),
      pendingClearanceRows: clearance,
    };

    const data: AssetDashboard = {
      total,
      byStatus: statuses,
      totalPurchaseValue,
      totalCurrentValue,
      byCategory: toSlices(
        byCategory.map((row) => ({
          key: row.categoryId,
          count: row._count._all,
          purchaseValue: sum(row._sum?.purchasePrice),
          currentValue: sum(row._sum?.currentValue),
        })),
        categoryLabels,
        'Uncategorised',
      ),
      byDepartment: toSlices(
        byDepartment.map((row) => ({
          key: row.departmentId,
          count: row._count._all,
          purchaseValue: sum(row._sum?.purchasePrice),
          currentValue: sum(row._sum?.currentValue),
        })),
        departmentLabels,
        'No department',
      ),
      alerts,
      warrantyDays,
      asOf: today,
    };

    return reply.send({ data });
  });
};
