import type { PrismaClient } from '@prisma/client';
import { DEFAULT_CASE_CATEGORY_CATALOGUE } from '@hrms/shared';

/**
 * Writing a company's starting case catalogue.
 *
 * Its own module, taking the Prisma client as an argument, because two very
 * different callers need it and only one of them is the running application:
 * the API's cases service, and `prisma/seed.ts`, which builds its own client
 * and must not drag the application's environment validation in behind an
 * import. Passing the client is what keeps the one implementation shared rather
 * than copied into the seeder and then allowed to drift.
 *
 * ADDITIVE AND IDEMPOTENT, and both words are load-bearing:
 *
 *   - a category or subcategory the company already has is left completely
 *     alone. Not re-described, not reordered, not reactivated;
 *   - nothing is ever renamed, retired or deleted;
 *   - no department is created. Departments are the organisation module's, and
 *     a helpdesk that invented one would put a department on the org chart that
 *     nobody hired for.
 *
 * The reason for that strictness is the failure it avoids. The moment a default
 * list is treated as the truth rather than as a starting point, an
 * administrator's deliberate edit - a queue they renamed, a subcategory they
 * retired because nobody used it - is silently undone by the next deploy, and
 * nobody connects the two events. So a second run reports nothing to do.
 *
 * Departments are matched on NAME, case-insensitively, against the aliases in
 * the shared catalogue. That is the only way a default list can attach itself
 * to departments it did not create: "HR", "People Operations" and "Human
 * Resources" are one department under three names. A company whose departments
 * match none of the aliases starts with an empty catalogue, which is correct -
 * an administrator fills it in from the Phase 2 screen, and an empty catalogue
 * is an obvious, fixable state rather than a wrong one.
 */

export interface CaseCatalogueSeedResult {
  /** How many of the catalogue's four department entries found a real department. */
  departmentsMatched: number;
  categoriesCreated: number;
  subcategoriesCreated: number;
}

export async function seedCaseCatalogue(
  db: Pick<PrismaClient, 'department' | 'caseCategory'>,
  companyId: string,
): Promise<CaseCatalogueSeedResult> {
  const departments = await db.department.findMany({
    where: { companyId },
    select: { id: true, name: true },
  });

  const byName = new Map(departments.map((d) => [d.name.trim().toLowerCase(), d.id]));

  const result: CaseCatalogueSeedResult = {
    departmentsMatched: 0,
    categoriesCreated: 0,
    subcategoriesCreated: 0,
  };

  for (const entry of DEFAULT_CASE_CATEGORY_CATALOGUE) {
    const departmentId = entry.departmentAliases
      .map((alias) => byName.get(alias.trim().toLowerCase()))
      .find((id): id is string => id !== undefined);

    if (!departmentId) continue;
    result.departmentsMatched += 1;

    for (const [index, category] of entry.categories.entries()) {
      /*
       * `findFirst` rather than `upsert`, and deliberately.
       *
       * The unique index on (departmentId, parentCategoryId, name) cannot cover
       * a top-level row, because its parent is null and PostgreSQL treats NULLs
       * as distinct - so there is no unique selector to upsert against. See the
       * note on `CaseCategory` in the schema. The window between this read and
       * the create is a seeder running twice at once, which is not a thing that
       * happens; the alternative would be a partial index Prisma cannot express
       * and would try to drop on the next migration.
       */
      let parent = await db.caseCategory.findFirst({
        where: { companyId, departmentId, parentCategoryId: null, name: category.name },
        select: { id: true },
      });

      if (!parent) {
        parent = await db.caseCategory.create({
          data: {
            companyId,
            departmentId,
            parentCategoryId: null,
            name: category.name,
            description: category.description ?? null,
            sortOrder: index,
          },
          select: { id: true },
        });
        result.categoriesCreated += 1;
      }

      for (const [childIndex, name] of category.subcategories.entries()) {
        const existing = await db.caseCategory.findFirst({
          where: { companyId, departmentId, parentCategoryId: parent.id, name },
          select: { id: true },
        });
        if (existing) continue;

        await db.caseCategory.create({
          data: {
            companyId,
            departmentId,
            parentCategoryId: parent.id,
            name,
            sortOrder: childIndex,
          },
          select: { id: true },
        });
        result.subcategoriesCreated += 1;
      }
    }
  }

  return result;
}
