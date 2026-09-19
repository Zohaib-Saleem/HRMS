import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSET_CATEGORY_CATALOGUE } from '@hrms/shared';
import { seedAssetCatalogue } from './assets.seed.js';

/**
 * The starting asset category catalogue.
 *
 * Two claims, and the second is the one worth writing a test for.
 *
 * The first is that the default categories are DATA rather than a hard-coded
 * dropdown: four groups and the types under them, written as rows the company
 * then owns. Section 2 asks for exactly that, and the test that proves it is
 * one that counts rows in a database rather than strings in a file.
 *
 * The second is that a second run does nothing at all. That is what makes it
 * safe to call from a seeder or at boot, and it is the difference between a
 * starting point and a thing that quietly overwrites an administrator's
 * deliberate edits on every deploy. A test that only asserted the first run
 * would pass against exactly that bug.
 */

type Row = Record<string, unknown>;

/** A stand-in with just enough behaviour to tell "already there" from "new". */
function fakeDb(existing: Row[] = []) {
  const categories: Row[] = [...existing];

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      // The seeder matches names case-insensitively, which is how a company
      // that made its own "laptop" does not get a second "Laptop".
      if (value !== null && typeof value === 'object' && 'equals' in (value as Row)) {
        const { equals } = value as { equals: string };
        return String(row[key] ?? '').toLowerCase() === equals.toLowerCase();
      }
      return row[key] === value;
    });

  const db = {
    assetCategory: {
      findFirst: vi.fn((args: { where: Row }) =>
        Promise.resolve(categories.find((row) => matches(row, args.where)) ?? null),
      ),
      create: vi.fn((args: { data: Row }) => {
        const row = { id: `cat-${categories.length + 1}`, ...args.data };
        categories.push(row);
        return Promise.resolve(row);
      }),
    },
  };

  return { db, categories };
}

const asClient = (db: unknown) => db as Parameters<typeof seedAssetCatalogue>[0];

const GROUPS = DEFAULT_ASSET_CATEGORY_CATALOGUE.length;
const TYPES = DEFAULT_ASSET_CATEGORY_CATALOGUE.reduce(
  (total, group) => total + group.types.length,
  0,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('seeding the asset catalogue', () => {
  it('writes every group and every type as a database row', async () => {
    const world = fakeDb();

    const result = await seedAssetCatalogue(asClient(world.db), 'company-1');

    expect(result.groupsCreated).toBe(GROUPS);
    expect(result.typesCreated).toBe(TYPES);
    expect(world.categories).toHaveLength(GROUPS + TYPES);
  });

  it('writes the four groups section 2 names', async () => {
    const world = fakeDb();
    await seedAssetCatalogue(asClient(world.db), 'company-1');

    const groupNames = world.categories
      .filter((row) => row.parentCategoryId === null)
      .map((row) => row.name);

    expect(groupNames).toEqual([
      'IT Equipment',
      'Office Equipment',
      'Vehicles',
      'Other',
    ]);
  });

  it('hangs the types off their own group', async () => {
    const world = fakeDb();
    await seedAssetCatalogue(asClient(world.db), 'company-1');

    const it = world.categories.find((row) => row.name === 'IT Equipment');
    const laptop = world.categories.find((row) => row.name === 'Laptop');

    expect(laptop?.parentCategoryId).toBe(it?.id);
  });

  it('scopes every row to the company it was asked about', async () => {
    const world = fakeDb();
    await seedAssetCatalogue(asClient(world.db), 'company-1');

    expect(world.categories.every((row) => row.companyId === 'company-1')).toBe(true);
  });

  it('does nothing on a second run', async () => {
    const world = fakeDb();

    const first = await seedAssetCatalogue(asClient(world.db), 'company-1');
    expect(first.groupsCreated).toBe(GROUPS);

    const second = await seedAssetCatalogue(asClient(world.db), 'company-1');

    expect(second.groupsCreated).toBe(0);
    expect(second.typesCreated).toBe(0);
    expect(world.categories).toHaveLength(GROUPS + TYPES);
  });

  /*
   * The failure this file exists to prevent. A seeder that re-asserted the
   * default list would put "IT Equipment" back on a company that renamed it,
   * and nobody would connect the rename vanishing to the deploy that did it.
   */
  it('leaves a category somebody renamed alone rather than recreating it', async () => {
    const world = fakeDb([
      {
        id: 'cat-own',
        companyId: 'company-1',
        parentCategoryId: null,
        name: 'it equipment',
        isActive: true,
      },
    ]);

    const result = await seedAssetCatalogue(asClient(world.db), 'company-1');

    // Matched case-insensitively, so no second "IT Equipment" appears.
    expect(result.groupsCreated).toBe(GROUPS - 1);
    expect(
      world.categories.filter(
        (row) => String(row.name).toLowerCase() === 'it equipment',
      ),
    ).toHaveLength(1);
  });

  it('never reactivates a category somebody retired', async () => {
    const world = fakeDb([
      {
        id: 'cat-retired',
        companyId: 'company-1',
        parentCategoryId: null,
        name: 'Vehicles',
        isActive: false,
      },
    ]);

    await seedAssetCatalogue(asClient(world.db), 'company-1');

    expect(world.categories.find((row) => row.id === 'cat-retired')?.isActive).toBe(false);
  });
});
