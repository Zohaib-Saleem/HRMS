import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { UNASSIGNED_TEAM_ID } from '@hrms/shared';
import { summariseByTeam, teamFilterClause } from './team-attendance.service.js';

/**
 * Read-only checks against a real database.
 *
 * These assert the mapping chain the team report depends on:
 *
 *     raw punch.deviceUserId -> device user mapping -> employee -> team
 *
 * Nothing here writes. The suite is skipped when the database cannot be reached
 * so the unit tests still run anywhere.
 */
const url = process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/**
 * A configured URL is not a reachable database.
 *
 * Vitest loads `.env`, so DATABASE_URL is set on practically every run - and in
 * this repo it names `hrms-db`, a host that resolves only inside the compose
 * network. Guarding on "is it configured?" therefore skipped nothing and turned
 * `npm test` red in any shell outside the container, burying the unit results
 * under seven connection errors. So the guard asks the question that actually
 * decides whether these assertions can run.
 *
 * `$connect` opens the connection and issues no statement: the probe itself
 * reads nothing and writes nothing.
 */
const reachable = await (async (): Promise<boolean> => {
  if (!prisma) return false;
  try {
    await prisma.$connect();
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await prisma?.$disconnect();
});

describe.skipIf(!reachable)('team attendance against the live schema', () => {
  const db = () => prisma!;

  it('resolves every device PIN to exactly one employee', async () => {
    const mappings = await db().attendanceDeviceUserMapping.findMany({
      select: { deviceId: true, deviceUserId: true, employeeId: true },
    });

    // The unique constraint is (deviceId, deviceUserId); prove it holds in data.
    const seen = new Set<string>();
    for (const m of mappings) {
      const key = `${m.deviceId}:${m.deviceUserId}`;
      expect(seen.has(key), `PIN ${m.deviceUserId} mapped twice`).toBe(false);
      seen.add(key);
      expect(m.employeeId).toBeTruthy();
    }
  });

  it('maps device PINs by PunchCode, never by employee number', async () => {
    // The two are the same for most people and deliberately different for some.
    // Where they differ, the mapping must follow the PIN.
    const mappings = await db().attendanceDeviceUserMapping.findMany({
      select: { deviceUserId: true, employee: { select: { employeeNumber: true } } },
    });
    if (mappings.length === 0) return;

    const divergent = mappings.filter((m) => m.deviceUserId !== m.employee.employeeNumber);
    // If every PIN equalled the employee number the assertion below would be
    // vacuous, so assert the fixture actually exercises the distinction.
    expect(divergent.length).toBeGreaterThan(0);

    const byPin = new Map(mappings.map((m) => [m.deviceUserId, m.employee.employeeNumber]));
    for (const m of divergent) {
      // The employee's own number must not also be a PIN pointing back at them.
      expect(byPin.get(m.employee.employeeNumber)).not.toBe(m.employee.employeeNumber);
    }
  });

  it('resolves every attendance record to an employee, and that employee to a team or null', async () => {
    const records = await db().attendanceRecord.findMany({
      select: {
        employeeId: true,
        employee: { select: { id: true, teamId: true, team: { select: { id: true } } } },
      },
    });

    for (const r of records) {
      expect(r.employee, 'attendance record with no employee').toBeTruthy();
      expect(r.employee.id).toBe(r.employeeId);
      // teamId may be null - that is Unassigned, not an error - but when it is
      // set the relation must resolve to the same team.
      if (r.employee.teamId === null) expect(r.employee.team).toBeNull();
      else expect(r.employee.team?.id).toBe(r.employee.teamId);
    }
  });

  it('filters by team using the employee relation', async () => {
    const team = await db().team.findFirst({ select: { id: true } });
    if (!team) return;

    const filtered = await db().employee.findMany({
      where: { AND: [teamFilterClause(team.id)] },
      select: { teamId: true },
    });
    for (const e of filtered) expect(e.teamId).toBe(team.id);
  });

  it('retains unassigned employees instead of dropping them', async () => {
    const unassigned = await db().employee.findMany({
      where: { AND: [teamFilterClause(UNASSIGNED_TEAM_ID)] },
      select: { id: true, teamId: true },
    });
    for (const e of unassigned) expect(e.teamId).toBeNull();

    const total = await db().employee.count();
    const withTeam = await db().employee.count({ where: { teamId: { not: null } } });
    // Every employee is either on a team or unassigned. Nobody falls between.
    expect(unassigned.length + withTeam).toBe(total);

    // And the summary keeps them: an unassigned roster still produces a bucket.
    if (unassigned.length > 0) {
      const rows = summariseByTeam(
        unassigned.map(() => ({ teamId: null, teamName: null, departmentName: null, days: [] })),
      );
      expect(rows).toHaveLength(1);
      const [bucket] = rows;
      expect(bucket?.teamId).toBeNull();
      expect(bucket?.employees).toBe(unassigned.length);
    }
  });

  it('every employee appears in exactly one summary bucket', async () => {
    const employees = await db().employee.findMany({
      select: { teamId: true, team: { select: { name: true } } },
    });
    const rows = summariseByTeam(
      employees.map((e) => ({
        teamId: e.teamId,
        teamName: e.team?.name ?? null,
        departmentName: null,
        days: [],
      })),
    );
    expect(rows.reduce((n, r) => n + r.employees, 0)).toBe(employees.length);
  });

  it('does not change existing attendance data', async () => {
    // The whole feature is a read. Snapshot the numbers that must not move,
    // exercise the grouping, and compare.
    const before = {
      records: await db().attendanceRecord.count(),
      punches: await db().attendanceRawPunch.count(),
      attributed: await db().attendanceRawPunch.count({ where: { employeeId: { not: null } } }),
      processed: await db().attendanceRawPunch.count({ where: { processedAt: { not: null } } }),
    };

    const employees = await db().employee.findMany({
      select: { teamId: true, team: { select: { name: true } } },
    });
    summariseByTeam(
      employees.map((e) => ({
        teamId: e.teamId,
        teamName: e.team?.name ?? null,
        departmentName: null,
        days: [],
      })),
    );

    const after = {
      records: await db().attendanceRecord.count(),
      punches: await db().attendanceRawPunch.count(),
      attributed: await db().attendanceRawPunch.count({ where: { employeeId: { not: null } } }),
      processed: await db().attendanceRawPunch.count({ where: { processedAt: { not: null } } }),
    };

    expect(after).toEqual(before);
  });
});
