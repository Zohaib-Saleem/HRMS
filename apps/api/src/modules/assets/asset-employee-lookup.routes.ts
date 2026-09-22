import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  EMPLOYEE_EXIT_STATUSES,
  PERMISSIONS,
  assetEmployeeLookupQuerySchema,
  isExitStatus,
  type AssetEmployeeLookupItem,
  type EmployeeStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { requireAnyPermission, requireAuth, requireAuthContext } from '../../auth/guards.js';

/**
 * Finding the person you are about to hand a laptop to.
 *
 * WHY THIS EXISTS AT ALL, when `/employees` already searches people: because
 * `/employees` is the DIRECTORY, it is gated on `employee.read`, and
 * `employee.read` is the grant that also opens the People screen, Team
 * attendance, Attendance reports, the Employee Master Report and half of
 * `/company/stats`. An asset manager who needed to pick a name was therefore
 * facing a choice between two wrong answers: no grant and a picker that 403s -
 * which is what the hand-made `IT_MANAGER` role in production actually had, so
 * asset assignment was quietly broken for the one person whose job it is - or
 * `employee.read` and the whole HR surface opening up behind it.
 *
 * This is the third answer. Picking somebody is a LOOKUP, not a directory, and
 * a lookup needs six fields: who they are, which number and department confirm
 * it is the right person of that name, whether they still work here, and the
 * work address to write to about the thing they are holding.
 *
 * WHAT IT REFUSES is the point, and the refusal is in the SELECT rather than in
 * a mapper. National ID, passport, bank account, salary, date of birth, home
 * address, personal email, personal phone, medical, loans and payroll are not
 * filtered out of the response - they are never read out of the database, so
 * there is no code path here that could spread them into one. See
 * `AssetEmployeeLookupItem`, which is its own shape and deliberately not a
 * narrowed `EmployeeListItem`: a column added to the directory tomorrow must
 * not arrive here as well.
 *
 * WHO MAY CALL IT: whoever may actually hand out, move on or write off company
 * property. Not `asset.read`, which every member of staff holds for their own
 * laptop and which would turn this into a company roster for all eighty of
 * them; and not a new permission either, because the question "may you assign
 * an asset" is already answered by `asset.assign`. The three grants below are
 * the three dialogs that need a person: assign, transfer, and the approver on a
 * disposal.
 *
 * IT IS NOT SCOPED BY DATA SCOPE, and that is deliberate rather than an
 * oversight. The role this endpoint exists for is scoped OWN - see
 * `DEFAULT_ROLE_SCOPES.IT_ASSET_MANAGER` - and an OWN-scoped filter here would
 * return exactly one person, the caller, which is not a picker. The write
 * routes behind it already work this way: `employeeForAssignment` resolves the
 * employee against the COMPANY, not against the scope, because issuing company
 * property to somebody is not a claim to be able to read their record. What
 * bounds this endpoint is the company and the six columns, not the scope.
 */

/** What the lookup reads off an employee row, and nothing else. */
const LOOKUP_SELECT = {
  id: true,
  employeeNumber: true,
  firstName: true,
  lastName: true,
  displayName: true,
  status: true,
  workEmail: true,
  department: { select: { name: true } },
  team: { select: { name: true } },
} satisfies Prisma.EmployeeSelect;

type LookupRow = Prisma.EmployeeGetPayload<{ select: typeof LOOKUP_SELECT }>;

function toLookupItem(row: LookupRow): AssetEmployeeLookupItem {
  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    fullName: row.displayName ?? `${row.firstName} ${row.lastName}`.trim(),
    departmentName: row.department?.name ?? null,
    teamName: row.team?.name ?? null,
    isActive: !isExitStatus(row.status),
    status: row.status as EmployeeStatus,
    workEmail: row.workEmail,
  };
}

export const assetEmployeeLookupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook(
    'preHandler',
    requireAnyPermission(
      PERMISSIONS.ASSET_ASSIGN,
      PERMISSIONS.ASSET_TRANSFER,
      PERMISSIONS.ASSET_DISPOSE,
    ),
  );

  app.get('/employee-lookup', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(assetEmployeeLookupQuerySchema, request.query);

    /*
     * Every whitespace-separated term must match somewhere, so "Ahmed Raza"
     * finds the person whose first and last names live in different columns.
     * The searchable columns are a SUBSET of the directory's: name, employee
     * number and work email. Job title, designation and department are
     * searchable on `/employees` and are not here - being able to ask "who is
     * in Finance" and get a list back is a directory, which is the thing this
     * endpoint exists in order not to be.
     */
    const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
    const searchClauses: Prisma.EmployeeWhereInput[] = terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        { employeeNumber: { contains: term, mode: 'insensitive' } },
        { workEmail: { contains: term, mode: 'insensitive' } },
      ],
    }));

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        { companyId: auth.companyId },
        // People who have left are absent unless asked for by name - a return
        // or a disposal may well involve somebody on their last day.
        query.includeInactive ? {} : { status: { notIn: [...EMPLOYEE_EXIT_STATUSES] } },
        ...searchClauses,
      ],
    };

    const rows = await prisma.employee.findMany({
      where,
      select: LOOKUP_SELECT,
      take: query.limit,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    /*
     * No pagination envelope, and no total. A picker shows the first few
     * matches of what somebody typed; publishing "1 of 312" would tell a caller
     * the size of the roster, which is a fact about the company rather than an
     * answer to "who am I giving this to".
     */
    return reply.send({ data: rows.map(toLookupItem) });
  });
};
