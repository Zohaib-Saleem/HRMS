import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  ASSET_REPORT_COLUMNS,
  ASSET_STATUS_LABELS,
  ASSET_CONDITION_LABELS,
  ASSET_ACKNOWLEDGEMENT_STATUS_LABELS,
  EMPLOYEE_ASSET_REGISTER_COLUMNS,
  PERMISSIONS,
  assetReportQuerySchema,
  type AssetReportQuery,
  type AssetReportRow,
  type AssetReportTotals,
  type EmployeeAssetRegisterRow,
  type ReportColumn,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assetScopeFilter, assetToday, resolveAssetActor } from './assets.service.js';
import {
  ASSET_REPORT_SELECT,
  EMPLOYEE_REGISTER_INCLUDE,
  addToTotals,
  assetReportWhere,
  emptyTotals,
  employeeRegisterWhere,
  resolveColumns,
  toAssetReportRow,
  toEmployeeRegisterRow,
} from './asset-reports.service.js';

/**
 * The two asset reports, each served twice.
 *
 * TWO GRAINS, TWO REPORTS, and the shared DTO argues the case at length: the
 * asset report is one row per ASSET - eighty laptops are eighty rows, and it
 * answers "what do we own and what is it worth". The employee register is one
 * row per HANDOVER - a person holding a laptop, a monitor and an access card is
 * three rows - and it answers "what is this person holding", which is the
 * question asked at an audit, a transfer, a resignation and a termination.
 *
 * Each is served as JSON for the screen and as CSV for the spreadsheet, and the
 * pair share a `where`, a mapper and a totals function from the service. Not
 * two implementations written the same way: the same ones. An export that
 * disagreed with the screen it was taken from would be discovered by somebody
 * in a meeting holding a printout.
 *
 * TWO GATES, and both are needed. `asset.read` says this caller may read asset
 * records at all and carries the data-scope narrowing with it; `asset.report`
 * says they may take the register away as a file. The scope filter is applied
 * below exactly as it is on the list screen, so a report can never be a way to
 * read rows the list would have withheld - a reporting grant is permission to
 * EXPORT what you can see, not permission to see more.
 */

/**
 * The most rows one export will write, and it REFUSES rather than truncates.
 *
 * A silently shortened export is the failure the DTO names: a spreadsheet with
 * the wrong rows in it, emailed to somebody who has no way of telling. Refusing
 * with a message that says to narrow the filters is louder and cheaper, and at
 * twenty thousand rows the person asking almost certainly meant to filter.
 */
const EXPORT_ROW_LIMIT = 20_000;

/** RFC 4180 escaping - quotes doubled, field wrapped when it contains a delimiter. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendCsv<Row>(
  reply: FastifyReply,
  filename: string,
  columns: readonly ReportColumn[],
  rows: readonly Row[],
  cell: (row: Row, key: string) => unknown,
): FastifyReply {
  const lines = [
    columns.map((column) => csvCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(cell(row, column.key))).join(',')),
  ];

  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    // BOM so Excel opens UTF-8 names correctly, matching the other exports.
    .send(`﻿${lines.join('\r\n')}\r\n`);
}

/**
 * A timestamp as the day it happened.
 *
 * Handovers are stored as instants and read as dates: "assigned 19 Sep" is what
 * the sheet wants, and the hour it was typed in is noise in a column somebody
 * sorts by.
 */
function day(value: string | null): string | null {
  return value === null ? null : value.slice(0, 10);
}

/** One cell of the asset report, by column key. */
function assetCell(row: AssetReportRow, key: string): unknown {
  switch (key) {
    case 'employeeName': return row.employeeName;
    case 'employeeNumber': return row.employeeNumber;
    case 'departmentName': return row.departmentName;
    case 'assetTag': return row.assetTag;
    case 'assetName': return row.assetName;
    case 'categoryName': return row.categoryName;
    case 'brand': return row.brand;
    case 'model': return row.model;
    case 'serialNumber': return row.serialNumber;
    case 'purchaseDate': return row.purchaseDate;
    case 'purchasePrice': return row.purchasePrice;
    case 'currentValue': return row.currentValue;
    case 'assignedAt': return day(row.assignedAt);
    // The LABELS rather than the enum values: a spreadsheet is read by a
    // person, and `UNDER_REPAIR` in a column headed Status is the database
    // leaking into a document somebody hands to a finance team.
    case 'condition': return ASSET_CONDITION_LABELS[row.condition];
    case 'status': return ASSET_STATUS_LABELS[row.status];
    case 'warrantyEnd': return row.warrantyEnd;
    case 'locationName': return row.locationName;
    default: return null;
  }
}

/** One cell of the employee register, by column key. */
function registerCell(row: EmployeeAssetRegisterRow, key: string): unknown {
  switch (key) {
    case 'employeeName': return row.employeeName;
    case 'employeeNumber': return row.employeeNumber;
    case 'departmentName': return row.departmentName;
    case 'teamName': return row.teamName;
    case 'assetName': return row.assetName;
    case 'assetTag': return row.assetTag;
    case 'categoryName': return row.categoryName;
    case 'serialNumber': return row.serialNumber;
    case 'assignedAt': return day(row.assignedAt);
    case 'returnedAt': return day(row.returnedAt);
    case 'condition': return row.condition === null ? null : ASSET_CONDITION_LABELS[row.condition];
    case 'status': return ASSET_STATUS_LABELS[row.assetStatus];
    case 'acknowledgement': return ASSET_ACKNOWLEDGEMENT_STATUS_LABELS[row.acknowledgementStatus];
    case 'currentValue': return row.currentValue;
    default: return null;
  }
}

/** An export leaves the building, so it is recorded like one. */
async function auditExport(
  auth: ReturnType<typeof requireAuthContext>,
  report: 'assets' | 'employees',
  rows: number,
  columns: number,
  request: Parameters<typeof recordAudit>[0]['request'],
): Promise<void> {
  await recordAudit({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: 'asset.report.export',
    entityType: 'AssetReport',
    entityId: report,
    summary: `Exported the ${report === 'assets' ? 'asset report' : 'employee asset register'} - ${rows} rows, ${columns} columns`,
    request,
  });
}

export const assetReportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_READ));
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_REPORT));

  /**
   * Everything a report needs before it can run: who the caller is, what they
   * may see, the company's today, and the parsed query. One function so the
   * JSON route and the CSV route beside it cannot drift apart on any of them.
   */
  const prepare = async (request: Parameters<typeof requireAuthContext>[0]) => {
    const auth = requireAuthContext(request);
    const actor = resolveAssetActor(auth);
    const query = parseOrThrow(assetReportQuerySchema, request.query) as AssetReportQuery;
    const scope = await assetScopeFilter(actor);
    const today = await assetToday(auth.companyId);
    return { auth, query, scope, today };
  };

  // --------------------------------------------------------- asset report

  app.get('/reports/assets', async (request, reply) => {
    const { auth, query, scope, today } = await prepare(request);
    if (scope === null) {
      return reply.send({
        data: [],
        meta: buildMeta(query.page, query.limit, 0),
        totals: emptyTotals(),
        asOf: today,
      });
    }

    const where = assetReportWhere(auth.companyId, scope, query, today);
    const { skip, take } = toSkipTake(query.page, query.limit);

    /*
     * The page and the totals come from the SAME `where` object - not two
     * objects built the same way, the same one - so the footer describes the
     * rows the filters matched rather than the twenty on screen.
     */
    const [rows, aggregate] = await Promise.all([
      prisma.asset.findMany({
        where,
        skip,
        take,
        select: ASSET_REPORT_SELECT,
        orderBy: buildOrderBy(
          query.sort,
          query.order,
          ['assetTag', 'name', 'status', 'condition', 'purchaseDate', 'purchasePrice', 'currentValue', 'createdAt'] as const,
          'assetTag',
        ),
      }),
      prisma.asset.aggregate({
        where,
        _count: { _all: true },
        _sum: { purchasePrice: true, currentValue: true },
      }),
    ]);

    const totals: AssetReportTotals = {
      rows: aggregate._count._all,
      purchaseValue: Number(aggregate._sum?.purchasePrice ?? 0),
      currentValue: Number(aggregate._sum?.currentValue ?? 0),
    };

    return reply.send({
      data: rows.map(toAssetReportRow),
      meta: buildMeta(query.page, query.limit, totals.rows),
      totals,
      asOf: today,
    });
  });

  app.get('/reports/assets.csv', async (request, reply) => {
    const { auth, query, scope, today } = await prepare(request);
    const columns = resolveColumns(ASSET_REPORT_COLUMNS, query.columns);

    if (scope === null) {
      await auditExport(auth, 'assets', 0, columns.length, request);
      return sendCsv<AssetReportRow>(reply, `asset-report-${today}.csv`, columns, [], assetCell);
    }

    const where = assetReportWhere(auth.companyId, scope, query, today);

    const total = await prisma.asset.count({ where });
    if (total > EXPORT_ROW_LIMIT) {
      const message = `That export would be ${total.toLocaleString()} rows, and the limit is ${EXPORT_ROW_LIMIT.toLocaleString()}. Narrow it by category, department or purchase date and try again.`;
      throw new ValidationError({ filters: [message] }, message);
    }

    const rows = await prisma.asset.findMany({
      where,
      select: ASSET_REPORT_SELECT,
      orderBy: buildOrderBy(
        query.sort,
        query.order,
        ['assetTag', 'name', 'status', 'condition', 'purchaseDate', 'purchasePrice', 'currentValue', 'createdAt'] as const,
        'assetTag',
      ),
    });

    await auditExport(auth, 'assets', rows.length, columns.length, request);

    return sendCsv(reply, `asset-report-${today}.csv`, columns, rows.map(toAssetReportRow), assetCell);
  });

  // ---------------------------------------------------- employee register

  app.get('/reports/employees', async (request, reply) => {
    const { auth, query, scope, today } = await prepare(request);
    if (scope === null) {
      return reply.send({
        data: [],
        meta: buildMeta(query.page, query.limit, 0),
        totals: emptyTotals(),
        asOf: today,
      });
    }

    const where = employeeRegisterWhere(auth.companyId, scope, query, today);
    const { skip, take } = toSkipTake(query.page, query.limit);

    /*
     * The totals need the money off the ASSET behind each handover, and Prisma
     * cannot sum across a relation - so they are read as two columns per
     * matching row rather than as an aggregate. That is a real query and it is
     * the honest one: summing the page would produce a footer that changed when
     * somebody paged, and an aggregate over assets would count a laptop once
     * that this report's grain lists three times.
     *
     * The same cap the export refuses at applies, for the same reason: a total
     * computed over a truncated read is a wrong number wearing a right one's
     * clothes.
     */
    const [rows, count, money] = await Promise.all([
      prisma.assetAssignment.findMany({
        where,
        skip,
        take,
        include: EMPLOYEE_REGISTER_INCLUDE,
        orderBy: [{ assignedAt: query.order }, { id: 'asc' }],
      }),
      prisma.assetAssignment.count({ where }),
      prisma.assetAssignment.findMany({
        where,
        select: { asset: { select: { purchasePrice: true, currentValue: true } } },
        take: EXPORT_ROW_LIMIT,
      }),
    ]);

    const totals = money.reduce(
      (acc, row) => addToTotals(acc, row.asset.purchasePrice, row.asset.currentValue),
      emptyTotals(),
    );
    totals.rows = count;

    return reply.send({
      data: rows.map(toEmployeeRegisterRow),
      meta: buildMeta(query.page, query.limit, count),
      totals,
      asOf: today,
    });
  });

  app.get('/reports/employees.csv', async (request, reply) => {
    const { auth, query, scope, today } = await prepare(request);
    const columns = resolveColumns(EMPLOYEE_ASSET_REGISTER_COLUMNS, query.columns);
    const filename = `employee-asset-register-${query.scope === 'ALL' ? 'all' : 'current'}-${today}.csv`;

    if (scope === null) {
      await auditExport(auth, 'employees', 0, columns.length, request);
      return sendCsv<EmployeeAssetRegisterRow>(reply, filename, columns, [], registerCell);
    }

    const where = employeeRegisterWhere(auth.companyId, scope, query, today);

    const total = await prisma.assetAssignment.count({ where });
    if (total > EXPORT_ROW_LIMIT) {
      const message = `That export would be ${total.toLocaleString()} rows, and the limit is ${EXPORT_ROW_LIMIT.toLocaleString()}. Narrow it by department, category or handover date and try again.`;
      throw new ValidationError({ filters: [message] }, message);
    }

    const rows = await prisma.assetAssignment.findMany({
      where,
      include: EMPLOYEE_REGISTER_INCLUDE,
      orderBy: [{ assignedAt: query.order }, { id: 'asc' }],
    });

    await auditExport(auth, 'employees', rows.length, columns.length, request);

    return sendCsv(reply, filename, columns, rows.map(toEmployeeRegisterRow), registerCell);
  });
};
