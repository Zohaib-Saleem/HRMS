import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  employeeComponentSchema,
  idParamSchema,
  paginationQuerySchema,
  payrollAdjustmentSchema,
  payrollCancelSchema,
  payrollLineQuerySchema,
  payrollPeriodSchema,
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
  type PayrollRunRecord,
  type PayslipRecord,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';
import { assertTransition, calculateRun, finalizeRun } from './payroll.service.js';

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
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
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
      data: { companyId: auth.companyId, ...input },
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

      await prisma.salaryComponent.update({ where: { id }, data: input });

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

      await prisma.payrollRun.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: auth.userId,
          cancelReason: input.reason,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.run.cancel',
        entityType: 'PayrollRun',
        entityId: id,
        summary: `Cancelled payroll run: ${input.reason}`,
        before: { status: run.status },
        after: { status: 'CANCELLED', reason: input.reason },
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

      const published = await prisma.payslip.updateMany({
        where: { companyId: auth.companyId, line: { runId: run.id }, publishedAt: null },
        data: { publishedAt: new Date() },
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

      return reply.send({ data: { published: published.count } });
    },
  );
};

export { toLineRecord };
