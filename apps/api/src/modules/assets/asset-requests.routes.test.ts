import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Asking for equipment, and - separately - being given it.
 *
 * THE CLAIM THIS FILE EXISTS FOR, in one sentence: the person who looks after
 * the laptops cannot approve the request for one.
 *
 * It is asserted three ways, because one way would be a coincidence:
 *
 *   - the IT Asset Manager role does not hold `approval.act` at all;
 *   - the fulfilment endpoint refuses a request the chain has not finished;
 *   - there is no approve endpoint in the module to hold wrongly.
 *
 * The permission sets are read off `DEFAULT_ROLE_PERMISSIONS` rather than
 * written by hand, so that handing the IT role an approval grant tomorrow
 * fails here rather than shipping.
 */

const db = vi.hoisted(() => ({
  assetRequest: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  assetRequestItem: { update: vi.fn() },
  assetCategory: { findMany: vi.fn() },
  asset: { findFirst: vi.fn(), updateMany: vi.fn() },
  assetAssignment: { create: vi.fn() },
  employee: { findFirst: vi.fn(), findMany: vi.fn() },
  approvalRequest: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  approvalStep: { findFirst: vi.fn() },
  approvalWorkflow: { findFirst: vi.fn() },
  teamManager: { findMany: vi.fn() },
  approvalStageAssignee: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  notification: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { assetRequestRoutes } = await import('./asset-requests.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const COMPANY = 'company-1';

const EMPLOYEE = DEFAULT_ROLE_PERMISSIONS.EMPLOYEE as Permission[];
const IT_ASSET_MANAGER = DEFAULT_ROLE_PERMISSIONS.IT_ASSET_MANAGER as Permission[];

const REQUESTER = {
  id: 'emp-ayesha',
  firstName: 'Ayesha',
  lastName: 'Khan',
  displayName: null,
  userId: 'user-ayesha',
  status: 'ACTIVE',
  employeeNumber: 'GE-014',
  // On a team, which is what puts the Team Manager rung at the top of her
  // chain. An employee on no team gets a chain that skips it and says so.
  teamId: 'team-dev',
  managerId: 'emp-line',
  secondaryManagerId: null,
  department: { headEmployeeId: 'emp-head' },
  team: { name: 'Development' },
};

/** One line of a request, with the handovers that have fulfilled it so far. */
interface ItemFixture {
  id: string;
  categoryId: string;
  quantity: number;
  notes: string | null;
  declinedAt: Date | null;
  declineReason: string | null;
  category: { id: string; name: string };
  assignments: Array<{
    id: string;
    assignedAt: Date;
    asset: { id: string; assetTag: string; name: string };
  }>;
}

const ITEM: ItemFixture = {
  id: 'item-1',
  categoryId: 'cat-laptop',
  quantity: 1,
  notes: null,
  declinedAt: null,
  declineReason: null,
  category: { id: 'cat-laptop', name: 'Laptop' },
  assignments: [],
};

const requestRow = (status: string, items: ItemFixture[] = [ITEM]) => ({
  id: 'req-1',
  companyId: COMPANY,
  employeeId: REQUESTER.id,
  status,
  justification: 'My machine will not run the build any more.',
  neededBy: null,
  approvalRequestId: 'appr-1',
  decidedAt: null,
  cancelledAt: null,
  fulfilledAt: null,
  createdAt: new Date('2026-09-20T09:00:00Z'),
  employee: REQUESTER,
  items,
});

async function appAs(permissions: Permission[], userId = 'user-it'): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId,
      companyId: COMPANY,
      email: 'someone@example.com',
      permissions: new Set(permissions),
      dataScope: 'OWN',
      mustChangePassword: false,
    };
  });
  await app.register(assetRequestRoutes, { prefix: '/asset-requests' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.employee.findFirst.mockResolvedValue(REQUESTER);
  db.employee.findMany.mockImplementation((args: { where?: { id?: { in?: string[] } } }) =>
    Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id }))),
  );
  db.assetCategory.findMany.mockResolvedValue([{ id: 'cat-laptop', name: 'Laptop' }]);
  db.approvalWorkflow.findFirst.mockResolvedValue(null);
  db.teamManager.findMany.mockResolvedValue([{ employeeId: 'mgr-a' }]);
  db.approvalStageAssignee.findMany.mockImplementation(({ where }: { where: { stage: string } }) =>
    Promise.resolve(
      where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : [{ employeeId: 'emp-ceo' }],
    ),
  );
  db.assetRequest.create.mockResolvedValue({ id: 'req-1' });
  db.assetRequest.update.mockResolvedValue({ id: 'req-1' });
  db.assetRequest.updateMany.mockResolvedValue({ count: 1 });
  db.assetRequest.findMany.mockResolvedValue([]);
  db.assetRequest.count.mockResolvedValue(0);
  db.approvalRequest.create.mockResolvedValue({ id: 'appr-1', steps: [{ stepOrder: 1 }] });
  db.approvalRequest.findMany.mockResolvedValue([]);
  db.approvalStep.findFirst.mockResolvedValue(null);
  db.auditLog.create.mockResolvedValue({});
  db.notification.create.mockResolvedValue({});
});

describe('raising a request', () => {
  it('routes it through the hierarchy: team manager, HR, CEO', async () => {
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests',
      payload: {
        justification: 'My machine will not run the build any more.',
        items: [{ categoryId: 'cat-laptop', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const approval = db.approvalRequest.create.mock.calls[0]?.[0] as {
      data: { subjectType: string; steps: { create: Array<{ stage: string; mode: string }> } };
    };
    expect(approval.data.subjectType).toBe('ASSET_REQUEST');
    expect(approval.data.steps.create.map((s) => s.stage)).toEqual([
      'TEAM_MANAGER',
      'HR_MANAGER',
      'CEO',
    ]);
  });

  it('files it against the caller, ignoring an employee id in the body', async () => {
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    await app.inject({
      method: 'POST',
      url: '/asset-requests',
      payload: {
        justification: 'My machine will not run the build any more.',
        items: [{ categoryId: 'cat-laptop', quantity: 1 }],
        employeeId: 'emp-somebody-else',
      },
    });

    const created = db.assetRequest.create.mock.calls[0]?.[0] as { data: { employeeId: string } };
    expect(created.data.employeeId).toBe(REQUESTER.id);
  });

  it('starts PENDING - asking for a laptop is not being given one', async () => {
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    await app.inject({
      method: 'POST',
      url: '/asset-requests',
      payload: {
        justification: 'My machine will not run the build any more.',
        items: [{ categoryId: 'cat-laptop', quantity: 1 }],
      },
    });

    const created = db.assetRequest.create.mock.calls[0]?.[0] as { data: { status: string } };
    expect(created.data.status).toBe('PENDING');
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses a category that does not exist, and writes nothing', async () => {
    db.assetCategory.findMany.mockResolvedValue([]);
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests',
      payload: {
        justification: 'My machine will not run the build any more.',
        items: [{ categoryId: 'cat-nonsense', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(db.assetRequest.create).not.toHaveBeenCalled();
  });

  /**
   * A chain that cannot be filled is refused BEFORE anything is written.
   *
   * The leave module learned this the hard way: a request row committed beside
   * an empty chain is a request nobody can decide and nobody can withdraw.
   */
  it('refuses a request nobody could approve, and files nothing', async () => {
    db.teamManager.findMany.mockResolvedValue([]);
    db.approvalStageAssignee.findMany.mockResolvedValue([]);
    db.employee.findFirst.mockResolvedValue({
      ...REQUESTER,
      teamId: null,
      managerId: null,
      secondaryManagerId: null,
      department: null,
    });
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests',
      payload: {
        justification: 'My machine will not run the build any more.',
        items: [{ categoryId: 'cat-laptop', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(db.assetRequest.create).not.toHaveBeenCalled();
  });
});

describe('approval and fulfilment are different jobs', () => {
  /** The role, as the product defines it. Not a fixture - the real list. */
  it('gives the IT Asset Manager no power to decide an approval', () => {
    const held = new Set<Permission>(IT_ASSET_MANAGER);

    expect(held.has(PERMISSIONS.APPROVAL_ACT)).toBe(false);
    expect(held.has(PERMISSIONS.APPROVAL_MANAGE)).toBe(false);
    // And what they DO hold is the carrying-out half.
    expect(held.has(PERMISSIONS.ASSET_REQUEST_FULFIL)).toBe(true);
    expect(held.has(PERMISSIONS.ASSET_ASSIGN)).toBe(true);
  });

  it('refuses to issue anything against a request the chain has not finished', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('PENDING'));
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/fulfil',
      payload: {
        itemId: 'item-1',
        assetId: 'asset-1',
        conditionAtAssignment: 'GOOD',
        assignedOn: '2026-09-21',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/not an approval/i);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('issues the asset once the request is APPROVED, and links it to the line', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('APPROVED'));
    db.asset.findFirst.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'IT-LAP-0042',
      name: 'ThinkPad T14',
      status: 'AVAILABLE',
    });
    db.asset.updateMany.mockResolvedValue({ count: 1 });
    db.assetAssignment.create.mockResolvedValue({ id: 'assign-1' });
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/fulfil',
      payload: {
        itemId: 'item-1',
        assetId: 'asset-1',
        conditionAtAssignment: 'GOOD',
        assignedOn: '2026-09-21',
      },
    });

    expect(response.statusCode).toBe(201);
    const assignment = db.assetAssignment.create.mock.calls[0]?.[0] as {
      data: { assetRequestItemId: string; employeeId: string; status: string };
    };
    expect(assignment.data.assetRequestItemId).toBe('item-1');
    // Issued to the person who asked, never to whoever is signed in.
    expect(assignment.data.employeeId).toBe(REQUESTER.id);
  });

  /** The register's own lock, borrowed rather than reimplemented. */
  it('claims the asset with the same conditional update the register uses', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('APPROVED'));
    db.asset.findFirst.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'IT-LAP-0042',
      name: 'ThinkPad T14',
      status: 'AVAILABLE',
    });
    db.asset.updateMany.mockResolvedValue({ count: 0 });
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/fulfil',
      payload: {
        itemId: 'item-1',
        assetId: 'asset-1',
        conditionAtAssignment: 'GOOD',
        assignedOn: '2026-09-21',
      },
    });

    // Somebody else got there first: one assignment, one 409.
    expect(response.statusCode).toBe(409);
    expect(db.assetAssignment.create).not.toHaveBeenCalled();
  });

  it('marks the request delivered only when every line is settled', async () => {
    const settled = {
      ...ITEM,
      assignments: [{ id: 'a1', assignedAt: new Date(), asset: { id: 'asset-1', assetTag: 'T', name: 'T' } }],
    };
    db.assetRequest.findFirst
      .mockResolvedValueOnce(requestRow('APPROVED'))
      .mockResolvedValue(requestRow('APPROVED', [settled]));
    db.asset.findFirst.mockResolvedValue({
      id: 'asset-1',
      assetTag: 'IT-LAP-0042',
      name: 'ThinkPad T14',
      status: 'AVAILABLE',
    });
    db.asset.updateMany.mockResolvedValue({ count: 1 });
    db.assetAssignment.create.mockResolvedValue({ id: 'assign-1' });
    const app = await appAs(IT_ASSET_MANAGER);

    await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/fulfil',
      payload: {
        itemId: 'item-1',
        assetId: 'asset-1',
        conditionAtAssignment: 'GOOD',
        assignedOn: '2026-09-21',
      },
    });

    expect(db.assetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req-1', status: 'APPROVED' },
        data: expect.objectContaining({ status: 'FULFILLED' }),
      }),
    );
  });

  it('refuses an employee who holds no fulfilment grant', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('APPROVED'));
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/fulfil',
      payload: {
        itemId: 'item-1',
        assetId: 'asset-1',
        conditionAtAssignment: 'GOOD',
        assignedOn: '2026-09-21',
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('declining a line the company cannot supply', () => {
  it('records the reason and settles the request', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('APPROVED'));
    db.assetRequestItem.update.mockResolvedValue({});
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/decline-item',
      payload: { itemId: 'item-1', reason: 'No spare monitors until April.' },
    });

    expect(response.statusCode).toBe(200);
    const call = db.assetRequestItem.update.mock.calls[0]?.[0] as {
      data: { declineReason: string };
    };
    expect(call.data.declineReason).toBe('No spare monitors until April.');
  });

  it('refuses to decline a line on a request still in the chain', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('PENDING'));
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/decline-item',
      payload: { itemId: 'item-1', reason: 'We have none.' },
    });

    // Declining is not rejecting. Only the chain rejects.
    expect(response.statusCode).toBe(409);
    expect(db.assetRequestItem.update).not.toHaveBeenCalled();
  });

  it('insists on a reason', async () => {
    db.assetRequest.findFirst.mockResolvedValue(requestRow('APPROVED'));
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({
      method: 'POST',
      url: '/asset-requests/req-1/decline-item',
      payload: { itemId: 'item-1', reason: '' },
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('who sees which requests', () => {
  it('serves the asset manager the whole queue', async () => {
    const app = await appAs(IT_ASSET_MANAGER);

    const response = await app.inject({ method: 'GET', url: '/asset-requests?view=queue' });

    expect(response.statusCode).toBe(200);
    const where = (db.assetRequest.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toContainEqual({ status: 'APPROVED' });
  });

  /**
   * An employee's list is their own, whatever the query string says.
   *
   * `view=queue` is served only to somebody who may see every request - a
   * queue narrowed to one person is not a queue - so asking for it as an
   * employee falls back to their own scope rather than widening anything.
   */
  it('ignores a queue view asked for by somebody who cannot see every request', async () => {
    const app = await appAs(EMPLOYEE, 'user-ayesha');

    const response = await app.inject({ method: 'GET', url: '/asset-requests?view=queue' });

    expect(response.statusCode).toBe(200);
    const where = (db.assetRequest.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toContainEqual({ OR: [{ employeeId: REQUESTER.id }, { employee: { id: REQUESTER.id } }] });
    expect(where.AND).not.toContainEqual({ status: 'APPROVED' });
  });
});
