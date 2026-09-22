import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission, teamInputSchema } from '@hrms/shared';

/**
 * TEAMS ARE NOT SUB-DEPARTMENTS.
 *
 * Department and Team are two independent dimensions of the organisation. A
 * person is in Development AND on Team Alpha; Team Alpha is not a unit inside
 * Development, and the same team may hold people from several departments.
 *
 * This file pins the four places that used to say otherwise, because each of
 * them was a separate way for the old coupling to come back:
 *
 *   1. The team form REQUIRED a department, so a team that belonged under
 *      none could only be made by inventing a department to hold it.
 *   2. The employee form REFUSED a team whose department was not the one
 *      chosen beside it, and refused a team with no department at all.
 *   3. A team record CARRIED its department to the screen, which is what made
 *      the Teams table read as a list of sub-departments.
 *   4. The team lookup carried a `departmentId` for every form to narrow by.
 */

const db = vi.hoisted(() => ({
  team: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  department: { findFirst: vi.fn(), findMany: vi.fn() },
  designation: { findFirst: vi.fn(), findMany: vi.fn() },
  location: { findFirst: vi.fn(), findMany: vi.fn() },
  employee: { findFirst: vi.fn(), findMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { teamRoutes } = await import('./teams.routes.js');
const { organisationLookups } = await import('./lookup.js');
const { assertReferencesExist } = await import('../employees/employees.service.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const COMPANY = 'company-1';
const MANAGER: Permission[] = [PERMISSIONS.TEAM_READ, PERMISSIONS.TEAM_MANAGE];

/** A stored team, as Prisma hands one back with the route's own include. */
const teamRow = (over: Record<string, unknown> = {}) => ({
  id: 'team-alpha',
  name: 'Team Alpha',
  description: null,
  isActive: true,
  managers: [
    { employee: { id: 'emp-1', firstName: 'Abdul', lastName: 'Aziz', displayName: null } },
  ],
  _count: { employees: 3 },
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

async function app(): Promise<FastifyInstance> {
  const instance = Fastify();
  registerErrorHandler(instance);
  instance.decorateRequest('auth', null);
  instance.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: 'user-hr',
      companyId: COMPANY,
      email: 'hr@example.com',
      permissions: new Set<Permission>(MANAGER),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await instance.register(teamRoutes);
  await instance.ready();
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.auditLog.create.mockResolvedValue({});
});

describe('a team needs a name and nothing else', () => {
  it('accepts a name, a description and a status with no department', () => {
    const parsed = teamInputSchema.parse({
      name: 'Team Alpha',
      description: 'The clan team',
      isActive: true,
    });
    expect(parsed).toEqual({ name: 'Team Alpha', description: 'The clan team', isActive: true });
    expect(parsed).not.toHaveProperty('departmentId');
  });

  it('creates the team without writing a department, even if one is sent', async () => {
    db.team.create.mockResolvedValue(teamRow());

    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/',
      // A stale client - or a curl - still sending the old field. It is
      // dropped rather than stored, so it cannot quietly reinstate the link.
      payload: { name: 'Team Alpha', departmentId: 'dept-development' },
    });

    expect(response.statusCode).toBe(201);
    const written = db.team.create.mock.calls[0]?.[0].data;
    expect(written).toEqual({ name: 'Team Alpha', description: null, isActive: true, companyId: COMPANY });
    expect(written).not.toHaveProperty('departmentId');
    // And no department was looked up to validate, because none is required.
    expect(db.department.findFirst).not.toHaveBeenCalled();
  });

  it('never puts a department on the record it returns', async () => {
    db.team.create.mockResolvedValue(teamRow());

    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/', payload: { name: 'Team Alpha' } });

    const data = response.json().data;
    expect(data).not.toHaveProperty('departmentId');
    expect(data).not.toHaveProperty('departmentName');
    expect(data.managerNames).toEqual(['Abdul Aziz']);
  });

  it('does not offer a department filter on the list', async () => {
    db.team.count.mockResolvedValue(1);
    db.team.findMany.mockResolvedValue([teamRow()]);

    const instance = await app();
    await instance.inject({ method: 'GET', url: '/?departmentId=dept-development' });

    // The query parameter is not part of the schema, so it narrows nothing.
    expect(db.team.findMany.mock.calls[0]?.[0].where).toEqual({ companyId: COMPANY });
  });
});

describe('an employee has a department AND a team', () => {
  const found = (id: string) => ({ id });

  it('accepts a department and a team that have nothing to do with each other', async () => {
    db.department.findFirst.mockResolvedValue(found('dept-development'));
    db.team.findFirst.mockResolvedValue(found('team-alpha'));

    await expect(
      assertReferencesExist(COMPANY, { departmentId: 'dept-development', teamId: 'team-alpha' }),
    ).resolves.toBeUndefined();
  });

  it('accepts a team with no department chosen beside it', async () => {
    db.team.findFirst.mockResolvedValue(found('team-alpha'));

    await expect(assertReferencesExist(COMPANY, { teamId: 'team-alpha' })).resolves.toBeUndefined();
  });

  it('still rejects a team that does not exist', async () => {
    db.team.findFirst.mockResolvedValue(null);

    await expect(assertReferencesExist(COMPANY, { teamId: 'ghost-team' })).rejects.toMatchObject({
      details: { teamId: ['That team does not exist.'] },
    });
  });
});

describe('the lookups every form fills its dropdowns from', () => {
  it('hands back teams with no departmentId to narrow by', async () => {
    db.department.findMany.mockResolvedValue([{ id: 'dept-development', name: 'Development', code: 'DEV' }]);
    db.team.findMany.mockResolvedValue([{ id: 'team-alpha', name: 'Team Alpha' }]);
    db.designation.findMany.mockResolvedValue([]);
    db.location.findMany.mockResolvedValue([]);
    db.employee.findMany.mockResolvedValue([]);

    const lookups = await organisationLookups(COMPANY);

    expect(lookups.teams).toEqual([{ id: 'team-alpha', label: 'Team Alpha' }]);
    expect(lookups.teams[0]).not.toHaveProperty('departmentId');
    // The team query does not reach for the department either.
    expect(db.team.findMany.mock.calls[0]?.[0].select).toEqual({ id: true, name: true });
  });

  it('offers only the people who actually run a team as team managers', async () => {
    db.department.findMany.mockResolvedValue([]);
    db.team.findMany.mockResolvedValue([]);
    db.designation.findMany.mockResolvedValue([]);
    db.location.findMany.mockResolvedValue([]);
    db.employee.findMany
      .mockResolvedValueOnce([{ id: 'emp-1', firstName: 'Abdul', lastName: 'Aziz', employeeNumber: 'GE-001', jobTitle: null }])
      .mockResolvedValueOnce([
        { id: 'emp-1', firstName: 'Abdul', lastName: 'Aziz', teamManagerships: [{ team: { name: 'Team Alpha' } }] },
      ]);

    const lookups = await organisationLookups(COMPANY);

    expect(lookups.managers).toHaveLength(1);
    expect(lookups.teamManagers).toEqual([
      { id: 'emp-1', label: 'Abdul Aziz', secondaryLabel: 'Team Alpha' },
    ]);
  });
});
