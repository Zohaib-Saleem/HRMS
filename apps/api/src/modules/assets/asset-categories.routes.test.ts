import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The asset category catalogue.
 *
 * The rules being pinned are the ones an administrator would only discover by
 * losing something:
 *
 *   - reading the catalogue needs `asset.read`, because the asset form's
 *     category dropdown is built from it. EDITING needs
 *     `asset.category.manage`, which an employee does not hold;
 *   - retiring is the ordinary act, and there is no delete endpoint AT ALL -
 *     assets point at categories, so a delete could only ever fail for the rows
 *     somebody actually wanted rid of;
 *   - the catalogue is two levels. A type under a type is refused, because
 *     every report would then have to walk a tree of unknown depth;
 *   - duplicate names are refused at the same level. For TYPES the unique index
 *     also holds; for GROUPS, whose parent is null and which PostgreSQL treats
 *     as all distinct, this check is the only thing there is.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetCategoryRoutes } = await import('./asset-categories.routes.js');
const { COMPANY, EMPLOYEE, HR, appAs, auditActions, categoryRow, wirePeople } = kit;

const PREFIX = '/assets/categories';

beforeEach(() => {
  vi.clearAllMocks();
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.assetCategory.findFirst.mockResolvedValue(null);
});

describe('reading the catalogue', () => {
  it('serves it to anybody who may read assets, because the create form needs it', async () => {
    db.assetCategory.findMany.mockResolvedValue([
      categoryRow(),
      categoryRow({
        id: 'cat-laptop',
        parentCategoryId: 'cat-it',
        name: 'Laptop',
        description: null,
        parent: { name: 'IT Equipment' },
        _count: { assets: 7 },
      }),
    ]);

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: EMPLOYEE });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.statusCode).toBe(200);
    const tree = response.json().data;
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('IT Equipment');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('Laptop');
    // The count is what makes a delete refusable, so it travels with the row.
    expect(tree[0].children[0].assetCount).toBe(7);
  });

  it('includes retired categories, because this is where one is brought back', async () => {
    db.assetCategory.findMany.mockResolvedValue([categoryRow({ isActive: false })]);

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'GET', url: PREFIX });

    expect(response.json().data[0].isActive).toBe(false);
    // Not filtered server-side: a company that cannot see the retired "Fax
    // Machine" creates a second one called "Fax machine".
    const where = db.assetCategory.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toEqual({ companyId: COMPANY });
  });
});

describe('who may change it', () => {
  it('refuses an employee creating a category', async () => {
    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: EMPLOYEE });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { name: 'Drone' },
    });

    expect(response.statusCode).toBe(403);
    expect(db.assetCategory.create).not.toHaveBeenCalled();
  });

  it('refuses an employee retiring a category', async () => {
    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: EMPLOYEE });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/cat-it`,
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(403);
    expect(db.assetCategory.update).not.toHaveBeenCalled();
  });

  it('offers no delete at all', async () => {
    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({ method: 'DELETE', url: `${PREFIX}/cat-it` });

    expect(response.statusCode).toBe(404);
  });
});

describe('creating a category', () => {
  it('writes a group and records asset.category.created', async () => {
    db.assetCategory.create.mockResolvedValue(categoryRow({ name: 'Drone' }));

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { name: 'Drone' },
    });

    expect(response.statusCode).toBe(201);
    expect(db.assetCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ companyId: COMPANY, parentCategoryId: null }),
      }),
    );
    expect(auditActions(db)).toContain('asset.category.created');
  });

  it('refuses a duplicate name at the same level', async () => {
    db.assetCategory.findFirst.mockResolvedValue({ id: 'cat-existing' });

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { name: 'IT Equipment' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.name).toBeTruthy();
    expect(db.assetCategory.create).not.toHaveBeenCalled();
  });

  it('refuses a parent from another company', async () => {
    db.assetCategory.findFirst.mockResolvedValue(null);

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { name: 'Laptop', parentCategoryId: 'cat-somebody-elses' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.parentCategoryId).toBeTruthy();
  });

  it('refuses a third level', async () => {
    db.assetCategory.findFirst.mockResolvedValue({
      id: 'cat-laptop',
      parentCategoryId: 'cat-it',
    });

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: PREFIX,
      payload: { name: 'Ultrabook', parentCategoryId: 'cat-laptop' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.parentCategoryId).toBeTruthy();
    expect(db.assetCategory.create).not.toHaveBeenCalled();
  });
});

describe('retiring a category', () => {
  it('flips isActive and says so in the audit summary', async () => {
    db.assetCategory.findFirst.mockResolvedValue(categoryRow());
    db.assetCategory.update.mockResolvedValue(categoryRow({ isActive: false }));

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/cat-it`,
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(200);
    expect(db.assetCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(auditActions(db)).toContain('asset.category.updated');
    expect(db.auditLog.create.mock.calls[0]?.[0]?.data.summary).toContain('Retired');
  });

  it('answers 404 for a category belonging to another company', async () => {
    db.assetCategory.findFirst.mockResolvedValue(null);

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'PATCH',
      url: `${PREFIX}/cat-elsewhere`,
      payload: { name: 'Mine now' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.assetCategory.update).not.toHaveBeenCalled();
  });

  /*
   * Absent means LEAVE ALONE. Without `.partial()` on the update schema, a
   * PATCH carrying one field would arrive as that field plus explicit nulls,
   * and renaming a category would silently clear its description.
   */
  it('does not clear the fields a PATCH did not mention', async () => {
    db.assetCategory.findFirst
      .mockResolvedValueOnce(categoryRow())
      .mockResolvedValueOnce(null);
    db.assetCategory.update.mockResolvedValue(categoryRow({ name: 'IT Kit' }));

    const app = await appAs(assetCategoryRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'PATCH', url: `${PREFIX}/cat-it`, payload: { name: 'IT Kit' } });

    expect(db.assetCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'IT Kit' } }),
    );
  });
});
