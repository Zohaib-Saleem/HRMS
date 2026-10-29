import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  employeeComponentSchema,
  employeeComponentUpdateSchema,
  idParamSchema,
  paginationQuerySchema,
  payrollAdjustmentSchema,
  payrollCancelSchema,
  payrollLineQuerySchema,
  payrollPeriodSchema,
  payrollPreviewQuerySchema,
  payrollRunSchema,
  payslipQuerySchema,
  salaryComponentSchema,
  type EmployeeComponentRecord,
  type PayrollAdjustmentRecord,
  type PayrollCalculationResult,
  type PayrollExceptionRecord,
  type PayrollLineRecord,
  type PayrollMoneyLine,
  type PayrollPeriodRecord,
  type PayrollPreview,
  type PayrollRunRecord,
  type PayslipRecord,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';
import { assertTransition, calculateRun, finalizeRun } from './payroll.service.js';
import { buildPayrollPreview } from './payroll-preview.service.js';
import { notify } from '../../core/notifications/notification.service.js';

/**
 * Salary components, pay periods, runs, adjustments and payslips.
 *
 * The run endpoints are where the immutability rule is actually enforced.
 * `assertTransition` is the single definition of the workflow, and finalization
 * additionally refuses to proceed while a blocking exception stands - because
 * the entire point of detecting one is that a person looks at it before money
 * moves.
 */

const displayName = (e: {
  firstName: string;
  lastName: string;
  displayName: string | null;
}): string => e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const num = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : Number(value);

const nullableNum = (value: Prisma.Decimal | number | null): number | null =>
  value === null ? null : Number(value);

const day = (value: Date | null): string | null => value?.toISOString().slice(0, 10) ?? null;

// ========================================================== component catalogue

export const salaryComponentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.SalaryComponentWhereInput = {
      companyId: auth.companyId,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.salaryComponent.count({ where }),
      prisma.salaryComponent.findMany({
        where,
        skip,
        take,
        include: { _count: { select: { assignments: true } } },
        orderBy: [{ kind: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const data: SalaryComponentRecord[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      kind: row.kind,
      calc: row.calc,
      isTaxable: row.isTaxable,
      isActive: row.isActive,
      displayOrder: row.displayOrder,
      effectiveFrom: day(row.effectiveFrom),
      assignedCount: row._count.assignments,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(salaryComponentSchema, request.body);

    const clash = await prisma.salaryComponent.findFirst({
      where: { companyId: auth.companyId, name: input.name },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A component with that name already exists.');

    const created = await prisma.salaryComponent.create({
      data: {
        companyId: auth.companyId,
        ...input,
        effectiveFrom: input.effectiveFrom ? toDateOnly(input.effectiveFrom) : null,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.component.create',
      entityType: 'SalaryComponent',
      entityId: created.id,
      summary: `Added ${input.kind === 'EARNING' ? 'earning' : 'deduction'} "${input.name}"`,
      after: input as unknown as Record<string, unknown>,
      request,
    });

    return reply.status(201).send({ data: { id: created.id } });
  });

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(salaryComponentSchema, request.body);

      const before = await prisma.salaryComponent.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Salary component');

      await prisma.salaryComponent.update({ where: { id }, data: { ...input, effectiveFrom: input.effectiveFrom ? toDateOnly(input.effectiveFrom) : null } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.component.update',
        entityType: 'SalaryComponent',
        entityId: id,
        summary: `Updated component "${input.name}"`,
        before: { name: before.name, kind: before.kind, calc: before.calc, isActive: before.isActive },
        after: { name: input.name, kind: input.kind, calc: input.calc, isActive: input.isActive },
        request,
      });

      return reply.send({ data: { id } });
    },
  );
};

// ======================================================== employee assignments

export const employeeComponentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payrollLineQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.EmployeeSalaryComponentWhereInput = {
      companyId: auth.companyId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      employee: { AND: [scope] },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeeSalaryComponent.count({ where }),
      prisma.employeeSalaryComponent.findMany({
        where,
        skip,
        take,
        include: {
          component: true,
          employee: { select: { firstName: true, lastName: true, displayName: true } },
        },
        orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }],
      }),
    ]);

    const data: EmployeeComponentRecord[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      componentId: row.componentId,
      componentName: row.component.name,
      componentCode: row.component.code,
      kind: row.component.kind,
      calc: row.component.calc,
      value: num(row.value),
      frequency: row.frequency,
      effectiveFrom: day(row.effectiveFrom)!,
      effectiveTo: day(row.effectiveTo),
      isActive: row.isActive,
      note: row.note,
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(employeeComponentSchema, request.body);
    await assertEmployeeInScope(auth, input.employeeId);

    const component = await prisma.salaryComponent.findFirst({
      where: { id: input.componentId, companyId: auth.companyId },
      select: { id: true, name: true },
    });
    if (!component) throw new NotFoundError('Salary component');

    const from = toDateOnly(input.effectiveFrom);
    // A one-time entry is closed on the day it starts, so a bonus cannot repeat
    // every month because somebody forgot to end it.
    const to =
      input.frequency === 'ONE_TIME'
        ? from
        : input.effectiveTo
          ? toDateOnly(input.effectiveTo)
          : null;

    if (to && to < from) {
      throw new ValidationError({ effectiveTo: ['This cannot end before it starts.'] });
    }

    const created = await prisma.employeeSalaryComponent.create({
      data: {
        companyId: auth.companyId,
        employeeId: input.employeeId,
        componentId: input.componentId,
        value: input.value,
        frequency: input.frequency,
        effectiveFrom: from,
        effectiveTo: to,
        isActive: input.isActive,
        note: input.note ?? null,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.allowance.create',
      entityType: 'EmployeeSalaryComponent',
      entityId: created.id,
      summary: `Assigned "${component.name}" from ${input.effectiveFrom}`,
      after: {
        employeeId: input.employeeId,
        component: component.name,
        value: input.value,
        frequency: input.frequency,
      },
      request,
    });

    return reply.status(201).send({ data: { id: created.id } });
  });

  /**
   * Edits one per-employee component. The common case is enabling or
   * disabling it; a value or date change is the same call with more fields.
   * Everything is scoped and audited exactly as creation is.
   */
  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(employeeComponentUpdateSchema, request.body);

      const before = await prisma.employeeSalaryComponent.findFirst({
        where: { id, companyId: auth.companyId },
        include: { component: { select: { name: true } } },
      });
      if (!before) throw new NotFoundError('Assignment');
      await assertEmployeeInScope(auth, before.employeeId);

      const from = input.effectiveFrom ? toDateOnly(input.effectiveFrom) : before.effectiveFrom;
      const to =
        input.effectiveTo === undefined
          ? before.effectiveTo
          : input.effectiveTo
            ? toDateOnly(input.effectiveTo)
            : null;
      if (to && to < from) {
        throw new ValidationError({ effectiveTo: ['This cannot end before it starts.'] });
      }

      const after = await prisma.employeeSalaryComponent.update({
        where: { id },
        data: {
          ...(input.value !== undefined ? { value: input.value } : {}),
          effectiveFrom: from,
          effectiveTo: to,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      });

      const changes = diff(
        { value: num(before.value), isActive: before.isActive, effectiveFrom: day(before.effectiveFrom), effectiveTo: day(before.effectiveTo), note: before.note },
        { value: num(after.value), isActive: after.isActive, effectiveFrom: day(after.effectiveFrom), effectiveTo: day(after.effectiveTo), note: after.note },
      );

      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'payroll.allowance.update',
          entityType: 'EmployeeSalaryComponent',
          entityId: id,
          summary: `${after.isActive === before.isActive ? 'Changed' : after.isActive ? 'Enabled' : 'Disabled'} "${before.component.name}" (${changes.changed.join(', ')})`,
          before: { employeeId: before.employeeId, ...changes.before },
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: { id } });
    },
  );

  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const row = await prisma.employeeSalaryComponent.findFirst({
        where: { id, companyId: auth.companyId },
        include: { component: { select: { name: true } } },
      });
      if (!row) throw new NotFoundError('Assignment');
      await assertEmployeeInScope(auth, row.employeeId);

      await prisma.employeeSalaryComponent.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.allowance.delete',
        entityType: 'EmployeeSalaryComponent',
        entityId: id,
        summary: `Removed "${row.component.name}"`,
        before: { employeeId: row.employeeId, value: num(row.value) },
        request,
      });

      return reply.status(204).send();
    },
  );
};

// ==================================================================== periods

export const payrollPeriodRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.PayrollPeriodWhereInput = { companyId: auth.companyId };
    const { skip, take } = toSkipTake(query.page, query.limit);

    const [total, rows] = await Promise.all([
      prisma.payrollPeriod.count({ where }),
      prisma.payrollPeriod.findMany({
        where,
        skip,
        take,
        include: { _count: { select: { runs: true } } },
        orderBy: { startDate: 'desc' },
      }),
    ]);

    const data: PayrollPeriodRecord[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      startDate: day(row.startDate)!,
      endDate: day(row.endDate)!,
      payDate: day(row.payDate),
      status: row.status,
      runCount: row._count.runs,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(payrollPeriodSchema, request.body);

    const start = toDateOnly(input.startDate);
    const end = toDateOnly(input.endDate);

    const clash = await prisma.payrollPeriod.findFirst({
      where: { companyId: auth.companyId, startDate: start, endDate: end },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A period with those dates already exists.');

    // Overlapping periods would pay the shared days twice - the risk when a
    // company moves from calendar months to a cycle ending on the 28th.
    const overlap = await prisma.payrollPeriod.findFirst({
      where: { companyId: auth.companyId, startDate: { lte: end }, endDate: { gte: start } },
      select: { name: true, startDate: true, endDate: true },
    });
    if (overlap) {
      throw new ConflictError(
        `These dates overlap "${overlap.name}" (${day(overlap.startDate)} to ${day(overlap.endDate)}). Change one of the two so no day is paid twice.`,
      );
    }

    const created = await prisma.payrollPeriod.create({
      data: {
        companyId: auth.companyId,
        name: input.name,
        startDate: start,
        endDate: end,
        payDate: input.payDate ? toDateOnly(input.payDate) : null,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.period.create',
      entityType: 'PayrollPeriod',
      entityId: created.id,
      summary: `Created pay period "${input.name}" (${input.startDate} to ${input.endDate})`,
      after: input as unknown as Record<string, unknown>,
      request,
    });

    return reply.status(201).send({ data: { id: created.id } });
  });
};

// ======================================================================== runs

function toRunRecord(row: {
  id: string;
  periodId: string;
  status: string;
  currency: string;
  notes: string | null;
  employeeCount: number;
  grossTotal: Prisma.Decimal;
  deductionTotal: Prisma.Decimal;
  netTotal: Prisma.Decimal;
  exceptionCount: number;
  blockingCount: number;
  calculatedAt: Date | null;
  approvedAt: Date | null;
  finalizedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  period: { name: string; startDate: Date; endDate: Date };
}): PayrollRunRecord {
  return {
    id: row.id,
    periodId: row.periodId,
    periodName: row.period.name,
    periodStart: day(row.period.startDate)!,
    periodEnd: day(row.period.endDate)!,
    status: row.status as PayrollRunRecord['status'],
    currency: row.currency,
    notes: row.notes,
    employeeCount: row.employeeCount,
    grossTotal: num(row.grossTotal),
    deductionTotal: num(row.deductionTotal),
    netTotal: num(row.netTotal),
    exceptionCount: row.exceptionCount,
    blockingCount: row.blockingCount,
    calculatedAt: row.calculatedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The preview breakdown, in the order the specification lists it.
 *
 * ONE list, read by the screen and by the CSV. The export cannot drift from
 * the table because there is no second definition of what a column is or where
 * its value comes from - `pick` is the only accessor either of them uses.
 *
 * Every deduction the calculation can produce has a column here, and they sum
 * to `deductionsTotal`. A breakdown where the parts do not add up to the whole
 * is worse than no breakdown, because it invites the reader to believe both.
 */
export const PREVIEW_COLUMNS: Array<[key: string, label: string, pick: (row: PayrollPreview['rows'][number]) => unknown]> = [
  ['employeeNumber', 'Employee code', (r) => r.employeeNumber],
  ['employeeName', 'Employee', (r) => r.employeeName],
  ['departmentName', 'Department', (r) => r.departmentName],
  ['basicSalary', 'Salary', (r) => r.basicSalary],
  ['calendarDays', 'Calendar days', (r) => r.calendarDays],
  ['scheduledDays', 'Scheduled working days', (r) => r.scheduledDays],
  ['paidDays', 'Paid days', (r) => r.paidDays],
  ['unpaidDays', 'Unpaid days', (r) => r.unpaidDays],
  ['paidLeaveDays', 'Paid leave', (r) => r.paidLeaveDays],
  ['unpaidLeaveDays', 'Unpaid leave (LWP)', (r) => r.unpaidLeaveDays],
  ['absentDays', 'Full-day absences', (r) => r.absentDays],
  ['halfDays', 'Half days', (r) => r.halfDays],
  ['allowances', 'Allowances', (r) => r.allowances],
  ['overtimeHours', 'Overtime hours', (r) => r.overtimeHours],
  ['overtimeAmount', 'Overtime amount', (r) => r.overtimeAmount],
  ['absenceDeduction', 'Absence deduction', (r) => r.absenceDeduction],
  ['shortHoursDeduction', 'Working-hour deduction', (r) => r.shortHoursDeduction],
  ['lateDeduction', 'Late deduction', (r) => r.lateDeduction],
  ['earlyLeaveDeduction', 'Early-leave deduction', (r) => r.earlyLeaveDeduction],
  ['loanDeduction', 'Loan deduction', (r) => r.loanDeduction],
  ['advanceDeduction', 'Salary Advance Repayment', (r) => r.advanceDeduction],
  ['otherDeductions', 'Other deductions', (r) => r.otherDeductions],
  ['deductionsTotal', 'Deductions', (r) => r.deductionsTotal],
  ['grossAmount', 'Gross', (r) => r.grossAmount],
  ['netAmount', 'Net salary', (r) => r.netAmount],
  ['notes', 'Notes', (r) => r.notes.join(' | ')],
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sendPreviewCsv(reply: FastifyReply, preview: PayrollPreview): FastifyReply {
  const lines = [
    PREVIEW_COLUMNS.map(([, label]) => label).join(','),
    ...preview.rows.map((row) => PREVIEW_COLUMNS.map(([, , pick]) => csvCell(pick(row))).join(',')),
  ];
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header(
      'Content-Disposition',
      `attachment; filename="payroll-preview-${preview.from}-to-${preview.to}.csv"`,
    )
    // BOM so Excel opens UTF-8 names correctly, matching the other exports.
    .send(`\ufeff${lines.join('\r\n')}\r\n`);
}

export const payrollRunRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const where: Prisma.PayrollRunWhereInput = { companyId: auth.companyId };
    const { skip, take } = toSkipTake(query.page, query.limit);

    const [total, rows] = await Promise.all([
      prisma.payrollRun.count({ where }),
      prisma.payrollRun.findMany({
        where,
        skip,
        take,
        include: { period: { select: { name: true, startDate: true, endDate: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return reply.send({
      data: rows.map(toRunRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * The calculation preview.
   *
   * Registered before `/:id` so "preview" is never read as a run id. It runs
   * the same calculation a run runs and writes none of it - the screen HR
   * opens to check the arithmetic before finalizing, and the one that can be
   * opened for a period that has no run at all.
   */
  app.get('/preview', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payrollPreviewQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) throw new ForbiddenError('You do not have access to payroll data.');
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const preview = await buildPayrollPreview({
      companyId: auth.companyId,
      runId: query.runId,
      periodId: query.periodId,
      from: query.from,
      to: query.to,
      employeeId: query.employeeId,
      departmentId: query.departmentId,
      scopeFilter,
    });

    if (query.format === 'csv') {
      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.preview.export',
        entityType: 'PayrollRun',
        entityId: preview.runId ?? preview.periodId ?? `${preview.from}..${preview.to}`,
        summary: `Exported the payroll preview for ${preview.from} to ${preview.to} (${preview.rows.length} employee(s))`,
        request,
      });
      return sendPreviewCsv(reply, preview);
    }

    return reply.send({ data: preview });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.payrollRun.findFirst({
      where: { id, companyId: auth.companyId },
      include: { period: { select: { name: true, startDate: true, endDate: true } } },
    });
    if (!row) throw new NotFoundError('Payroll run');

    return reply.send({ data: toRunRecord(row) });
  });

  /** The lines of a run, narrowed to whoever the caller may see. */
  app.get('/:id/lines', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const query = parseOrThrow(payrollLineQuerySchema, request.query);

    const run = await prisma.payrollRun.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true },
    });
    if (!run) throw new NotFoundError('Payroll run');

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.PayrollLineWhereInput = {
      runId: id,
      companyId: auth.companyId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      employee: { AND: [scope] },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.payrollLine.count({ where }),
      prisma.payrollLine.findMany({
        where,
        skip,
        take,
        include: {
          earnings: true,
          deductions: true,
          employee: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              employeeNumber: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: { employee: { employeeNumber: 'asc' } },
      }),
    ]);

    return reply.send({
      data: rows.map(toLineRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id/exceptions', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const run = await prisma.payrollRun.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true },
    });
    if (!run) throw new NotFoundError('Payroll run');

    const scope = await employeeScopeFilter(auth);
    if (scope === null) return reply.send({ data: [] });

    const rows = await prisma.payrollException.findMany({
      where: { runId: id, companyId: auth.companyId },
      orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
    });

    // An exception names an employee, so it is narrowed the same way a line is.
    const visible = await prisma.employee.findMany({
      where: { AND: [{ companyId: auth.companyId }, scope] },
      select: { id: true, firstName: true, lastName: true, displayName: true },
    });
    const byId = new Map(visible.map((e) => [e.id, e]));

    const data: PayrollExceptionRecord[] = rows
      .filter((row) => row.employeeId === null || byId.has(row.employeeId))
      .map((row) => ({
        id: row.id,
        code: row.code,
        severity: row.severity,
        message: row.message,
        employeeId: row.employeeId,
        employeeName: row.employeeId ? (displayName(byId.get(row.employeeId)!) ?? null) : null,
        createdAt: row.createdAt.toISOString(),
      }));

    return reply.send({ data });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(payrollRunSchema, request.body);

    const period = await prisma.payrollPeriod.findFirst({
      where: { id: input.periodId, companyId: auth.companyId },
    });
    if (!period) throw new NotFoundError('Pay period');

    // A period that has been paid is closed. Re-running it would produce a
    // second set of payslips for the same month.
    const finalized = await prisma.payrollRun.findFirst({
      where: { periodId: period.id, status: 'FINALIZED' },
      select: { id: true },
    });
    if (finalized) {
      throw new ConflictError(
        'This period already has a finalized payroll. Corrections have to be made with an adjustment.',
      );
    }

    const open = await prisma.payrollRun.findFirst({
      where: { periodId: period.id, status: { in: ['DRAFT', 'CALCULATING', 'REVIEW', 'APPROVED'] } },
      select: { id: true },
    });
    if (open) throw new ConflictError('This period already has a run in progress.');

    const company = await prisma.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { currency: true },
    });

    const created = await prisma.payrollRun.create({
      data: {
        companyId: auth.companyId,
        periodId: period.id,
        currency: company.currency,
        notes: input.notes ?? null,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.run.create',
      entityType: 'PayrollRun',
      entityId: created.id,
      summary: `Created payroll run for "${period.name}"`,
      after: { periodId: period.id, period: period.name },
      request,
    });

    return reply.status(201).send({ data: { id: created.id, status: created.status } });
  });

  app.post(
    '/:id/calculate',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const outcome = await calculateRun({
        runId: id,
        companyId: auth.companyId,
        actorId: auth.userId,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.calculate',
        entityType: 'PayrollRun',
        entityId: id,
        summary: `Calculated payroll: ${outcome.lines} line(s), ${outcome.exceptions} exception(s)`,
        after: {
          lines: outcome.lines,
          exceptions: outcome.exceptions,
          blocking: outcome.blocking,
          grossTotal: outcome.grossTotal,
          netTotal: outcome.netTotal,
        },
        request,
      });

      if (outcome.blocking === 0) {
        await notifyPayrollApprovers(request, auth.companyId, auth.userId, id);
      }

      const data: PayrollCalculationResult = { ...outcome, status: 'REVIEW' };
      return reply.send({ data });
    },
  );

  /** Sends an approved run back for another look. */
  app.post(
    '/:id/review',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const run = await prisma.payrollRun.findFirst({ where: { id, companyId: auth.companyId } });
      if (!run) throw new NotFoundError('Payroll run');
      assertTransition(run.status, 'REVIEW');

      await prisma.payrollRun.update({
        where: { id },
        data: { status: 'REVIEW', reviewedAt: new Date(), reviewedBy: auth.userId, approvedAt: null, approvedBy: null },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.review',
        entityType: 'PayrollRun',
        entityId: id,
        summary: 'Returned payroll run to review',
        before: { status: run.status },
        after: { status: 'REVIEW' },
        request,
      });

      return reply.send({ data: { id, status: 'REVIEW' } });
    },
  );

  app.post(
    '/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const run = await prisma.payrollRun.findFirst({ where: { id, companyId: auth.companyId } });
      if (!run) throw new NotFoundError('Payroll run');
      assertTransition(run.status, 'APPROVED');

      if (run.blockingCount > 0) {
        throw new ValidationError({
          run: [`This run has ${run.blockingCount} blocking exception(s) to resolve first.`],
        });
      }

      await prisma.payrollRun.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: auth.userId },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.approve',
        entityType: 'PayrollRun',
        entityId: id,
        summary: `Approved payroll run: ${run.employeeCount} employee(s), net ${num(run.netTotal)}`,
        before: { status: run.status },
        after: { status: 'APPROVED' },
        request,
      });

      return reply.send({ data: { id, status: 'APPROVED' } });
    },
  );

  app.post(
    '/:id/finalize',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const result = await finalizeRun({
        runId: id,
        companyId: auth.companyId,
        actorId: auth.userId,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.finalize',
        entityType: 'PayrollRun',
        entityId: id,
        summary: `Finalized payroll run and issued ${result.payslips} payslip(s)`,
        after: { status: 'FINALIZED', payslips: result.payslips },
        request,
      });

      return reply.send({ data: { id, status: 'FINALIZED', payslips: result.payslips } });
    },
  );

  app.post(
    '/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(payrollCancelSchema, request.body);

      const run = await prisma.payrollRun.findFirst({ where: { id, companyId: auth.companyId } });
      if (!run) throw new NotFoundError('Payroll run');
      assertTransition(run.status, 'CANCELLED');

      const released = await prisma.$transaction(async (tx) => {
        await tx.payrollRun.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: auth.userId,
            cancelReason: input.reason,
          },
        });

        /**
         * Hand back the loan repayments this run had claimed.
         *
         * A cancelled run collected nothing, so its installments go back to
         * SCHEDULED and the next run picks them up. Without this they would
         * stay PENDING_PAYROLL against a run that will never finalize, and the
         * employee's balance would stop coming down for good.
         */
        const { count } = await tx.employeeLoanInstallment.updateMany({
          where: { payrollRunId: id, status: 'PENDING_PAYROLL' },
          data: { payrollRunId: null, status: 'SCHEDULED' },
        });

        // Manual adjustments likewise: unapplied ones go back to the pool so
        // the next run for the period applies them instead of losing them.
        await tx.payrollAdjustment.updateMany({
          where: { appliedRunId: id, appliedAt: null },
          data: { appliedRunId: null },
        });
        return count;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.cancel',
        entityType: 'PayrollRun',
        entityId: id,
        summary: `Cancelled payroll run: ${input.reason}${released > 0 ? `; released ${released} loan installment(s) back to the schedule` : ''}`,
        before: { status: run.status },
        after: { status: 'CANCELLED', reason: input.reason, loanInstallmentsReleased: released },
        request,
      });

      return reply.send({ data: { id, status: 'CANCELLED' } });
    },
  );
};

// ================================================================ adjustments

export const payrollAdjustmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payrollLineQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.PayrollAdjustmentWhereInput = {
      companyId: auth.companyId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      employee: { AND: [scope] },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.payrollAdjustment.count({ where }),
      prisma.payrollAdjustment.findMany({
        where,
        skip,
        take,
        include: { employee: { select: { firstName: true, lastName: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const data: PayrollAdjustmentRecord[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      originLineId: row.originLineId,
      appliedRunId: row.appliedRunId,
      kind: row.kind,
      label: row.label,
      amount: num(row.amount),
      reason: row.reason,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(payrollAdjustmentSchema, request.body);
    await assertEmployeeInScope(auth, input.employeeId);

    if (input.originLineId) {
      const line = await prisma.payrollLine.findFirst({
        where: { id: input.originLineId, companyId: auth.companyId },
        select: { employeeId: true },
      });
      if (!line) throw new NotFoundError('Payroll line');
      if (line.employeeId !== input.employeeId) {
        throw new ValidationError({
          originLineId: ['That payroll line belongs to a different employee.'],
        });
      }
    }

    const created = await prisma.payrollAdjustment.create({
      data: {
        companyId: auth.companyId,
        employeeId: input.employeeId,
        originLineId: input.originLineId ?? null,
        kind: input.kind,
        label: input.label,
        amount: input.amount,
        reason: input.reason,
        createdBy: auth.userId,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.adjustment.create',
      entityType: 'PayrollAdjustment',
      entityId: created.id,
      summary: `Raised a ${input.kind === 'EARNING' ? 'payment' : 'recovery'} adjustment of ${input.amount}: ${input.reason}`,
      after: {
        employeeId: input.employeeId,
        kind: input.kind,
        amount: input.amount,
        reason: input.reason,
        originLineId: input.originLineId ?? null,
      },
      request,
    });

    return reply.status(201).send({ data: { id: created.id } });
  });

  app.delete(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const row = await prisma.payrollAdjustment.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!row) throw new NotFoundError('Adjustment');
      await assertEmployeeInScope(auth, row.employeeId);

      // Once an adjustment has been paid it is part of the record, exactly like
      // the line it corrected.
      if (row.appliedAt !== null) {
        throw new ConflictError(
          'This adjustment has already been paid. Raise a further adjustment to correct it.',
        );
      }

      await prisma.payrollAdjustment.delete({ where: { id } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.adjustment.delete',
        entityType: 'PayrollAdjustment',
        entityId: id,
        summary: `Withdrew adjustment "${row.label}"`,
        before: { amount: num(row.amount), kind: row.kind, reason: row.reason },
        request,
      });

      return reply.status(204).send();
    },
  );
};

// =================================================================== payslips

function toMoneyLines(
  rows: ReadonlyArray<{
    code: string | null;
    label: string;
    kind: string;
    calc: string;
    rate: Prisma.Decimal | null;
    amount: Prisma.Decimal;
    units?: Prisma.Decimal | null;
  }>,
): PayrollMoneyLine[] {
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    kind: row.kind,
    calc: row.calc as PayrollMoneyLine['calc'],
    rate: nullableNum(row.rate),
    units: row.units === undefined ? null : nullableNum(row.units),
    amount: num(row.amount),
  }));
}

function toLineRecord(row: {
  id: string;
  runId: string;
  employeeId: string;
  salaryType: string;
  salaryAmount: Prisma.Decimal;
  currency: string;
  basis: string;
  basisDays: Prisma.Decimal;
  dailyRate: Prisma.Decimal;
  hourlyRate: Prisma.Decimal;
  salarySegments: number;
  scheduledDays: Prisma.Decimal;
  scheduledMinutes: number;
  presentDays: Prisma.Decimal;
  halfDays: Prisma.Decimal;
  absentDays: Prisma.Decimal;
  paidLeaveDays: Prisma.Decimal;
  unpaidLeaveDays: Prisma.Decimal;
  holidayDays: Prisma.Decimal;
  weekendDays: Prisma.Decimal;
  payableDays: Prisma.Decimal;
  unpaidDays: Prisma.Decimal;
  workedMinutes: number;
  lateOccurrences: number;
  lateMinutes: number;
  earlyLeaveOccurrences: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  paidOvertimeMinutes: number;
  basicAmount: Prisma.Decimal;
  overtimeAmount: Prisma.Decimal;
  earningsTotal: Prisma.Decimal;
  deductionsTotal: Prisma.Decimal;
  adjustmentTotal: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  earnings: Parameters<typeof toMoneyLines>[0];
  deductions: Parameters<typeof toMoneyLines>[0];
  employee: {
    firstName: string;
    lastName: string;
    displayName: string | null;
    employeeNumber: string;
    department: { name: string } | null;
  };
}): PayrollLineRecord {
  return {
    id: row.id,
    runId: row.runId,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    departmentName: row.employee.department?.name ?? null,

    salaryType: row.salaryType as PayrollLineRecord['salaryType'],
    salaryAmount: num(row.salaryAmount),
    currency: row.currency,
    basis: row.basis as PayrollLineRecord['basis'],
    basisDays: num(row.basisDays),
    dailyRate: num(row.dailyRate),
    hourlyRate: num(row.hourlyRate),
    salarySegments: row.salarySegments,

    scheduledDays: num(row.scheduledDays),
    scheduledMinutes: row.scheduledMinutes,
    presentDays: num(row.presentDays),
    halfDays: num(row.halfDays),
    absentDays: num(row.absentDays),
    paidLeaveDays: num(row.paidLeaveDays),
    unpaidLeaveDays: num(row.unpaidLeaveDays),
    holidayDays: num(row.holidayDays),
    weekendDays: num(row.weekendDays),
    payableDays: num(row.payableDays),
    unpaidDays: num(row.unpaidDays),
    workedMinutes: row.workedMinutes,
    lateOccurrences: row.lateOccurrences,
    lateMinutes: row.lateMinutes,
    earlyLeaveOccurrences: row.earlyLeaveOccurrences,
    earlyLeaveMinutes: row.earlyLeaveMinutes,
    overtimeMinutes: row.overtimeMinutes,
    approvedOvertimeMinutes: row.approvedOvertimeMinutes,
    paidOvertimeMinutes: row.paidOvertimeMinutes,

    basicAmount: num(row.basicAmount),
    overtimeAmount: num(row.overtimeAmount),
    earningsTotal: num(row.earningsTotal),
    deductionsTotal: num(row.deductionsTotal),
    adjustmentTotal: num(row.adjustmentTotal),
    grossAmount: num(row.grossAmount),
    netAmount: num(row.netAmount),

    earnings: toMoneyLines(row.earnings),
    deductions: toMoneyLines(row.deductions),
  };
}

const PAYSLIP_INCLUDE = {
  line: {
    include: {
      earnings: true,
      deductions: true,
      employee: {
        select: {
          firstName: true,
          lastName: true,
          displayName: true,
          employeeNumber: true,
          department: { select: { name: true } },
        },
      },
      run: {
        include: {
          period: { select: { name: true, startDate: true, endDate: true, payDate: true } },
        },
      },
    },
  },
} as const;

/**
 * Whether the caller sees payslips before they are released.
 *
 * A payslip exists from the moment a run is finalized, so an administrator can
 * check it; it is released to the person it belongs to when the run is
 * published. Anyone holding payroll.read is on the administering side of that
 * line. Everyone else - which in practice means an employee reading their own
 * - waits for publication.
 */
function payslipVisibility(auth: { permissions: Set<string> }): Prisma.PayslipWhereInput {
  return auth.permissions.has(PERMISSIONS.PAYROLL_READ) ? {} : { publishedAt: { not: null } };
}

export const payslipRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYSLIP_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payslipQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.PayslipWhereInput = {
      companyId: auth.companyId,
      ...payslipVisibility(auth),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.runId ? { line: { runId: query.runId } } : {}),
      employee: { AND: [scope] },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.payslip.count({ where }),
      prisma.payslip.findMany({
        where,
        skip,
        take,
        include: PAYSLIP_INCLUDE,
        orderBy: { issuedAt: 'desc' },
      }),
    ]);

    const data: PayslipRecord[] = rows.map((row) => ({
      id: row.id,
      number: row.number,
      employeeId: row.employeeId,
      employeeName: displayName(row.line.employee),
      employeeNumber: row.line.employee.employeeNumber,
      runId: row.line.runId,
      periodName: row.line.run.period.name,
      periodStart: day(row.line.run.period.startDate)!,
      periodEnd: day(row.line.run.period.endDate)!,
      payDate: day(row.line.run.period.payDate),
      currency: row.line.currency,
      issuedAt: row.issuedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      line: toLineRecord(row.line),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  /**
   * One payslip.
   *
   * The scope check is the whole point of this route: without it, an employee
   * could read anybody's pay by changing the id, which is exactly the failure
   * this system must not have.
   */
  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.payslip.findFirst({
      where: { id, companyId: auth.companyId },
      include: PAYSLIP_INCLUDE,
    });
    if (!row) throw new NotFoundError('Payslip');

    // Deliberately after the fetch and deliberately a 403, not a 404: the
    // caller is being told they may not see it, not that it does not exist.
    await assertEmployeeInScope(auth, row.employeeId);

    // Their own, but not yet released. A 404 here, not a 403: from where the
    // employee stands the payslip does not exist yet, and saying otherwise
    // would announce a figure that is still being checked.
    if (row.publishedAt === null && !auth.permissions.has(PERMISSIONS.PAYROLL_READ)) {
      throw new NotFoundError('Payslip');
    }

    const data: PayslipRecord = {
      id: row.id,
      number: row.number,
      employeeId: row.employeeId,
      employeeName: displayName(row.line.employee),
      employeeNumber: row.line.employee.employeeNumber,
      runId: row.line.runId,
      periodName: row.line.run.period.name,
      periodStart: day(row.line.run.period.startDate)!,
      periodEnd: day(row.line.run.period.endDate)!,
      payDate: day(row.line.run.period.payDate),
      currency: row.line.currency,
      issuedAt: row.issuedAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      line: toLineRecord(row.line),
    };

    return reply.send({ data });
  });

  /** Releases a run's payslips to the people they belong to. */
  app.post(
    '/publish',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const body = request.body as { runId?: string };
      if (!body?.runId) throw new ValidationError({ runId: ['Choose a payroll run.'] });

      const run = await prisma.payrollRun.findFirst({
        where: { id: body.runId, companyId: auth.companyId },
        select: { id: true, status: true },
      });
      if (!run) throw new NotFoundError('Payroll run');
      if (run.status !== 'FINALIZED') {
        throw new ConflictError('Only a finalized run has payslips to publish.');
      }

      // One timestamp for the batch, so the payslips this call released can
      // be told apart from any published earlier.
      const publishedAt = new Date();
      const published = await prisma.payslip.updateMany({
        where: { companyId: auth.companyId, line: { runId: run.id }, publishedAt: null },
        data: { publishedAt },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.payslip.publish',
        entityType: 'PayrollRun',
        entityId: run.id,
        summary: `Published ${published.count} payslip(s)`,
        after: { published: published.count },
        request,
      });

      await notifyPayslipHolders(request, auth.companyId, run.id, publishedAt);

      return reply.send({ data: { published: published.count } });
    },
  );
};

/**
 * Tells each employee whose payslip was just released that it is there.
 *
 * Only the payslips this call published - a second publish of the same run
 * releases nothing and tells nobody. No figures: the payslip page has them,
 * behind the sign-in, and the browser push for a `Payslip` is generic anyway.
 */
async function notifyPayslipHolders(
  request: FastifyRequest,
  companyId: string,
  runId: string,
  publishedAt: Date,
): Promise<void> {
  const payslips = await prisma.payslip.findMany({
    where: { companyId, publishedAt, line: { runId } },
    select: {
      id: true,
      employee: { select: { userId: true } },
      line: { select: { run: { select: { period: { select: { name: true } } } } } },
    },
  });
  for (const payslip of payslips) {
    const userId = payslip.employee.userId;
    if (!userId) continue;
    await notify({
      companyId,
      userId,
      type: 'SYSTEM',
      title: 'Your payslip is ready',
      message: `Your payslip for ${payslip.line.run.period.name} has been published.`,
      entityType: 'Payslip',
      entityId: payslip.id,
      logger: request.log,
    });
  }
}

/**
 * A calculated run with nothing blocking is waiting on whoever can approve
 * it. Those are the accounts whose roles carry `payroll.approve`, less the
 * person who just ran the calculation - they know.
 */
async function notifyPayrollApprovers(
  request: FastifyRequest,
  companyId: string,
  actorUserId: string,
  runId: string,
): Promise<void> {
  const [run, approvers] = await Promise.all([
    prisma.payrollRun.findFirst({
      where: { id: runId, companyId },
      select: { employeeCount: true, period: { select: { name: true } } },
    }),
    prisma.user.findMany({
      where: {
        companyId,
        status: 'ACTIVE',
        id: { not: actorUserId },
        userRoles: {
          some: {
            role: {
              companyId,
              rolePermissions: { some: { permission: { key: PERMISSIONS.PAYROLL_APPROVE } } },
            },
          },
        },
      },
      select: { id: true },
    }),
  ]);
  if (!run) return;
  for (const { id: userId } of approvers) {
    await notify({
      companyId,
      userId,
      type: 'APPROVAL_REQUESTED',
      title: 'Payroll run ready for approval',
      message: `${run.period.name}: calculated for ${run.employeeCount} employee(s) with no blocking exceptions.`,
      entityType: 'PayrollRun',
      entityId: runId,
      logger: request.log,
    });
  }
}

export { toLineRecord };
