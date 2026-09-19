import type { Prisma } from '@prisma/client';
import {
  ASSET_REPORT_COLUMNS,
  EMPLOYEE_ASSET_REGISTER_COLUMNS,
  type AssetAcknowledgementStatus,
  type AssetAssignmentStatus,
  type AssetCondition,
  type AssetReportQuery,
  type AssetReportRow,
  type AssetReportTotals,
  type AssetStatus,
  type EmployeeAssetRegisterRow,
  type ReportColumn,
} from '@hrms/shared';
import { assetFilterClauses } from './assets.service.js';

/**
 * The two asset reports, in the one place that knows how they are built.
 *
 * A service rather than four route bodies because each report is served twice -
 * as JSON for the screen and as CSV for the spreadsheet - and those two must be
 * the SAME report. Not two queries written the same way: the same `where`, the
 * same mapper, the same totals. An export that interprets a filter differently
 * from the screen it was exported from is discovered by somebody in a meeting
 * holding a printout, which is the worst possible place to discover it.
 *
 * THE TWO REPORTS HAVE DIFFERENT GRAINS and the shared DTO explains why at
 * length: the asset report is one row per ASSET, the employee register is one
 * row per HANDOVER. That difference is why there are two `where` builders
 * below rather than one with a flag - they narrow different tables.
 */

/**
 * Where a report's DEPARTMENT and TEAM filters point, which is not where the
 * register's do.
 *
 * On the list screen, "department" is a fact about the ASSET - the department a
 * laptop is booked to, which it keeps while it sits in a cupboard. In a report
 * it is a fact about the HOLDER, and `teamId` sitting beside it is the proof:
 * an asset has no team, so the pair can only mean the person. That is also the
 * column the report prints, so filter and column agree - a Department column
 * that did not correspond to the Department filter would be the quietest kind
 * of wrong a report can be.
 *
 * The consequence is worth stating plainly: narrowing a report by department
 * excludes assets nobody is holding, because unheld stock has no holder and so
 * no department. That is the right answer to "what is Development holding".
 */
function holderClause(query: AssetReportQuery): Prisma.AssetWhereInput {
  const employee: Prisma.EmployeeWhereInput = {};
  if (query.departmentId) employee.departmentId = query.departmentId;
  if (query.teamId) employee.teamId = query.teamId;

  const assignment: Prisma.AssetAssignmentWhereInput = { status: 'ACTIVE' };
  if (Object.keys(employee).length > 0) assignment.employee = employee;

  if (query.assignedFrom || query.assignedTo) {
    assignment.assignedAt = {
      ...(query.assignedFrom ? { gte: dayStart(query.assignedFrom) } : {}),
      ...(query.assignedTo ? { lt: dayAfter(query.assignedTo) } : {}),
    };
  }

  // `status` is always there; anything beyond it is a filter somebody asked
  // for. With nothing asked for this contributes no clause at all, rather than
  // a `some` on ACTIVE that would quietly drop every unheld asset from a report
  // nobody had narrowed.
  return Object.keys(assignment).length > 1 ? { assignments: { some: assignment } } : {};
}

/**
 * The asset report's WHERE.
 *
 * Every shared filter comes from `assetFilterClauses` - the SAME function the
 * list screen calls - with `departmentId` deliberately withheld and re-applied
 * through `holderClause` for the reason above. Everything the two have in
 * common has exactly one implementation, which is the whole point of the
 * filtering section in `assets.service.ts`.
 *
 * The holder clauses are gathered into ONE `some` rather than several, so
 * department, team and handover date all have to be true of the same handover.
 * With `status: 'ACTIVE'` there is only ever one of those per asset, so the
 * distinction cannot bite today - but writing them separately would be a trap
 * for whoever widens this to past handovers later.
 */
export function assetReportWhere(
  companyId: string,
  scope: Prisma.AssetWhereInput,
  query: AssetReportQuery,
  today: string,
): Prisma.AssetWhereInput {
  return {
    AND: [
      { companyId },
      scope,
      ...assetFilterClauses({ ...query, departmentId: undefined }, today),
      holderClause(query),
    ],
  };
}

/**
 * The employee register's WHERE, on the ASSIGNMENT table.
 *
 * `scope` decides which handovers exist for this report at all: CURRENT is what
 * people are holding now, ALL is every handover ever recorded. The DTO makes
 * the case for both - the first is the audit question, the second is the
 * history somebody needs when an asset has been round three desks.
 *
 * The asset-shaped filters are nested under `asset`, and they are the same
 * clauses the register builds, so "category = Laptop" cannot mean one thing on
 * the list screen and another here.
 */
export function employeeRegisterWhere(
  companyId: string,
  scope: Prisma.AssetWhereInput,
  query: AssetReportQuery,
  today: string,
): Prisma.AssetAssignmentWhereInput {
  const asset: Prisma.AssetWhereInput = {
    AND: [scope, ...assetFilterClauses({ ...query, departmentId: undefined, employeeId: undefined }, today)],
  };

  const where: Prisma.AssetAssignmentWhereInput = { companyId, asset };

  if (query.scope === 'CURRENT') where.status = 'ACTIVE';
  if (query.employeeId) where.employeeId = query.employeeId;

  const employee: Prisma.EmployeeWhereInput = {};
  if (query.departmentId) employee.departmentId = query.departmentId;
  if (query.teamId) employee.teamId = query.teamId;
  if (Object.keys(employee).length > 0) where.employee = employee;

  if (query.assignedFrom || query.assignedTo) {
    where.assignedAt = {
      ...(query.assignedFrom ? { gte: dayStart(query.assignedFrom) } : {}),
      ...(query.assignedTo ? { lt: dayAfter(query.assignedTo) } : {}),
    };
  }

  return where;
}

/** Midnight UTC on a `yyyy-MM-dd` day. */
function dayStart(day: string): Date {
  return new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
}

/** Midnight UTC on the day AFTER, so a `lt` bound includes the whole day. */
function dayAfter(day: string): Date {
  const date = dayStart(day);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

// ------------------------------------------------------------------ mappers

/** What the asset report reads off a row, and nothing else. */
export const ASSET_REPORT_SELECT = {
  id: true,
  assetTag: true,
  name: true,
  brand: true,
  model: true,
  serialNumber: true,
  purchaseDate: true,
  purchasePrice: true,
  currentValue: true,
  warrantyEnd: true,
  condition: true,
  status: true,
  category: { select: { name: true } },
  site: { select: { name: true } },
  assignments: {
    where: { status: 'ACTIVE' as const },
    orderBy: { assignedAt: 'desc' as const },
    take: 1,
    select: {
      assignedAt: true,
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.AssetSelect;

type ReportAsset = Prisma.AssetGetPayload<{ select: typeof ASSET_REPORT_SELECT }>;

function money(value: Prisma.Decimal | number | null): number | null {
  return value === null ? null : Number(value);
}

function day(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function personName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/**
 * One asset, with whoever is holding it.
 *
 * The holder is the ACTIVE assignment or nothing - never the last person who
 * had it. An asset that came back last month belongs to the company, and
 * printing the previous holder's name against it in a column headed "Employee"
 * is how somebody gets asked to return a laptop they handed in.
 */
export function toAssetReportRow(row: ReportAsset): AssetReportRow {
  const active = row.assignments[0];

  return {
    assetId: row.id,
    assetTag: row.assetTag,
    assetName: row.name,
    categoryName: row.category?.name ?? null,
    brand: row.brand,
    model: row.model,
    serialNumber: row.serialNumber,
    purchaseDate: day(row.purchaseDate),
    purchasePrice: money(row.purchasePrice),
    currentValue: money(row.currentValue),
    warrantyEnd: day(row.warrantyEnd),
    locationName: row.site?.name ?? null,
    condition: row.condition as AssetCondition,
    status: row.status as AssetStatus,
    employeeId: active?.employee.id ?? null,
    employeeName: active ? personName(active.employee) : null,
    employeeNumber: active?.employee.employeeNumber ?? null,
    departmentName: active?.employee.department?.name ?? null,
    assignedAt: active?.assignedAt.toISOString() ?? null,
  };
}

/** What the employee register reads off a handover. */
export const EMPLOYEE_REGISTER_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      department: { select: { name: true } },
      team: { select: { name: true } },
    },
  },
  asset: {
    select: {
      id: true,
      assetTag: true,
      name: true,
      serialNumber: true,
      status: true,
      purchasePrice: true,
      currentValue: true,
      category: { select: { name: true } },
    },
  },
} satisfies Prisma.AssetAssignmentInclude;

type RegisterRow = Prisma.AssetAssignmentGetPayload<{ include: typeof EMPLOYEE_REGISTER_INCLUDE }>;

/**
 * One handover.
 *
 * `condition` is what it went out in until it comes back, and what it came back
 * in once it has. One column rather than two because the register is read as a
 * sheet: the question at an audit is "what state is this in", and the answer
 * changes meaning with the row's own status rather than needing a second
 * column that is empty on every active row.
 */
export function toEmployeeRegisterRow(row: RegisterRow): EmployeeAssetRegisterRow {
  return {
    assignmentId: row.id,
    assetId: row.asset.id,
    employeeId: row.employee.id,
    employeeName: personName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    departmentName: row.employee.department?.name ?? null,
    teamName: row.employee.team?.name ?? null,
    assetTag: row.asset.assetTag,
    assetName: row.asset.name,
    categoryName: row.asset.category?.name ?? null,
    serialNumber: row.asset.serialNumber,
    assignedAt: row.assignedAt.toISOString(),
    returnedAt: row.returnedAt?.toISOString() ?? null,
    condition: ((row.returnedAt ? row.conditionAtReturn : row.conditionAtAssignment) ??
      null) as AssetCondition | null,
    assignmentStatus: row.status as AssetAssignmentStatus,
    assetStatus: row.asset.status as AssetStatus,
    acknowledgementStatus: row.acknowledgementStatus as AssetAcknowledgementStatus,
    currentValue: money(row.asset.currentValue),
  };
}

// ------------------------------------------------------------------- totals

/**
 * What a report totals to, over EVERY row the filters match.
 *
 * Not over the page on screen. A footer that totalled the visible twenty would
 * change when somebody pressed next, which is the most quietly wrong thing a
 * report can do - the number looks like an answer and is a description of the
 * scroll position.
 */
export function emptyTotals(): AssetReportTotals {
  return { rows: 0, purchaseValue: 0, currentValue: 0 };
}

export function addToTotals(
  totals: AssetReportTotals,
  purchasePrice: Prisma.Decimal | number | null,
  currentValue: Prisma.Decimal | number | null,
): AssetReportTotals {
  totals.rows += 1;
  totals.purchaseValue += purchasePrice === null ? 0 : Number(purchasePrice);
  totals.currentValue += currentValue === null ? 0 : Number(currentValue);
  return totals;
}

// ------------------------------------------------------------------ columns

/**
 * The columns an export carries, resolved against the report's own catalogue.
 *
 * An unknown key is DROPPED rather than refused: the parameter comes from a
 * browser that may be a release behind, and answering a stale column list with
 * a validation error would break an export somebody is halfway through instead
 * of giving them the seventeen columns that still exist. An empty or absent
 * parameter means all of them, in the catalogue's order - the order the DTO
 * chose on purpose.
 */
export function resolveColumns(
  catalogue: readonly ReportColumn[],
  requested: string | undefined,
): ReportColumn[] {
  if (!requested) return [...catalogue];

  const wanted = new Set(
    requested
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return [...catalogue];

  const chosen = catalogue.filter((column) => wanted.has(column.key));
  return chosen.length > 0 ? chosen : [...catalogue];
}

export { ASSET_REPORT_COLUMNS, EMPLOYEE_ASSET_REGISTER_COLUMNS };
