import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  employeeComponentSchema,
  employeeSalarySchema,
  idParamSchema,
  paginationQuerySchema,
  payrollAdjustmentSchema,
  payrollCancelSchema,
  payrollLineQuerySchema,
  payrollPeriodSchema,
  payrollProfileSchema,
  payrollRunSchema,
  payrollSettingsSchema,
  payslipQuerySchema,
  salaryComponentSchema,
  type EmployeeComponentRecord,
  type EmployeeSalaryRecord,
  type PayrollAdjustmentRecord,
  type PayrollCalculationResult,
  type PayrollExceptionRecord,
  type PayrollLineRecord,
  type PayrollMoneyLine,
  type PayrollPeriodRecord,
  type PayrollProfileRecord,
  type PayrollRunRecord,
  type PayrollSettingsRecord,
  type PayslipRecord,
  type SalaryComponentRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';
import {
  assertTransition,
  calculateRun,
  finalizeRun,
  overlappingSalaries,
  resolveSettings,
  type SalaryRow,
} from './payroll.service.js';

/**
 * The payroll API.
 *
 * Two authorization rules run through every route here, and they are not the
 * same rule:
 *
 *   - a permission says what kind of thing you may do - read payroll, change a
 *     salary, approve a run;
 *   - a data scope says whose. Every read of a line, a payslip or a salary is
 *     filtered through `employeeScopeFilter`, so an employee holding
 *     `payslip.read` with an OWN scope sees exactly one payslip and changing
 *     the id in the URL returns 403 rather than somebody else's pay.
 *
 * Approval and finalization sit behind their own permission so a company can
 * insist that whoever prepares the payroll is not the person who signs it off.
 * By default HR Admin holds both, because a company with one administrator
 * should not be locked out of its own payroll; revoking `payroll.approve` is
 * what splits the duty.
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

/** Today in the company's own calendar, for "is this the salary in force". */
const todayKey = (): string => new Date().toISOString().slice(0, 10);

// =============================================================== payroll settings

export const payrollSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_READ) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const [settings, company] = await Promise.all([
      resolveSettings(auth.companyId),
      prisma.company.findUniqueOrThrow({
        where: { id: auth.companyId },
        select: { currency: true },
      }),
    ]);

    const data: PayrollSettingsRecord = {
      companyId: settings.companyId,
      currency: company.currency,
      frequency: settings.frequency,
      taxEnabled: settings.taxEnabled,
      basis: settings.basis,
      fixedBasisDays: settings.fixedBasisDays,
      standardHoursPerDay: num(settings.standardHoursPerDay),
      overtimeMode: settings.overtimeMode,
      overtimeMultiplier: num(settings.overtimeMultiplier),
      overtimeFixedRate: num(settings.overtimeFixedRate),
      requireApprovedOvertime: settings.requireApprovedOvertime,
      deductUnpaidAbsence: settings.deductUnpaidAbsence,
      deductUnpaidLeave: settings.deductUnpaidLeave,
      lateDeductionMode: settings.lateDeductionMode,
      lateDeductionRate: num(settings.lateDeductionRate),
      lateGraceMinutes: settings.lateGraceMinutes,
      earlyLeaveDeductionMode: settings.earlyLeaveDeductionMode,
      earlyLeaveDeductionRate: num(settings.earlyLeaveDeductionRate),
      earlyLeaveGraceMinutes: settings.earlyLeaveGraceMinutes,
      roundingDecimals: settings.roundingDecimals,
      payslipPrefix: settings.payslipPrefix,
    };

    return reply.send({ data });
  });

  app.patch(
    '/',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const before = await resolveSettings(auth.companyId);
      // Merged over what is stored, so a caller sending three fields does not
      // silently reset the other fifteen to their defaults.
      const input = parseOrThrow(payrollSettingsSchema, {
        frequency: before.frequency,
        taxEnabled: before.taxEnabled,
        basis: before.basis,
        fixedBasisDays: before.fixedBasisDays,
        standardHoursPerDay: num(before.standardHoursPerDay),
        overtimeMode: before.overtimeMode,
        overtimeMultiplier: num(before.overtimeMultiplier),
        overtimeFixedRate: num(before.overtimeFixedRate),
        requireApprovedOvertime: before.requireApprovedOvertime,
        deductUnpaidAbsence: before.deductUnpaidAbsence,
        deductUnpaidLeave: before.deductUnpaidLeave,
        lateDeductionMode: before.lateDeductionMode,
        lateDeductionRate: num(before.lateDeductionRate),
        lateGraceMinutes: before.lateGraceMinutes,
        earlyLeaveDeductionMode: before.earlyLeaveDeductionMode,
        earlyLeaveDeductionRate: num(before.earlyLeaveDeductionRate),
        earlyLeaveGraceMinutes: before.earlyLeaveGraceMinutes,
        roundingDecimals: before.roundingDecimals,
        payslipPrefix: before.payslipPrefix,
        ...(request.body as Record<string, unknown>),
      });

      const updated = await prisma.payrollSettings.update({
        where: { companyId: auth.companyId },
        data: input,
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as unknown as Record<string, unknown>,
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.settings.update',
        entityType: 'PayrollSettings',
        entityId: updated.id,
        summary: `Updated payroll settings${changes.changed.length ? ` (${changes.changed.join(', ')})` : ''}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: { ...input, companyId: auth.companyId } });
    },
  );
};

// =============================================================== payroll profiles

export const payrollProfileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(paginationQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    const where: Prisma.PayrollProfileWhereInput = {
      companyId: auth.companyId,
      employee: {
        AND: [
          scope,
          query.q
            ? {
                OR: [
                  { firstName: { contains: query.q, mode: 'insensitive' } },
                  { lastName: { contains: query.q, mode: 'insensitive' } },
                  { employeeNumber: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.payrollProfile.count({ where }),
      prisma.payrollProfile.findMany({
        where,
        skip,
        take,
        include: {
          employee: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              employeeNumber: true,
              salaries: { orderBy: { effectiveFrom: 'desc' } },
            },
          },
        },
        orderBy: { employee: { employeeNumber: 'asc' } },
      }),
    ]);

    const today = todayKey();
    const data: PayrollProfileRecord[] = rows.map((row) => {
      const current = row.employee.salaries.find(
        (s) =>
          day(s.effectiveFrom)! <= today && (s.effectiveTo === null || day(s.effectiveTo)! >= today),
      );
      return {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: displayName(row.employee),
        employeeNumber: row.employee.employeeNumber,
        isActive: row.isActive,
        basis: row.basis,
        fixedBasisDays: row.fixedBasisDays,
        standardHoursPerDay: nullableNum(row.standardHoursPerDay),
        overtimeMode: row.overtimeMode,
        overtimeMultiplier: nullableNum(row.overtimeMultiplier),
        overtimeFixedRate: nullableNum(row.overtimeFixedRate),
        hourlyRateOverride: nullableNum(row.hourlyRateOverride),
        deductUnpaidAbsence: row.deductUnpaidAbsence,
        deductUnpaidLeave: row.deductUnpaidLeave,
        paymentMethod: row.paymentMethod,
        currentSalary: current
          ? {
              amount: num(current.amount),
              salaryType: current.salaryType,
              currency: current.currency,
            }
          : null,
      };
    });

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.put('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(payrollProfileSchema, request.body);
    await assertEmployeeInScope(auth, input.employeeId);

    const { employeeId, ...rest } = input;
    const before = await prisma.payrollProfile.findUnique({ where: { employeeId } });

    const saved = await prisma.payrollProfile.upsert({
      where: { employeeId },
      create: { companyId: auth.companyId, employeeId, ...rest },
      update: rest,
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: before ? 'payroll.profile.update' : 'payroll.profile.create',
      entityType: 'PayrollProfile',
      entityId: saved.id,
      summary: `${before ? 'Updated' : 'Created'} payroll profile`,
      before: before ? (before as unknown as Record<string, unknown>) : undefined,
      after: rest as unknown as Record<string, unknown>,
      request,
    });

    return reply.send({ data: { id: saved.id, employeeId } });
  });
};

// =============================================================== employee salary

export const payrollSalaryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(payrollLineQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.EmployeeSalaryWhereInput = {
      companyId: auth.companyId,
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      employee: { AND: [scope] },
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeeSalary.count({ where }),
      prisma.employeeSalary.findMany({
        where,
        skip,
        take,
        include: {
          employee: { select: { firstName: true, lastName: true, displayName: true } },
        },
        orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'desc' }],
      }),
    ]);

    const today = todayKey();
    const data: EmployeeSalaryRecord[] = rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      employeeName: displayName(row.employee),
      salaryType: row.salaryType,
      amount: num(row.amount),
      currency: row.currency,
      effectiveFrom: day(row.effectiveFrom)!,
      effectiveTo: day(row.effectiveTo),
      note: row.note,
      isCurrent:
        day(row.effectiveFrom)! <= today &&
        (row.effectiveTo === null || day(row.effectiveTo)! >= today),
      createdAt: row.createdAt.toISOString(),
    }));

    return reply.send({ data, meta: buildMeta(query.page, query.limit, total) });
  });

  app.post('/', { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) }, async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(employeeSalarySchema, request.body);
    await assertEmployeeInScope(auth, input.employeeId);

    const company = await prisma.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { currency: true },
    });

    const from = toDateOnly(input.effectiveFrom);
    const to = input.effectiveTo ? toDateOnly(input.effectiveTo) : null;
    if (to && to < from) {
      throw new ValidationError({ effectiveTo: ['A salary cannot end before it starts.'] });
    }

    const existing = await prisma.employeeSalary.findMany({
      where: { employeeId: input.employeeId },
    });

    const candidate: SalaryRow[] = [
      ...existing.map((row) => ({
        id: row.id,
        salaryType: row.salaryType,
        amount: num(row.amount),
        currency: row.currency,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      })),
      {
        id: 'new',
        salaryType: input.salaryType,
        amount: input.amount,
        currency: input.currency ?? company.currency,
        effectiveFrom: from,
        effectiveTo: to,
      },
    ];

    // Rejected on the way in rather than discovered during a run. Two salaries
    // claiming the same day is not something payroll should have to guess at.
    const clashes = overlappingSalaries(candidate).filter(
      ([a, b]) => a === 'new' || b === 'new',
    );
    if (clashes.length > 0) {
      throw new ValidationError({
        effectiveFrom: [
          'This overlaps a salary already on record. Close the previous one first.',
        ],
      });
    }

    const created = await prisma.employeeSalary.create({
      data: {
        companyId: auth.companyId,
        employeeId: input.employeeId,
        salaryType: input.salaryType,
        amount: input.amount,
        currency: input.currency ?? company.currency,
        effectiveFrom: from,
        effectiveTo: to,
        note: input.note ?? null,
      },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'payroll.salary.create',
      entityType: 'EmployeeSalary',
      entityId: created.id,
      summary: `Set salary from ${input.effectiveFrom}`,
      after: {
        employeeId: input.employeeId,
        salaryType: input.salaryType,
        amount: input.amount,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
      },
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

      const before = await prisma.employeeSalary.findFirst({
        where: { id, companyId: auth.companyId },
      });
      if (!before) throw new NotFoundError('Salary record');
      await assertEmployeeInScope(auth, before.employeeId);

      // A salary a finalized run has already paid against is history. Editing it
      // would make the payslip and the record disagree, and the payslip is the
      // one somebody was actually paid.
      const usedByFinalized = await prisma.payrollLine.findFirst({
        where: {
          employeeId: before.employeeId,
          run: { status: 'FINALIZED' },
          createdAt: { gte: before.createdAt },
        },
        select: { id: true },
      });
      if (usedByFinalized) {
        throw new ConflictError(
          'A finalized payroll has already used this salary. Add a new effective-dated record instead of editing this one.',
        );
      }

      const input = parseOrThrow(
        employeeSalarySchema.partial({ employeeId: true }),
        { employeeId: before.employeeId, ...(request.body as Record<string, unknown>) },
      );

      const updated = await prisma.employeeSalary.update({
        where: { id },
        data: {
          salaryType: input.salaryType,
          amount: input.amount,
          effectiveFrom: toDateOnly(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
          note: input.note ?? null,
        },
      });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        { amount: input.amount, salaryType: input.salaryType } as Record<string, unknown>,
      );

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.salary.update',
        entityType: 'EmployeeSalary',
        entityId: id,
        summary: `Changed salary record${changes.changed.length ? ` (${changes.changed.join(', ')})` : ''}`,
        before: changes.before,
        after: changes.after,
        request,
      });

      return reply.send({ data: { id: updated.id } });
    },
  );
};
