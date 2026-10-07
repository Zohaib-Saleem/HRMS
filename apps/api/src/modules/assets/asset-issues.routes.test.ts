import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * The asset issue queue.
 *
 * What is pinned: reading it is `asset.read.all` and closing an issue is
 * `asset.update`, so the IT Asset Manager and a Super Admin can work it and an
 * employee cannot see it at all; it lists employee reports only, oldest open
 * first; and an issue is resolved once - the second attempt is refused rather
 * than writing a second note over the first.
 */

const kit = await vi.hoisted(async () => import('./assets.test-kit.js'));
const db = kit.assetDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetIssueRoutes } = await import('./asset-issues.routes.js');
const { AHMED, COMPANY, appAs, auditActions, useAssetDb, wirePeople } = kit;

const PREFIX = '/assets';
const IT = DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER as Permission[];
const SUPER_ADMIN = DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN as Permission[];
const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE as Permission[];

const issue = (overrides: Record<string, unknown> = {}) => ({
  id: 'incident-1',
  companyId: COMPANY,
  assetId: 'asset-1',
  assignmentId: `assign-${AHMED.id}`,
  kind: 'ISSUE_REPORTED',
  occurredOn: new Date('2026-10-07T00:00:00.000Z'),
  reason: 'Charger does not work',
  description: null,
  notes: null,
  reportedById: AHMED.userId,
  reportedByEmployeeId: AHMED.id,
  resolvedAt: null,
  resolvedById: null,
  resolutionNotes: null,
  createdAt: new Date('2026-10-07T05:00:00.000Z'),
  updatedAt: new Date('2026-10-07T05:00:00.000Z'),
  reportedBy: null,
  reportedByEmployee: { id: AHMED.id, firstName: 'Ahmed', lastName: 'Khan' },
  asset: { id: 'asset-1', assetTag: 'DXT-GE-013', name: 'Core i5 desktop' },
  resolvedBy: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAssetDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.assetIncident.findMany.mockResolvedValue([issue()]);
  db.assetIncident.findFirst.mockResolvedValue(issue());
  db.assetIncident.updateMany.mockResolvedValue({ count: 1 });
  db.assetIncident.findFirstOrThrow.mockResolvedValue(
    issue({
      resolvedAt: new Date('2026-10-07T07:00:00.000Z'),
      resolvedById: 'user-it',
      resolutionNotes: 'Replaced the charger',
      resolvedBy: { id: 'user-it', firstName: 'IT', lastName: 'Manager' },
    }),
  );
});

describe('reading the queue', () => {
  it.each([
    ['the IT Asset Manager', IT],
    ['a Super Admin', SUPER_ADMIN],
  ])('%s sees open employee reports, oldest first', async (_who, permissions) => {
    const app = await appAs(assetIssueRoutes, { prefix: PREFIX, permissions, dataScope: 'OWN' });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/issues` });

    expect(response.statusCode).toBe(200);
    expect(db.assetIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: COMPANY, kind: 'ISSUE_REPORTED', resolvedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(response.json().data[0]).toMatchObject({
      id: 'incident-1',
      status: 'OPEN',
      asset: { assetTag: 'DXT-GE-013' },
      reportedByEmployee: { fullName: 'Ahmed Khan' },
    });
  });

  it('an employee cannot read it', async () => {
    const app = await appAs(assetIssueRoutes, { prefix: PREFIX, permissions: EMPLOYEE, userId: AHMED.userId });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/issues` });

    expect(response.statusCode).toBe(403);
    expect(db.assetIncident.findMany).not.toHaveBeenCalled();
  });

  it('one issue opens by id, within the company', async () => {
    const app = await appAs(assetIssueRoutes, { prefix: PREFIX, permissions: IT });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/issues/incident-1` });

    expect(response.statusCode).toBe(200);
    expect(db.assetIncident.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'incident-1', companyId: COMPANY, kind: 'ISSUE_REPORTED' } }),
    );
  });

  it("another company's issue is a 404", async () => {
    db.assetIncident.findFirst.mockResolvedValue(null);
    const app = await appAs(assetIssueRoutes, { prefix: PREFIX, permissions: SUPER_ADMIN });
    const response = await app.inject({ method: 'GET', url: `${PREFIX}/issues/incident-x` });

    expect(response.statusCode).toBe(404);
  });
});

describe('resolving an issue', () => {
  const resolve = async (permissions: Permission[]) => {
    const app = await appAs(assetIssueRoutes, { prefix: PREFIX, permissions, userId: 'user-it' });
    return app.inject({
      method: 'POST',
      url: `${PREFIX}/issues/incident-1/resolve`,
      payload: { resolutionNotes: 'Replaced the charger' },
    });
  };

  it('the IT Asset Manager closes it, with a note and an audit row', async () => {
    const response = await resolve(IT);

    expect(response.statusCode).toBe(200);
    expect(db.assetIncident.updateMany).toHaveBeenCalledWith({
      where: { id: 'incident-1', resolvedAt: null },
      data: expect.objectContaining({ resolvedById: 'user-it', resolutionNotes: 'Replaced the charger' }),
    });
    expect(response.json().data).toMatchObject({ status: 'RESOLVED', resolvedBy: { fullName: 'IT Manager' } });
    expect(auditActions(db)).toContain('asset.issue.resolved');
  });

  it('a second resolution is refused, not written over the first', async () => {
    db.assetIncident.updateMany.mockResolvedValue({ count: 0 });
    const response = await resolve(IT);

    expect(response.statusCode).toBe(422);
    expect(auditActions(db)).not.toContain('asset.issue.resolved');
  });

  it('an employee cannot resolve one', async () => {
    const response = await resolve(EMPLOYEE);

    expect(response.statusCode).toBe(403);
    expect(db.assetIncident.updateMany).not.toHaveBeenCalled();
  });
});
