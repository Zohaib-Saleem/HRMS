import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, TEAM_MANAGER_MAX, type Permission } from '@hrms/shared';

/**
 * The roster that decides who manages a team.
 *
 * Four rules, all of them enforced on the server because none of them can be
 * enforced anywhere else:
 *
 *   1. AT MOST THREE active managers.
 *   2. NOBODY WHO HAS LEFT can hold an active appointment.
 *   3. An appointment ENDS, it is never deleted.
 *   4. A REPLACEMENT is one atomic act, and works on a team already at three.
 */

const db = vi.hoisted(() => ({
  team: { findFirst: vi.fn() },
  employee: { findFirst: vi.fn() },
  teamManager: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  user: { findMany: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { teamManagerRoutes } = await import('./team-managers.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const COMPANY = 'company-1';
const HR: Permission[] = [PERMISSIONS.TEAM_READ, PERMISSIONS.TEAM_MANAGE];
const READER: Permission[] = [PERMISSIONS.TEAM_READ];

const TEAM = {
  id: 'team-dev',
  companyId: COMPANY,
  name: 'Development',
  _count: { employees: 8 },
};

const employeeRow = (id: string, status = 'ACTIVE') => ({
  id,
  firstName: 'Manager',
  lastName: id.slice(-1).toUpperCase(),
  displayName: null,
  employeeNumber: `GE-${id.slice(-3)}`,
  status,
  userId: `user-${id}`,
  designation: { name: 'Engineering Manager' },
});

const managerRow = (id: string, isActive = true) => ({
  id: `tm-${id}`,
  teamId: TEAM.id,
  isActive,
  assignedAt: new Date('2026-01-01T00:00:00Z'),
  endedAt: isActive ? null : new Date('2026-06-01T00:00:00Z'),
  endReason: isActive ? null : 'Left the company',
  team: { id: TEAM.id, name: TEAM.name },
  employee: employeeRow(id),
});

async function appAs(permissions: Permission[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-hr',
      companyId: COMPANY,
      email: 'hr@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(teamManagerRoutes, { prefix: '/teams' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.team.findFirst.mockResolvedValue(TEAM);
  db.teamManager.findMany.mockResolvedValue([]);
  db.teamManager.count.mockResolvedValue(0);
  db.teamManager.upsert.mockImplementation(({ create }: { create: { employeeId: string } }) =>
    Promise.resolve(managerRow(create.employeeId)),
  );
  db.teamManager.update.mockResolvedValue({});
  db.user.findMany.mockResolvedValue([]);
  db.auditLog.create.mockResolvedValue({});
  db.employee.findFirst.mockImplementation(({ where }: { where: { id?: string } }) =>
    Promise.resolve(where.id ? employeeRow(where.id) : { id: 'emp-hr' }),
  );
});

describe('the roster', () => {
  it('shows who runs the team now and who used to', async () => {
    db.teamManager.findMany.mockResolvedValue([managerRow('emp-a'), managerRow('emp-old', false)]);
    const app = await appAs(READER);

    const response = await app.inject({ method: 'GET', url: '/teams/team-dev/managers' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { managers: unknown[]; formerManagers: unknown[]; canManage: boolean };
    };
    expect(body.data.managers).toHaveLength(1);
    expect(body.data.formerManagers).toHaveLength(1);
    // Read-only caller: the screen must not offer controls the server refuses.
    expect(body.data.canManage).toBe(false);
  });

  /**
   * The gap this feature is most likely to fall into.
   *
   * An appointment and a role are separate facts. Somebody made a manager on
   * this screen sees nothing of their team until a role they hold carries
   * `team.data.read` - so the roster reports whether each manager's login
   * actually does, rather than leaving it to be discovered.
   */
  it('reports whether each manager’s login can actually see the team', async () => {
    db.teamManager.findMany.mockResolvedValue([managerRow('emp-a'), managerRow('emp-b')]);
    db.user.findMany.mockResolvedValue([{ id: 'user-emp-a' }]);
    const app = await appAs(HR);

    const response = await app.inject({ method: 'GET', url: '/teams/team-dev/managers' });

    const body = response.json() as { data: { managers: Array<{ hasTeamDataAccess: boolean }> } };
    expect(body.data.managers.map((m) => m.hasTeamDataAccess)).toEqual([true, false]);
  });

  it('refuses a caller who cannot read teams at all', async () => {
    const app = await appAs([]);

    const response = await app.inject({ method: 'GET', url: '/teams/team-dev/managers' });

    expect(response.statusCode).toBe(403);
  });
});

describe('appointing a manager', () => {
  it('writes the appointment explicitly, against the team', async () => {
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-a' },
    });

    expect(response.statusCode).toBe(201);
    const call = db.teamManager.upsert.mock.calls[0]?.[0] as {
      create: { teamId: string; employeeId: string; isActive: boolean };
    };
    expect(call.create).toMatchObject({ teamId: 'team-dev', employeeId: 'emp-a', isActive: true });
  });

  it('refuses a fourth manager', async () => {
    db.teamManager.count.mockResolvedValue(TEAM_MANAGER_MAX);
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-d' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain(String(TEAM_MANAGER_MAX));
    expect(db.teamManager.upsert).not.toHaveBeenCalled();
  });

  /** Counted inside the transaction, not read before it. */
  it('counts the ceiling inside the same transaction as the write', async () => {
    const app = await appAs(HR);

    await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-a' },
    });

    expect(db.$transaction).toHaveBeenCalled();
    expect(db.teamManager.count).toHaveBeenCalledWith({
      where: { teamId: 'team-dev', isActive: true, employeeId: { not: 'emp-a' } },
    });
  });

  it('refuses somebody who has left the company', async () => {
    db.employee.findFirst.mockResolvedValue(employeeRow('emp-gone', 'TERMINATED'));
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-gone' },
    });

    expect(response.statusCode).toBe(422);
    expect(db.teamManager.upsert).not.toHaveBeenCalled();
  });

  it('refuses somebody who is resigning, who will not be here to approve', async () => {
    db.employee.findFirst.mockResolvedValue(employeeRow('emp-notice', 'RESIGNED'));
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-notice' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller who may read teams but not manage them', async () => {
    const app = await appAs(READER);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers',
      payload: { employeeId: 'emp-a' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('ending and replacing an appointment', () => {
  it('ends the row rather than deleting it, with a reason', async () => {
    db.teamManager.findFirst.mockResolvedValue(managerRow('emp-a'));
    db.teamManager.count.mockResolvedValue(0);
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers/emp-a/remove',
      payload: { reason: 'Left the company' },
    });

    expect(response.statusCode).toBe(200);
    const call = db.teamManager.update.mock.calls[0]?.[0] as {
      data: { isActive: boolean; endReason: string; endedAt: Date };
    };
    expect(call.data.isActive).toBe(false);
    expect(call.data.endReason).toBe('Left the company');
    expect(call.data.endedAt).toBeInstanceOf(Date);
  });

  /**
   * Allowed to leave a team with nobody.
   *
   * The floor of one is advisory and has to be: a team whose only manager
   * resigned this morning must be allowed to exist for the hour it takes to
   * name a successor, and refusing the removal would leave the leaver
   * approving that team's leave in the meantime. What the company loses is the
   * Team Manager rung for that team, which the chain skips and says so.
   */
  it('allows the last manager to be removed', async () => {
    db.teamManager.findFirst.mockResolvedValue(managerRow('emp-a'));
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers/emp-a/remove',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  it('replaces one manager with another in a single transaction', async () => {
    db.teamManager.findFirst.mockResolvedValue(managerRow('emp-a'));
    db.teamManager.count.mockResolvedValue(TEAM_MANAGER_MAX);
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers/replace',
      payload: { outgoingEmployeeId: 'emp-a', incomingEmployeeId: 'emp-d', reason: 'Resigned' },
    });

    // A team already at the ceiling can still be handed a replacement: the
    // count is level throughout, which is why this is one endpoint.
    expect(response.statusCode).toBe(200);
    expect(db.teamManager.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }),
    );
    expect(db.teamManager.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ employeeId: 'emp-d' }) }),
    );
  });

  it('refuses a replacement for somebody who does not manage the team', async () => {
    db.teamManager.findFirst.mockResolvedValue(null);
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers/replace',
      payload: { outgoingEmployeeId: 'emp-x', incomingEmployeeId: 'emp-d' },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a replacement by somebody who has left', async () => {
    db.employee.findFirst.mockResolvedValue(employeeRow('emp-gone', 'TERMINATED'));
    const app = await appAs(HR);

    const response = await app.inject({
      method: 'POST',
      url: '/teams/team-dev/managers/replace',
      payload: { outgoingEmployeeId: 'emp-a', incomingEmployeeId: 'emp-gone' },
    });

    expect(response.statusCode).toBe(422);
  });
});
