import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  incrementFigures,
  salaryRevisionQuerySchema,
  salaryRevisionSchema,
  type SalaryRevisionRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';
import { salaryOn, type SalaryRow } from './payroll.service.js';

/**
 * Increments and salary revisions.
 *
 * This does not introduce a second salary store. Recording an increment writes
 * exactly one EmployeeSalary row - the same effective-dated table payroll has
 * always read - and one SalaryRevision row describing the decision behind it.
 * The consequence is the property the requirement asks for and that the
 * payroll engine already guarantees: a run for June reads the salary in force
 * in June, whatever was agreed in July.
 *
 * What is deliberately NOT done: editing the previous salary's amount. The
 * previous record is closed the day before the increment takes effect, so both
 * figures survive and any run already calculated against the old one still
 * reconciles.
 */

const num = (value: Prisma.Decimal | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const day = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** The day before an effective date, so the previous salary closes cleanly. */
function dayBefore(date: Date): Date {
  const previous = new Date(date);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous;
}

const INCLUDE = {
  employee: {
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  },
} satisfies Prisma.SalaryRevisionInclude;

type Row = Prisma.SalaryRevisionGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): SalaryRevisionRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    salaryType: row.salaryType,
    currency: row.currency,
    currentAmount: num(row.currentAmount),
    newAmount: num(row.newAmount),
    incrementAmount: num(row.incrementAmount),
    incrementPercent: num(row.incrementPercent),
    effectiveDate: day(row.effectiveDate)!,
    reason: row.reason,
    notes: row.notes,
    approvedByName: row.approvedByName,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    salaryId: row.salaryId,
    createdAt: row.createdAt.toISOString(),
  };
}

export const salaryRevisionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.PAYROLL_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(salaryRevisionQuerySchema, request.query);

    const scope = await employeeScopeFilter(auth);
    if (scope === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const where: Prisma.SalaryRevisionWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scope },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.from ? { effectiveDate: { gte: toDateOnly(query.from) } } : {},
        query.to ? { effectiveDate: { lte: toDateOnly(query.to) } } : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.salaryRevision.count({ where }),
      prisma.salaryRevision.findMany({
        where,
        skip,
        take,
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
        include: INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map(toRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.PAYROLL_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(salaryRevisionSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const [employee, company] = await Promise.all([
        prisma.employee.findFirst({
          where: { id: input.employeeId, companyId: auth.companyId },
          select: { id: true, firstName: true, lastName: true, displayName: true },
        }),
        prisma.company.findUniqueOrThrow({
          where: { id: auth.companyId },
          select: { currency: true },
        }),
      ]);
      if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

      const effectiveFrom = toDateOnly(input.effectiveDate);
      const effectiveKey = input.effectiveDate.slice(0, 10);

      const existing = await prisma.employeeSalary.findMany({
        where: { employeeId: input.employeeId },
        orderBy: { effectiveFrom: 'asc' },
      });

      const rows: SalaryRow[] = existing.map((row) => ({
        id: row.id,
        salaryType: row.salaryType,
        amount: num(row.amount),
        currency: row.currency,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      }));

      /**
       * The salary in force ON the effective date, read from the store rather
       * than taken from the request.
       *
       * A form that was opened this morning may be proposing an increase from
       * a figure that has since changed. Deriving the "from" figure here means
       * the percentage recorded is always the percentage that actually
       * happened.
       */
      const current = salaryOn(rows, effectiveKey);

      if (current && current.currency !== (input.currency ?? current.currency)) {
        throw new ValidationError({
          currency: [
            `The salary in force is in ${current.currency}. Record the change of currency as a salary record rather than an increment.`,
          ],
        });
      }

      const currency = input.currency ?? current?.currency ?? company.currency;
      const salaryType = current?.salaryType ?? input.salaryType;

      // A record starting on the same day would be two salaries claiming one
      // day, which the run reports as a blocking exception. Refused here, where
      // the message can say what to do about it.
      const sameDay = rows.find((row) => day(row.effectiveFrom) === effectiveKey);
      if (sameDay) {
        throw new ValidationError({
          effectiveDate: ['A salary record already starts on that date. Edit that record instead.'],
        });
      }

      // A later salary already exists, so this increment would sit underneath
      // it. Refused rather than silently applied to a period that is already
      // superseded.
      const later = rows.find(
        (row) => day(row.effectiveFrom)! > effectiveKey,
      );
      if (later) {
        throw new ValidationError({
          effectiveDate: [
            `A later salary already starts on ${day(later.effectiveFrom)}. Remove or re-date it before recording an increment from ${effectiveKey}.`,
          ],
        });
      }

      const currentAmount = current ? current.amount : 0;
      const { incrementAmount, incrementPercent } = incrementFigures(currentAmount, input.newAmount);

      const now = new Date();

      /**
       * Close the old, open the new, record the decision - all or nothing.
       *
       * A partial write here is the worst outcome available: a closed salary
       * with no replacement leaves the employee with days no salary covers,
       * which blocks the next run.
       */
      const created = await prisma.$transaction(async (tx) => {
        if (current && current.effectiveTo === null) {
          await tx.employeeSalary.update({
            where: { id: current.id },
            data: { effectiveTo: dayBefore(effectiveFrom) },
          });
        }

        const salary = await tx.employeeSalary.create({
          data: {
            companyId: auth.companyId,
            employeeId: input.employeeId,
            salaryType,
            amount: input.newAmount,
            currency,
            effectiveFrom,
            effectiveTo: null,
            note: input.reason,
          },
        });

        return tx.salaryRevision.create({
          data: {
            companyId: auth.companyId,
            employeeId: input.employeeId,
            previousSalaryId: current?.id ?? null,
            salaryId: salary.id,
            salaryType,
            currency,
            currentAmount,
            newAmount: input.newAmount,
            incrementAmount,
            incrementPercent,
            effectiveDate: effectiveFrom,
            reason: input.reason,
            notes: input.notes ?? null,
            approvedByUserId: input.approvedByUserId ?? auth.userId,
            approvedByName: input.approvedByName ?? null,
            approvedAt: now,
            createdBy: auth.userId,
          },
          include: INCLUDE,
        });
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'payroll.salary.revise',
        entityType: 'SalaryRevision',
        entityId: created.id,
        summary: `Revised ${displayName(employee)}'s salary from ${currentAmount} to ${input.newAmount} ${currency} (${incrementPercent >= 0 ? '+' : ''}${incrementPercent}%) effective ${effectiveKey} - ${input.reason}`,
        before: { amount: currentAmount, salaryId: current?.id ?? null },
        after: {
          amount: input.newAmount,
          incrementAmount,
          incrementPercent,
          effectiveDate: effectiveKey,
          approvedByName: input.approvedByName ?? null,
        },
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );
};
