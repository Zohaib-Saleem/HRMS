import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  CONTRACT_EXPIRY_WARNING_DAYS,
  PERMISSIONS,
  contractExpiry,
  contractInputSchema,
  contractPatchSchema,
  contractQuerySchema,
  idParamSchema,
  type ContractRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import { toDateOnly } from '../time/helpers.js';

/**
 * Employment contracts.
 *
 * Retained, never deleted - the same rule the employee record itself follows,
 * and for the same reason: a contract is evidence of what was agreed, and a
 * system that can quietly lose one is not evidence of anything. Ending a
 * contract sets a status; superseding one opens a new row and points back.
 *
 * Expiry is derived from the end date on every read rather than stored, so a
 * contract nobody has opened since it lapsed still reports that it lapsed.
 * Nothing schedules a job to "expire" contracts, because a job that has not
 * run yet would make the screen lie.
 */

const INCLUDE = {
  employee: {
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  },
} satisfies Prisma.EmployeeContractInclude;

type Row = Prisma.EmployeeContractGetPayload<{ include: typeof INCLUDE }>;

const day = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

const todayKey = (): string => new Date().toISOString().slice(0, 10);

const employeeName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

function toRecord(row: Row, today: string): ContractRecord {
  const endDate = day(row.endDate);
  const { state, daysRemaining } = contractExpiry(endDate, today);

  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: employeeName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    contractType: row.contractType,
    status: row.status,
    reference: row.reference,
    startDate: day(row.startDate)!,
    endDate,
    documentUrl: row.documentUrl,
    documentName: row.documentName,
    previousContractId: row.previousContractId,
    notes: row.notes,
    expiryState: state,
    daysRemaining,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Narrows a query to an expiry state.
 *
 * Expressed in SQL rather than filtered in memory, because "which contracts
 * expire this month?" has to be answerable across the whole company without
 * loading every contract ever written to find out.
 */
function expiryClause(
  expiry: 'expiring' | 'expired' | 'active' | undefined,
  today: Date,
): Prisma.EmployeeContractWhereInput {
  if (!expiry) return {};

  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + CONTRACT_EXPIRY_WARNING_DAYS);

  switch (expiry) {
    case 'expired':
      return { endDate: { lt: today } };
    case 'expiring':
      return { endDate: { gte: today, lte: horizon } };
    case 'active':
      // Open-ended counts as active: it is not going to run out.
      return { OR: [{ endDate: null }, { endDate: { gt: horizon } }] };
    default:
      return {};
  }
}

export const contractRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.CONTRACT_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(contractQuerySchema, request.query);

    // Contracts inherit the employee data scope exactly: if you cannot see the
    // person, you cannot see what they signed.
    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const today = toDateOnly(todayKey());

    const where: Prisma.EmployeeContractWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.contractType ? { contractType: query.contractType } : {},
        expiryClause(query.expiry, today),
        query.q
          ? {
              OR: [
                { reference: { contains: query.q, mode: 'insensitive' } },
                { notes: { contains: query.q, mode: 'insensitive' } },
                { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employeeContract.count({ where }),
      prisma.employeeContract.findMany({
        where,
        skip,
        take,
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        include: INCLUDE,
      }),
    ]);

    const todayIso = todayKey();
    return reply.send({
      data: rows.map((row) => toRecord(row, todayIso)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /**
   * How many contracts are running out, for the list header.
   *
   * Counted rather than derived from the page in front of the user: a warning
   * that only appears once you have paged to the right contract is not a
   * warning.
   */
  app.get('/expiring/summary', async (request, reply) => {
    const auth = requireAuthContext(request);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: { expiringSoon: 0, expired: 0, warningDays: CONTRACT_EXPIRY_WARNING_DAYS } });
    }

    const today = toDateOnly(todayKey());
    const base: Prisma.EmployeeContractWhereInput = {
      companyId: auth.companyId,
      employee: scopeFilter,
      // A contract already closed by hand is not "expiring" - somebody dealt
      // with it. Only the ones still presented as live are worth chasing.
      status: { in: ['ACTIVE', 'DRAFT'] },
    };

    const [expiringSoon, expired] = await Promise.all([
      prisma.employeeContract.count({
        where: { AND: [base, expiryClause('expiring', today)] },
      }),
      prisma.employeeContract.count({
        where: { AND: [base, expiryClause('expired', today)] },
      }),
    ]);

    return reply.send({
      data: { expiringSoon, expired, warningDays: CONTRACT_EXPIRY_WARNING_DAYS },
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.employeeContract.findFirst({
      where: { id, companyId: auth.companyId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Contract');

    await assertEmployeeInScope(auth, row.employeeId);

    return reply.send({ data: toRecord(row, todayKey()) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.CONTRACT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(contractInputSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const employee = await prisma.employee.findFirst({
        where: { id: input.employeeId, companyId: auth.companyId },
        select: { id: true },
      });
      if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

      let previous: { id: string; employeeId: string } | null = null;
      if (input.previousContractId) {
        previous = await prisma.employeeContract.findFirst({
          where: { id: input.previousContractId, companyId: auth.companyId },
          select: { id: true, employeeId: true },
        });
        if (!previous) {
          throw new ValidationError({ previousContractId: ['That contract does not exist.'] });
        }
        if (previous.employeeId !== input.employeeId) {
          throw new ValidationError({
            previousContractId: ['That contract belongs to a different employee.'],
          });
        }

        // One renewal per contract: the unique key would reject the second
        // anyway, and a clear message beats a constraint violation.
        const alreadyRenewed = await prisma.employeeContract.findFirst({
          where: { previousContractId: previous.id },
          select: { id: true },
        });
        if (alreadyRenewed) {
          throw new ValidationError({
            previousContractId: ['That contract has already been renewed.'],
          });
        }
      }

      // Both writes or neither: a renewal that creates the new contract and
      // fails to close the old one leaves two contracts claiming to be current.
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.employeeContract.create({
          data: {
            companyId: auth.companyId,
            employeeId: input.employeeId,
            contractType: input.contractType,
            status: input.status,
            reference: input.reference,
            startDate: toDateOnly(input.startDate),
            endDate: input.endDate ? toDateOnly(input.endDate) : null,
            documentUrl: input.documentUrl,
            documentName: input.documentName,
            notes: input.notes,
            previousContractId: previous?.id ?? null,
            createdBy: auth.userId,
          },
          include: INCLUDE,
        });

        if (previous) {
          await tx.employeeContract.update({
            where: { id: previous.id },
            data: { status: 'RENEWED' },
          });
        }

        return row;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'contract.create',
        entityType: 'EmployeeContract',
        entityId: created.id,
        summary: `${previous ? 'Renewed' : 'Recorded'} a ${input.contractType.toLowerCase().replace(/_/g, ' ')} contract for ${employeeName(created.employee)} from ${input.startDate}`,
        after: {
          contractType: input.contractType,
          status: input.status,
          startDate: input.startDate,
          endDate: input.endDate,
          previousContractId: previous?.id ?? null,
        },
        request,
      });

      return reply.status(201).send({ data: toRecord(created, todayKey()) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.CONTRACT_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(contractPatchSchema, request.body);

      const before = await prisma.employeeContract.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!before) throw new NotFoundError('Contract');

      await assertEmployeeInScope(auth, before.employeeId);

      const startDate = input.startDate ? toDateOnly(input.startDate) : before.startDate;
      const endDate =
        input.endDate === undefined
          ? before.endDate
          : input.endDate === null
            ? null
            : toDateOnly(input.endDate);

      // Re-checked against the stored row, because a PATCH carrying only an end
      // date cannot be judged against a start date it never sent.
      if (endDate && endDate < startDate) {
        throw new ValidationError({ endDate: ['A contract cannot end before it starts.'] });
      }

      const data: Prisma.EmployeeContractUncheckedUpdateInput = {
        ...(input.contractType === undefined ? {} : { contractType: input.contractType }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.startDate === undefined ? {} : { startDate }),
        ...(input.endDate === undefined ? {} : { endDate }),
        ...(input.documentUrl === undefined ? {} : { documentUrl: input.documentUrl }),
        ...(input.documentName === undefined ? {} : { documentName: input.documentName }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      };

      const updated = await prisma.employeeContract.update({
        where: { id },
        data,
        include: INCLUDE,
      });

      const changes = diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>);
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'contract.update',
          entityType: 'EmployeeContract',
          entityId: id,
          summary: `Updated the contract for ${employeeName(updated.employee)} (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: toRecord(updated, todayKey()) });
    },
  );

  /**
   * Deliberately absent: DELETE.
   *
   * A contract is evidence. It is terminated - which is a status and a date -
   * and it stays on the record, exactly as an employee is.
   */
  app.delete('/:id', async () => {
    throw new ForbiddenError(
      'Contracts cannot be deleted. Set the contract to Terminated so the history is retained.',
    );
  });
};
