import type { PrismaClient } from '@prisma/client';
import { DEFAULT_ASSET_CATEGORY_CATALOGUE } from '@hrms/shared';

/**
 * Writing a company's starting asset category catalogue.
 *
 * Its own module, taking the Prisma client as an argument, for the reason
 * `seedCaseCatalogue` does: two very different callers need it and only one of
 * them is the running application - the API, and `prisma/seed.ts`, which builds
 * its own client and must not drag the application's environment validation in
 * behind an import. Passing the client is what keeps the one implementation
 * shared rather than copied into the seeder and then allowed to drift.
 *
 * ADDITIVE AND IDEMPOTENT, and both words are load-bearing:
 *
 *   - a category the company already has is left completely alone. Not
 *     re-described, not reordered, not reactivated;
 *   - nothing is ever renamed, retired or deleted;
 *   - a second run reports nothing to do.
 *
 * The reason for that strictness is the failure it avoids. The moment a default
 * list is treated as the truth rather than as a starting point, an
 * administrator's deliberate edit - a category they renamed, one they retired
 * because the company stopped buying them - is silently undone by the next
 * deploy, and nobody connects the two events.
 *
 * Matching is by NAME within the company, case-insensitively, at each level. A
 * company that has already made its own "Laptop" under its own "IT Equipment"
 * gets neither back as a duplicate.
 */

export interface AssetCatalogueSeedResult {
  groupsCreated: number;
  typesCreated: number;
}

export async function seedAssetCatalogue(
  db: Pick<PrismaClient, 'assetCategory'>,
  companyId: string,
): Promise<AssetCatalogueSeedResult> {
  const result: AssetCatalogueSeedResult = { groupsCreated: 0, typesCreated: 0 };

  for (const [index, group] of DEFAULT_ASSET_CATEGORY_CATALOGUE.entries()) {
    /*
     * `findFirst` rather than `upsert`, and deliberately.
     *
     * The unique index on (companyId, parentCategoryId, name) cannot cover a
     * top-level row, because its parent is null and PostgreSQL treats NULLs as
     * distinct - so there is no unique selector to upsert against. See the note
     * on `AssetCategory` in the schema. The window between this read and the
     * create is a seeder running twice at once, which is not a thing that
     * happens; the alternative would be a partial index Prisma cannot express
     * and would try to drop on the next migration.
     */
    let parent = await db.assetCategory.findFirst({
      where: {
        companyId,
        parentCategoryId: null,
        name: { equals: group.name, mode: 'insensitive' },
      },
      select: { id: true },
    });

    if (!parent) {
      parent = await db.assetCategory.create({
        data: {
          companyId,
          parentCategoryId: null,
          name: group.name,
          description: group.description ?? null,
          sortOrder: index,
        },
        select: { id: true },
      });
      result.groupsCreated += 1;
    }

    for (const [typeIndex, name] of group.types.entries()) {
      const existing = await db.assetCategory.findFirst({
        where: {
          companyId,
          parentCategoryId: parent.id,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existing) continue;

      await db.assetCategory.create({
        data: { companyId, parentCategoryId: parent.id, name, sortOrder: typeIndex },
        select: { id: true },
      });
      result.typesCreated += 1;
    }
  }

  return result;
}
