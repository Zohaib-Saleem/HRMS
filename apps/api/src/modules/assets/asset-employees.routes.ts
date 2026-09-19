import type { FastifyPluginAsync } from 'fastify';
import { PERMISSIONS, idParamSchema, type EmployeeAssetsRecord } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { NotFoundError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope } from '../../auth/scope.js';
import {
  EMPLOYEE_ASSET_INCLUDE,
  buildClearance,
  toEmployeeAssetRow,
  totalCurrentValue,
} from './asset-people.service.js';

/**
 * One employee's assets, for the Assets tab on their profile.
 *
 * Registered on the `/employees` prefix and living in the assets module, which
 * is the right way round: the URL belongs to the person, and the code belongs
 * to the module that owns the tables. The alternative - an assets query inside
 * the employees module - would be the second place that knows how an assignment
 * is shaped.
 *
 * TWO GATES, AND BOTH ARE THE EXISTING ONES.
 *
 *   `asset.read` says this caller may read asset records at all.
 *   `assertEmployeeInScope` says WHICH employee, and it is the same data-scope
 *   machinery every other employee-shaped endpoint uses. An employee on an OWN
 *   scope can reach exactly their own id and is refused every other, which is
 *   section 3's "employees should only see their own assets" - enforced by the
 *   scope resolver rather than by a check written here for the third time.
 *
 * Note what is NOT gated on `asset.read.all`: this is deliberately reachable by
 * a narrow reader, because the whole point is that a person can see their own
 * kit. What the narrow reader gets is their own record and a 403 for anybody
 * else's.
 */

export const assetEmployeeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.ASSET_READ));

  app.get('/:id/assets', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const employee = await prisma.employee.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, status: true },
    });
    if (!employee) throw new NotFoundError('Employee');

    // Throws 403 for an employee this caller's scope does not reach.
    await assertEmployeeInScope(auth, employee.id);

    /*
     * Every handover this person has ever had, in one query, split in the
     * application rather than fetched twice. An employee with four assets and
     * a two-year history is a handful of rows; two round trips to save nothing
     * would be the wrong trade.
     */
    const rows = await prisma.assetAssignment.findMany({
      where: { companyId: auth.companyId, employeeId: employee.id },
      orderBy: { assignedAt: 'desc' },
      include: EMPLOYEE_ASSET_INCLUDE,
    });

    const all = rows.map(toEmployeeAssetRow);
    const assigned = all.filter((row) => row.assignmentStatus === 'ACTIVE');
    const history = all.filter((row) => row.assignmentStatus !== 'ACTIVE');

    const data: EmployeeAssetsRecord = {
      employeeId: employee.id,
      assigned,
      history,
      totalAssigned: assigned.length,
      totalCurrentValue: totalCurrentValue(assigned),
      clearance: buildClearance(employee.status, all),
    };

    return reply.send({ data });
  });
};
