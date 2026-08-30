import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  EMPLOYEE_SORT_FIELDS,
  PERMISSIONS,
  type EmployeeTreeNode,
  employeeInputSchema,
  employeeQuerySchema,
  idParamSchema,
  terminateEmployeeSchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, buildOrderBy, toSkipTake } from '../../core/pagination.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { restoreUser, suspendUser } from '../users/users.service.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  DETAIL_INCLUDE,
  LIST_INCLUDE,
  assertNoReportingCycle,
  assertReferencesExist,
  nextEmployeeNumber,
  stripRestricted,
  toDetail,
  toListItem,
  toPrismaData,
} from './employees.service.js';

const CSV_COLUMNS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'workEmail',
  'phone',
  'jobTitle',
  'department',
  'team',
  'designation',
  'location',
  'manager',
  'employmentType',
  'status',
  'hireDate',
] as const;

/** RFC 4180 escaping - quotes doubled, field wrapped when it contains a delimiter. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  /** Every route here needs at least read access. */
  app.addHook('preHandler', requirePermission(PERMISSIONS.EMPLOYEE_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(employeeQuerySchema, request.query);

    const scopeFilter = await employeeScopeFilter(auth);
    // NONE means no rows - never "no filter".
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }

    // Each whitespace-separated term must match somewhere, so "Ada Lovelace"
    // finds the person whose first and last name live in different columns -
    // a single `contains` over one field never would.
    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const searchClauses: Prisma.EmployeeWhereInput[] = terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { middleName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        { employeeNumber: { contains: term, mode: 'insensitive' } },
        { workEmail: { contains: term, mode: 'insensitive' } },
        { jobTitle: { contains: term, mode: 'insensitive' } },
        { designation: { name: { contains: term, mode: 'insensitive' } } },
        { department: { name: { contains: term, mode: 'insensitive' } } },
      ],
    }));

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        scopeFilter,
        query.status ? { status: query.status } : {},
        query.employmentType ? { employmentType: query.employmentType } : {},
        query.departmentId ? { departmentId: query.departmentId } : {},
        query.teamId ? { teamId: query.teamId } : {},
        query.designationId ? { designationId: query.designationId } : {},
        query.locationId ? { locationId: query.locationId } : {},
        query.managerId ? { managerId: query.managerId } : {},
        ...searchClauses,
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        skip,
        take,
        orderBy: buildOrderBy(query.sort, query.order, EMPLOYEE_SORT_FIELDS, 'lastName'),
        include: LIST_INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map(toListItem),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  /** Reporting hierarchy, restricted to what the caller may see. */
  app.get('/tree', async (request, reply) => {
    const auth = requireAuthContext(request);

    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) return reply.send({ data: [] });

    const rows = await prisma.employee.findMany({
      where: { AND: [{ companyId: auth.companyId }, scopeFilter] },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        employeeNumber: true,
        jobTitle: true,
        photoUrl: true,
        status: true,
        managerId: true,
        designation: { select: { name: true } },
        department: { select: { name: true } },
      },
    });

    const nodes = new Map<string, EmployeeTreeNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        fullName: row.displayName ?? `${row.firstName} ${row.lastName}`.trim(),
        employeeNumber: row.employeeNumber,
        jobTitle: row.designation?.name ?? row.jobTitle,
        departmentName: row.department?.name ?? null,
        photoUrl: row.photoUrl,
        status: row.status,
        reports: [],
      });
    }

    const roots: EmployeeTreeNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      if (!node) continue;
      const manager = row.managerId ? nodes.get(row.managerId) : undefined;
      // A manager outside the caller's scope means this node is a local root.
      if (manager && manager !== node) manager.reports.push(node);
      else roots.push(node);
    }

    return reply.send({ data: roots });
  });

  app.get(
    '/export',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_EXPORT) },
    async (request, reply) => {
      const auth = requireAuthContext(request);

      const scopeFilter = await employeeScopeFilter(auth);
      const rows =
        scopeFilter === null
          ? []
          : await prisma.employee.findMany({
              where: { AND: [{ companyId: auth.companyId }, scopeFilter] },
              orderBy: { employeeNumber: 'asc' },
              include: LIST_INCLUDE,
            });

      const items = rows.map(toListItem);
      const lines = [
        CSV_COLUMNS.join(','),
        ...items.map((item) =>
          [
            item.employeeNumber,
            item.firstName,
            item.lastName,
            item.workEmail,
            item.phone,
            item.jobTitle,
            item.department?.name,
            item.team?.name,
            item.designation?.name,
            item.location?.name,
            item.manager?.fullName,
            item.employmentType,
            item.status,
            item.hireDate,
          ]
            .map(csvCell)
            .join(','),
        ),
      ];

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.export',
        entityType: 'Employee',
        summary: `Exported ${items.length} employee record(s) to CSV`,
        request,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="employees.csv"')
        // BOM so Excel opens UTF-8 names correctly.
        .send(`﻿${lines.join('\r\n')}\r\n`);
    },
  );

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    await assertEmployeeInScope(auth, id);

    const row = await prisma.employee.findFirst({
      where: { id, companyId: auth.companyId },
      include: DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundError('Employee');

    const canSeeRestricted = auth.permissions.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ);

    if (canSeeRestricted) {
      // Reading identity and financial data is itself an auditable event.
      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.sensitive.read',
        entityType: 'Employee',
        entityId: id,
        summary: `Viewed restricted fields for ${row.firstName} ${row.lastName}`.trim(),
        request,
      });
    }

    return reply.send({ data: toDetail(row, canSeeRestricted) });
  });

  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(employeeInputSchema, request.body);

      await assertReferencesExist(auth.companyId, input);

      const employeeNumber = input.employeeNumber ?? (await nextEmployeeNumber(auth.companyId));

      const duplicate = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, employeeNumber },
        select: { id: true },
      });
      if (duplicate) throw new ConflictError(`Employee number ${employeeNumber} is already in use.`);

      let data = toPrismaData({ ...input, employeeNumber });
      if (!auth.permissions.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)) {
        data = stripRestricted(data);
      }

      const created = await prisma.employee.create({
        data: { ...(data as Prisma.EmployeeUncheckedCreateInput), companyId: auth.companyId },
        include: DETAIL_INCLUDE,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.create',
        entityType: 'Employee',
        entityId: created.id,
        summary: `Created employee ${created.firstName} ${created.lastName} (${employeeNumber})`.trim(),
        after: data,
        request,
      });

      return reply.status(201).send({ data: toDetail(created, true) });
    },
  );

  app.patch(
    '/:id',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(employeeInputSchema, request.body);

      await assertEmployeeInScope(auth, id);

      const before = await prisma.employee.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Employee');

      await assertReferencesExist(auth.companyId, input, id);
      if (input.managerId) await assertNoReportingCycle(auth.companyId, id, input.managerId);

      if (input.employeeNumber && input.employeeNumber !== before.employeeNumber) {
        const duplicate = await prisma.employee.findFirst({
          where: { companyId: auth.companyId, employeeNumber: input.employeeNumber, NOT: { id } },
          select: { id: true },
        });
        if (duplicate) {
          throw new ConflictError(`Employee number ${input.employeeNumber} is already in use.`);
        }
      }

      let data = toPrismaData({
        ...input,
        employeeNumber: input.employeeNumber ?? before.employeeNumber,
      });
      // Without the sensitive grant these fields are left exactly as they were,
      // rather than being blanked by a form that never showed them.
      if (!auth.permissions.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)) {
        data = stripRestricted(data);
      }

      const updated = await prisma.employee.update({
        where: { id },
        data: data as Prisma.EmployeeUncheckedUpdateInput,
        include: DETAIL_INCLUDE,
      });

      const changes = diff(before as unknown as Record<string, unknown>, data);
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'employee.update',
          entityType: 'Employee',
          entityId: id,
          summary: `Updated ${updated.firstName} ${updated.lastName} (${changes.changed.join(', ')})`.trim(),
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({
        data: toDetail(updated, auth.permissions.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)),
      });
    },
  );

  /**
   * Termination replaces deletion. HR records carry legal retention duties, so
   * the row stays and the status changes.
   */
  app.post(
    '/:id/terminate',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(terminateEmployeeSchema, request.body);

      await assertEmployeeInScope(auth, id);

      const before = await prisma.employee.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Employee');
      if (before.status === 'TERMINATED') {
        throw new ConflictError('That employee is already terminated.');
      }

      const updated = await prisma.employee.update({
        where: { id },
        data: { status: 'TERMINATED', terminationDate: new Date(input.terminationDate) },
        include: DETAIL_INCLUDE,
      });

      // A departing employee must not keep a working login. Suspending records
      // *why*, so reactivating them later can tell the difference between an
      // account switched off because they left and one switched off for a
      // reason of its own.
      let accountOutcome: { changed: boolean; revokedSessions: number } | null = null;
      if (before.userId) {
        accountOutcome = await suspendUser({
          userId: before.userId,
          reason: 'EMPLOYMENT_TERMINATED',
          actorUserId: auth.userId,
        });
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.terminate',
        entityType: 'Employee',
        entityId: id,
        summary: `Terminated ${updated.firstName} ${updated.lastName}${input.reason ? ` - ${input.reason}` : ''}${accountOutcome?.changed ? `; suspended their login and revoked ${accountOutcome.revokedSessions} session(s)` : ''}`.trim(),
        before: { status: before.status, terminationDate: before.terminationDate },
        after: {
          status: 'TERMINATED',
          terminationDate: input.terminationDate,
          accountSuspended: accountOutcome?.changed ?? false,
          sessionsRevoked: accountOutcome?.revokedSessions ?? 0,
        },
        request,
      });

      return reply.send({ data: toDetail(updated, true) });
    },
  );

  app.post(
    '/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      await assertEmployeeInScope(auth, id);

      const before = await prisma.employee.findFirst({ where: { id, companyId: auth.companyId } });
      if (!before) throw new NotFoundError('Employee');
      if (before.status !== 'TERMINATED') {
        throw new ConflictError('That employee is not terminated.');
      }

      const updated = await prisma.employee.update({
        where: { id },
        data: { status: 'ACTIVE', terminationDate: null },
        include: DETAIL_INCLUDE,
      });

      /**
       * Restore the login too - but only if the termination is what switched it
       * off. An account an administrator suspended for a separate reason stays
       * suspended: reactivating an employee is not a decision about a security
       * concern somebody raised deliberately, and silently undoing one would be
       * the worst kind of helpful.
       */
      let accountRestored = false;
      let accountRefusal: string | null = null;
      if (before.userId) {
        const outcome = await restoreUser({
          userId: before.userId,
          onlyIfTerminationSuspended: true,
        });
        accountRestored = outcome.restored;
        if (!outcome.restored && outcome.refusal === 'SUSPENDED_ADMINISTRATIVELY') {
          accountRefusal = 'suspended separately by an administrator, so it was left suspended';
        }
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.reactivate',
        entityType: 'Employee',
        entityId: id,
        summary: `Reactivated ${updated.firstName} ${updated.lastName}`.trim() +
          (accountRestored
            ? '; restored their login'
            : accountRefusal
              ? `; login ${accountRefusal}`
              : ''),
        before: { status: 'TERMINATED' },
        after: { status: 'ACTIVE', accountRestored, accountNote: accountRefusal },
        request,
      });

      return reply.send({ data: toDetail(updated, true) });
    },
  );

  // --- work experience (repeating sub-records) -----------------------------

  const workExperienceBody = z.object({
    companyName: z.string().trim().min(1).max(160),
    jobTitle: z.string().trim().max(120).nullish(),
    fromDate: z.string().trim().nullish(),
    toDate: z.string().trim().nullish(),
    description: z.string().trim().max(500).nullish(),
  });

  app.post(
    '/:id/work-experience',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(workExperienceBody, request.body);

      await assertEmployeeInScope(auth, id);

      const employee = await prisma.employee.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!employee) throw new NotFoundError('Employee');

      const created = await prisma.employeeWorkExperience.create({
        data: {
          employeeId: id,
          companyName: input.companyName,
          jobTitle: input.jobTitle ?? null,
          fromDate: input.fromDate ? new Date(input.fromDate) : null,
          toDate: input.toDate ? new Date(input.toDate) : null,
          description: input.description ?? null,
        },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.work_experience.create',
        entityType: 'Employee',
        entityId: id,
        summary: `Added previous employment at ${input.companyName}`,
        after: input as unknown as Record<string, unknown>,
        request,
      });

      return reply.status(201).send({ data: { id: created.id } });
    },
  );

  app.delete(
    '/:id/work-experience/:entryId',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id, entryId } = parseOrThrow(
        z.object({ id: z.string().min(1), entryId: z.string().min(1) }),
        request.params,
      );

      await assertEmployeeInScope(auth, id);

      const entry = await prisma.employeeWorkExperience.findFirst({
        where: { id: entryId, employeeId: id, employee: { companyId: auth.companyId } },
      });
      if (!entry) throw new NotFoundError('Work experience entry');

      await prisma.employeeWorkExperience.delete({ where: { id: entryId } });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'employee.work_experience.delete',
        entityType: 'Employee',
        entityId: id,
        summary: `Removed previous employment at ${entry.companyName}`,
        request,
      });

      return reply.send({ data: { id: entryId } });
    },
  );

  /**
   * Deliberately absent: DELETE /employees/:id.
   * HR records are terminated and retained, never destroyed. This handler
   * exists only to say so clearly instead of returning a bare 404.
   */
  app.delete('/:id', async () => {
    throw new ForbiddenError(
      'Employee records cannot be deleted. Terminate the employee instead so the history is retained.',
    );
  });
};
