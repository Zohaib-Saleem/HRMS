import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CASE_CATEGORY_CATALOGUE } from '@hrms/shared';
import { seedCaseCatalogue } from './case-catalogue.seed.js';

/**
 * The starting case catalogue.
 *
 * Two claims, and the second is the one worth writing a test for.
 *
 * The first is that it attaches itself to the company's OWN departments, by
 * name, through the aliases in the shared catalogue - so a company that calls
 * its HR department "People Operations" still gets the HR queues, and a company
 * whose departments match nothing starts empty rather than having four invented
 * for it.
 *
 * The second is that a second run does nothing at all. That is what makes it
 * safe to call from a seeder, from a migration or at boot, and it is the
 * difference between a starting point and a thing that quietly overwrites an
 * administrator's deliberate edits on every deploy. A test that only asserted
 * the first run would pass against exactly that bug.
 */

type Row = Record<string, unknown>;

/** A stand-in with just enough behaviour to tell "already there" from "new". */
function fakeDb(departments: Array<{ id: string; name: string }>) {
  const categories: Row[] = [];

  const db = {
    department: {
      findMany: vi.fn(() => Promise.resolve(departments)),
    },
    caseCategory: {
      findFirst: vi.fn((args: { where: Row }) =>
        Promise.resolve(
          categories.find((row) =>
            Object.entries(args.where).every(([key, value]) => row[key] === value),
          ) ?? null,
        ),
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

/**
 * The fake, presented as the slice of Prisma the seeder asks for.
 *
 * One cast in one place, rather than `as never` on the value itself - which
 * would have made every assertion against `world.db` untyped as well, and is
 * how a test quietly stops checking the thing it was written to check.
 */
const asClient = (db: unknown) => db as Parameters<typeof seedCaseCatalogue>[0];

const HR_ALIASES = DEFAULT_CASE_CATEGORY_CATALOGUE[0]?.departmentAliases ?? [];

let world: ReturnType<typeof fakeDb>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('seeding the catalogue', () => {
  it('writes the queues for every department it recognises', async () => {
    world = fakeDb([
      { id: 'dep-hr', name: 'HR' },
      { id: 'dep-fin', name: 'Finance' },
      { id: 'dep-it', name: 'IT' },
      { id: 'dep-admin', name: 'Admin' },
    ]);

    const result = await seedCaseCatalogue(asClient(world.db), 'company-1');

    expect(result.departmentsMatched).toBe(4);
    expect(result.categoriesCreated).toBeGreaterThan(0);
    expect(result.subcategoriesCreated).toBeGreaterThan(0);

    // The examples the module was specified against, filed where they belong.
    const named = (departmentId: string, name: string) =>
      world.categories.find(
        (row) =>
          row.departmentId === departmentId && row.name === name && row.parentCategoryId === null,
      );

    expect(named('dep-hr', 'Attendance & Leaves')).toBeDefined();
    expect(named('dep-fin', 'Reimbursement')).toBeDefined();
    expect(named('dep-it', 'Account Access')).toBeDefined();
    expect(named('dep-admin', 'Parking')).toBeDefined();

    // Subcategories hang off their own parent, not off the department.
    const email = named('dep-it', 'Email');
    const children = world.categories.filter((row) => row.parentCategoryId === email?.id);
    expect(children.map((row) => row.name)).toContain('Cannot sign in');
  });

  it('matches a department under any of its aliases', async () => {
    expect(HR_ALIASES.length).toBeGreaterThan(1);

    for (const alias of HR_ALIASES) {
      const scoped = fakeDb([{ id: 'dep-hr', name: alias }]);
      const result = await seedCaseCatalogue(asClient(scoped.db), 'company-1');
      expect(result.departmentsMatched, alias).toBe(1);
    }
  });

  it('ignores case and surrounding whitespace in a department name', async () => {
    world = fakeDb([{ id: 'dep-hr', name: '  human resources  ' }]);

    const result = await seedCaseCatalogue(asClient(world.db), 'company-1');
    expect(result.departmentsMatched).toBe(1);
  });

  it('leaves a company whose departments match nothing completely alone', async () => {
    world = fakeDb([
      { id: 'dep-eng', name: 'Engineering' },
      { id: 'dep-cs', name: 'Customer Success' },
    ]);

    const result = await seedCaseCatalogue(asClient(world.db), 'company-1');

    expect(result).toEqual({
      departmentsMatched: 0,
      categoriesCreated: 0,
      subcategoriesCreated: 0,
    });
    expect(world.db.caseCategory.create).not.toHaveBeenCalled();
  });

  it('never creates a department', async () => {
    world = fakeDb([{ id: 'dep-hr', name: 'HR' }]);
    await seedCaseCatalogue(asClient(world.db), 'company-1');

    // Departments belong to the organisation module. A helpdesk that invented
    // one would put a department on the org chart nobody hired for.
    expect(world.db.department).not.toHaveProperty('create');
  });

  it('does nothing on a second run', async () => {
    world = fakeDb([
      { id: 'dep-hr', name: 'People Operations' },
      { id: 'dep-fin', name: 'Finance' },
    ]);

    const first = await seedCaseCatalogue(asClient(world.db), 'company-1');
    const rowsAfterFirst = world.categories.length;
    expect(rowsAfterFirst).toBeGreaterThan(0);

    const second = await seedCaseCatalogue(asClient(world.db), 'company-1');

    expect(second.categoriesCreated).toBe(0);
    expect(second.subcategoriesCreated).toBe(0);
    expect(world.categories).toHaveLength(rowsAfterFirst);
    expect(second.departmentsMatched).toBe(first.departmentsMatched);
  });

  it('leaves an administrator&apos;s edits alone', async () => {
    world = fakeDb([{ id: 'dep-it', name: 'IT' }]);
    await seedCaseCatalogue(asClient(world.db), 'company-1');

    /*
     * The failure this is really about: somebody renames a queue and retires
     * one they never use, and the next deploy quietly puts both back. A seeder
     * that re-asserted the defaults would fail here, which is the point.
     */
    const email = world.categories.find(
      (row) => row.name === 'Email' && row.parentCategoryId === null,
    );
    if (email) {
      email.name = 'Email & Calendar';
      email.isActive = false;
      email.sortOrder = 99;
    }

    await seedCaseCatalogue(asClient(world.db), 'company-1');

    const edited = world.categories.find((row) => row.name === 'Email & Calendar');
    expect(edited).toMatchObject({ isActive: false, sortOrder: 99 });
    // It does add "Email" back, because as far as it can tell that queue is
    // absent - which is the correct reading of a RENAME, and is additive.
    // What it must never do is touch the row somebody changed.
    expect(world.categories.filter((row) => row.name === 'Email & Calendar')).toHaveLength(1);
  });
});
