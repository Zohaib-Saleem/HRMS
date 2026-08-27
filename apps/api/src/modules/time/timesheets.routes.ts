import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  PERMISSIONS,
  type TimesheetRecord,
  type TimesheetStatus,
  idParamSchema,
  timesheetCreateSchema,
  timesheetQuerySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  createApprovalRequest,
  resolveDefaultApprovers,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow, toDateOnly } from './helpers.js';

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const INCLUDE = {
  employee: { select: { id: true, firstName: true, lastName: true, displayName: true } },
  entries: { orderBy: { date: 'asc' } },
} satisfies Prisma.TimesheetInclude;

type Row = Prisma.TimesheetGetPayload<{ include: typeof INCLUDE }>;

function toRecord(row: Row): TimesheetRecord {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: displayName(row.employee),
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    status: row.status as TimesheetStatus,
    totalMinutes: row.totalMinutes,
    notes: row.notes,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvalRequestId: row.approvalRequestId,
    entries: row.entries.map((e) => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
      minutes: e.minutes,
      description: e.description,
    })),
  };
}

export const timesheetRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.TIMESHEET_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(timesheetQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    // Free-text search matches the owner of the timesheet, plus its notes.
    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const searchClauses: Prisma.TimesheetWhereInput[] = terms.map((term) => ({
      OR: [
        { employee: { firstName: { contains: term, mode: 'insensitive' } } },
        { employee: { lastName: { contains: term, mode: 'insensitive' } } },
        { employee: { displayName: { contains: term, mode: 'insensitive' } } },
        { employee: { employeeNumber: { contains: term, mode: 'insensitive' } } },
        { notes: { contains: term, mode: 'insensitive' } },
      ],
    }));

    const where: Prisma.TimesheetWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        ...searchClauses,
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.timesheet.count({ where }),
      prisma.timesheet.findMany({
        where,
        skip,
        take,
        orderBy: { periodStart: 'desc' },
        include: INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map(toRecord),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.timesheet.findFirst({
      where: { id, companyId: auth.companyId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundError('Timesheet');

    await assertEmployeeInScope(auth, row.employeeId);

    return reply.send({ data: toRecord(row) });
  });

  /**
   * Create a draft timesheet. Managers may create one for someone inside their
   * scope; everyone else may only create their own.
   */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.TIMESHEET_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(timesheetCreateSchema, request.body);

      const self = await callerEmployeeOrThrow(auth);
      const employeeId = input.employeeId ?? self.id;

      if (employeeId !== self.id) {
        await assertEmployeeInScope(auth, employeeId);
      }

      const periodStart = toDateOnly(input.periodStart);

      const duplicate = await prisma.timesheet.findUnique({
        where: { employeeId_periodStart: { employeeId, periodStart } },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictError('A timesheet already exists for that period.');
      }

      const totalMinutes = input.entries.reduce((sum, entry) => sum + entry.minutes, 0);

      const created = await prisma.timesheet.create({
        data: {
          companyId: auth.companyId,
          employeeId,
          periodStart,
          periodEnd: toDateOnly(input.periodEnd),
          status: 'DRAFT',
          totalMinutes,
          notes: input.notes ?? null,
          entries: {
            create: input.entries.map((entry) => ({
              date: toDateOnly(entry.date),
              minutes: entry.minutes,
              description: entry.description ?? null,
            })),
          },
        },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'timesheet.create',
        entityType: 'Timesheet',
        entityId: created.id,
        summary: `Created timesheet for ${input.periodStart} to ${input.periodEnd}`,
        after: { totalMinutes, entries: input.entries.length },
        request,
      });

      return reply.status(201).send({ data: toRecord(created) });
    },
  );

  /** Submit a draft for approval. Only the owner may submit, and only once. */
  app.post(
    '/:id/submit',
    { preHandler: requirePermission(PERMISSIONS.TIMESHEET_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const self = await callerEmployeeOrThrow(auth);

      const timesheet = await prisma.timesheet.findFirst({
        where: { id, companyId: auth.companyId },
        include: INCLUDE,
      });
      if (!timesheet) throw new NotFoundError('Timesheet');

      if (timesheet.employeeId !== self.id) {
        throw new ForbiddenError('Only the owner of a timesheet can submit it.');
      }
      if (timesheet.status !== 'DRAFT') {
        throw new ConflictError(
          `That timesheet is already ${timesheet.status.toLowerCase()} and cannot be submitted again.`,
        );
      }

      const approvers = await resolveDefaultApprovers(auth.companyId, self.id);
      const approval = await createApprovalRequest({
        companyId: auth.companyId,
        subjectType: 'TIMESHEET',
        subjectId: timesheet.id,
        requesterEmployeeId: self.id,
        requesterUserId: auth.userId,
        title: `Timesheet ${timesheet.periodStart.toISOString().slice(0, 10)} to ${timesheet.periodEnd.toISOString().slice(0, 10)}`,
        summary: `${(timesheet.totalMinutes / 60).toFixed(1)} hours across ${timesheet.entries.length} entr${timesheet.entries.length === 1 ? 'y' : 'ies'}`,
        approverEmployeeIds: approvers,
        request,
      });

      const updated = await prisma.timesheet.update({
        where: { id },
        data: { status: 'SUBMITTED', submittedAt: new Date(), approvalRequestId: approval.id },
        include: INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'timesheet.submit',
        entityType: 'Timesheet',
        entityId: id,
        summary: `Submitted timesheet for approval`,
        before: { status: 'DRAFT' },
        after: { status: 'SUBMITTED', approvalRequestId: approval.id },
        request,
      });

      return reply.send({ data: toRecord(updated) });
    },
  );
};
