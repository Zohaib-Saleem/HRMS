import type { FastifyPluginAsync } from 'fastify';
import {
  CASE_CATEGORY_IN_USE_MESSAGE,
  PERMISSIONS,
  caseCategoryUpdateSchema,
  caseCategoryWriteSchema,
  idParamSchema,
  type CaseCatalogueAdminGroup,
  type CaseCategoryAdminRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';

/**
 * The routing catalogue, as its administrator edits it.
 *
 * The rows behind this are what the create form offers and what a case is filed
 * under, and nothing in the web app knows what any of them are called - which
 * is what makes this a CRUD screen over one table rather than a release.
 *
 * Four rules are enforced here and nowhere else, because the database cannot
 * express them:
 *
 *   - a top-level name is unique within its department. PostgreSQL treats NULLs
 *     as distinct, so the unique index on (departmentId, parentCategoryId,
 *     name) constrains SUBCATEGORIES and cannot constrain categories, whose
 *     parent is null. Saying so out loud beats pretending the index covers it.
 *   - the tree is two deep. A parent that is itself a subcategory is refused,
 *     because a third level would appear on no screen that draws this and would
 *     be invisible rather than merely unused.
 *   - a subcategory belongs to its parent's department, always. The field is
 *     ignored rather than trusted, so the tree cannot contradict itself.
 *   - a queue with cases behind it is RETIRED, not deleted. Deleting it would
 *     orphan the history of why a case was routed somewhere, and that history
 *     is worth more than a tidy list. Delete stays available for the row
 *     somebody created by mistake five minutes ago, which is the only case
 *     where it is the right verb.
 */

/** Rows are ordered the way both this screen and the create form order them. */
const CATEGORY_ORDER = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];

/**
 * How many cases point at one catalogue row, at either level.
 *
 * A subcategory is referenced by `subcategoryId` and a category by
 * `categoryId`, and a row can be referenced as either - so both are counted,
 * because "nothing points at this" has to mean nothing at all before the row
 * can be deleted.
 */
function caseCountFor(ids: string[]): Promise<number> {
  if (ids.length === 0) return Promise.resolve(0);
  return prisma.case.count({
    where: { OR: [{ categoryId: { in: ids } }, { subcategoryId: { in: ids } }] },
  });
}

export const caseCatalogueRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.CASE_CATEGORY_MANAGE));

  /**
   * The catalogue, retired rows and empty departments included.
   *
   * Deliberately not the employee endpoint's tree. That one hides everything
   * inactive and every department with no queues, which is right for a form and
   * exactly wrong for the screen where somebody brings a retired queue back or
   * gives a department its first one.
   */
  app.get('/catalogue', async (request, reply) => {
    const auth = requireAuthContext(request);

    const [departments, categories, counts] = await Promise.all([
      prisma.department.findMany({
        where: { companyId: auth.companyId },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.caseCategory.findMany({
        where: { companyId: auth.companyId },
        select: {
          id: true,
          departmentId: true,
          parentCategoryId: true,
          name: true,
          description: true,
          sortOrder: true,
          isActive: true,
        },
        orderBy: CATEGORY_ORDER,
      }),
      /*
       * Every row's case count in one grouped pass rather than one query per
       * row. A catalogue is tens of rows today and a per-row count is the kind
       * of loop that is fine until somebody's helpdesk has two hundred queues.
       */
      prisma.case.groupBy({
        by: ['categoryId', 'subcategoryId'],
        where: { companyId: auth.companyId },
        _count: { _all: true },
      }),
    ]);

    const tally = new Map<string, number>();
    for (const group of counts) {
      for (const id of [group.categoryId, group.subcategoryId]) {
        if (!id) continue;
        tally.set(id, (tally.get(id) ?? 0) + group._count._all);
      }
    }

    const departmentNames = new Map(departments.map((d) => [d.id, d.name]));
    const records = new Map<string, CaseCategoryAdminRecord>();

    for (const row of categories) {
      records.set(row.id, {
        id: row.id,
        departmentId: row.departmentId,
        departmentName: departmentNames.get(row.departmentId) ?? '',
        parentCategoryId: row.parentCategoryId,
        name: row.name,
        description: row.description,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
        caseCount: tally.get(row.id) ?? 0,
        children: [],
      });
    }

    const groups = new Map<string, CaseCatalogueAdminGroup>(
      departments.map((department) => [
        department.id,
        {
          departmentId: department.id,
          departmentName: department.name,
          departmentIsActive: department.isActive,
          categories: [],
        },
      ]),
    );

    for (const row of categories) {
      const record = records.get(row.id);
      if (!record) continue;

      if (row.parentCategoryId === null) {
        groups.get(row.departmentId)?.categories.push(record);
        continue;
      }
      // A child whose parent is gone cannot be drawn under it, and promoting it
      // would invent a top-level queue nobody configured. The referential
      // action makes this unreachable; it is handled rather than assumed away.
      records.get(row.parentCategoryId)?.children.push(record);
    }

    return reply.send({ data: [...groups.values()] });
  });

  /**
   * Adding a queue, at either level.
   *
   * Which level it is comes from `parentCategoryId` and from nothing else. The
   * department of a subcategory is read off its parent, so the two levels
   * cannot disagree about which department the queue belongs to.
   */
  app.post('/catalogue', async (request, reply) => {
    const auth = requireAuthContext(request);
    const input = parseOrThrow(caseCategoryWriteSchema, request.body);

    let departmentId: string;
    let parentCategoryId: string | null = null;

    if (input.parentCategoryId) {
      const parent = await prisma.caseCategory.findFirst({
        where: {
          id: input.parentCategoryId,
          companyId: auth.companyId,
          // Two deep, and this is where that is enforced.
          parentCategoryId: null,
        },
        select: { id: true, departmentId: true },
      });
      if (!parent) {
        throw new ValidationError({
          parentCategoryId: ['Choose a category from the list to add this under.'],
        });
      }
      parentCategoryId = parent.id;
      departmentId = parent.departmentId;
    } else {
      if (!input.departmentId) {
        throw new ValidationError({ departmentId: ['Choose which department this queue is for.'] });
      }
      const department = await prisma.department.findFirst({
        where: { id: input.departmentId, companyId: auth.companyId },
        select: { id: true },
      });
      if (!department) {
        throw new ValidationError({ departmentId: ['Choose a department from the list.'] });
      }
      departmentId = department.id;
    }

    await assertNameIsFree(auth.companyId, departmentId, parentCategoryId, input.name, null);

    const created = await prisma.caseCategory.create({
      data: {
        companyId: auth.companyId,
        departmentId,
        parentCategoryId,
        name: input.name,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
      select: { id: true, name: true, departmentId: true, parentCategoryId: true },
    });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'case.category.create',
      entityType: 'CaseCategory',
      entityId: created.id,
      summary: `Added case queue ${created.name}`,
      after: {
        name: created.name,
        departmentId,
        parentCategoryId,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
      request,
    });

    return reply.status(201).send({ data: created });
  });

  /**
   * Renaming one, re-describing it, re-ordering it, retiring it or bringing it
   * back.
   *
   * What cannot be changed here is where it sits: a queue's department and its
   * parent are its identity, and moving a queue under a different department
   * would silently re-file every case behind it. Somebody who wants that makes
   * a new queue and retires this one, which leaves the history intact.
   */
  app.patch('/catalogue/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(caseCategoryUpdateSchema, request.body);

    const row = await prisma.caseCategory.findFirst({
      where: { id, companyId: auth.companyId },
      select: {
        id: true,
        name: true,
        description: true,
        sortOrder: true,
        isActive: true,
        departmentId: true,
        parentCategoryId: true,
      },
    });
    if (!row) throw new NotFoundError('Case category');

    if (input.name && input.name !== row.name) {
      await assertNameIsFree(
        auth.companyId,
        row.departmentId,
        row.parentCategoryId,
        input.name,
        row.id,
      );
    }

    const updated = await prisma.caseCategory.update({
      where: { id: row.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description ?? null }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
      select: { id: true, name: true, isActive: true, sortOrder: true, description: true },
    });

    /*
     * Retiring a category takes its subcategories out of circulation with it.
     * They are written rather than inferred, because the create form skips a
     * child whose parent is retired but every OTHER reader of this table would
     * have to remember to do the same - and one that forgets offers a queue
     * that cannot be reached.
     */
    if (input.isActive === false && row.parentCategoryId === null) {
      await prisma.caseCategory.updateMany({
        where: { parentCategoryId: row.id, isActive: true },
        data: { isActive: false },
      });
    }

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'case.category.update',
      entityType: 'CaseCategory',
      entityId: row.id,
      summary:
        input.isActive === false
          ? `Retired case queue ${row.name}`
          : input.isActive === true
            ? `Restored case queue ${updated.name}`
            : `Updated case queue ${updated.name}`,
      before: {
        name: row.name,
        description: row.description,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
      },
      after: updated,
      request,
    });

    return reply.send({ data: updated });
  });

  /**
   * Deleting one.
   *
   * Only ever the row nobody has used. A queue with cases behind it - its own
   * or its children's - is refused with the sentence that says what to do
   * instead, because "retire it" is the right answer and a foreign-key error is
   * not an answer at all.
   */
  app.delete('/catalogue/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.caseCategory.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, name: true, parentCategoryId: true },
    });
    if (!row) throw new NotFoundError('Case category');

    const children = await prisma.caseCategory.findMany({
      where: { parentCategoryId: row.id },
      select: { id: true },
    });

    const used = await caseCountFor([row.id, ...children.map((child) => child.id)]);
    if (used > 0) throw new ConflictError(CASE_CATEGORY_IN_USE_MESSAGE);

    // The children go with it. They are part of the same queue, they carry no
    // cases (just established), and leaving them behind would leave rows whose
    // parent no longer exists.
    await prisma.caseCategory.delete({ where: { id: row.id } });

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'case.category.delete',
      entityType: 'CaseCategory',
      entityId: row.id,
      summary: `Deleted case queue ${row.name}`,
      before: { name: row.name, subcategories: children.length },
      request,
    });

    return reply.status(204).send();
  });
};

/**
 * Refuses a duplicate name at the same level of the same department.
 *
 * For a subcategory this is belt and braces over the unique index. For a
 * top-level category it is the only thing enforcing it, because the index
 * cannot: its parent column is null, and PostgreSQL treats nulls as distinct.
 */
async function assertNameIsFree(
  companyId: string,
  departmentId: string,
  parentCategoryId: string | null,
  name: string,
  excludeId: string | null,
): Promise<void> {
  const clash = await prisma.caseCategory.findFirst({
    where: {
      companyId,
      departmentId,
      parentCategoryId,
      name: { equals: name, mode: 'insensitive' },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });

  if (clash) {
    throw new ValidationError({
      name: [
        parentCategoryId
          ? 'That category already has a subcategory with this name.'
          : 'That department already has a queue with this name.',
      ],
    });
  }
}
