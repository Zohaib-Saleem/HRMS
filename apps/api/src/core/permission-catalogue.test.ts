import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '@hrms/shared';

/**
 * The permission catalogue sync, and the one property that makes it safe to
 * run unattended at every boot: it adds and never takes away.
 *
 * The sync exists because a migration that introduces a permission grants it
 * to nobody, so the screens behind it vanish - which is how the loans and
 * contracts tabs came to be missing from a deployed build that contained them.
 * The fix is only worth having if it cannot itself cause the opposite problem:
 * a boot that quietly strips an administrator's configuration. So what is
 * asserted here is the shape of the writes, not just their effect - that the
 * only mutations issued are inserts and label upserts, against exactly two
 * tables, and that a role which has had a default deliberately removed does
 * not get it back.
 */

const state = vi.hoisted(() => ({
  permissions: [] as Array<{ id: string; key: string }>,
  roles: [] as Array<{ id: string; name: string }>,
  grants: [] as Array<{ roleId: string; permissionKey: string }>,
  /** Every write the run issued, as `model.operation`. */
  writes: [] as string[],
}));

vi.mock('./db.js', () => {
  const idFor = (key: string) => `perm-${key}`;
  return {
    prisma: {
      permission: {
        findMany: vi.fn(async () => state.permissions.map((p) => ({ ...p }))),
        upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: unknown }) => {
          state.writes.push('permission.upsert');
          if (!state.permissions.some((p) => p.key === where.key)) {
            state.permissions.push({ id: idFor(where.key), key: where.key });
          }
          return create;
        }),
      },
      role: { findMany: vi.fn(async ({ where }: { where: { name: string } }) => state.roles.filter((r) => r.name === where.name)) },
      rolePermission: {
        findMany: vi.fn(async ({ where }: { where: { roleId: string } }) =>
          state.grants
            .filter((g) => g.roleId === where.roleId)
            .map((g) => ({ permission: { key: g.permissionKey } })),
        ),
        createMany: vi.fn(async ({ data }: { data: Array<{ roleId: string; permissionId: string }> }) => {
          state.writes.push('rolePermission.createMany');
          for (const row of data) {
            state.grants.push({ roleId: row.roleId, permissionKey: row.permissionId.replace(/^perm-/, '') });
          }
          return { count: data.length };
        }),
      },
    },
  };
});

const { syncPermissionCatalogue } = await import('./permission-catalogue.js');

function reset(seed: {
  permissions?: string[];
  roles?: Array<{ id: string; name: string }>;
  grants?: Array<{ roleId: string; permissionKey: string }>;
}) {
  state.permissions = (seed.permissions ?? []).map((key) => ({ id: `perm-${key}`, key }));
  state.roles = seed.roles ?? [];
  state.grants = seed.grants ?? [];
  state.writes = [];
}

const heldBy = (roleId: string) =>
  state.grants.filter((g) => g.roleId === roleId).map((g) => g.permissionKey);

afterEach(() => vi.clearAllMocks());

describe('bringing the catalogue up to date', () => {
  it('inserts the permissions the code defines and the database lacks', async () => {
    reset({ permissions: ['employee.read'] });

    const { permissionsAdded } = await syncPermissionCatalogue();

    expect(permissionsAdded).toContain(PERMISSIONS.LOAN_READ);
    expect(permissionsAdded).toContain(PERMISSIONS.LOAN_REQUEST);
    expect(permissionsAdded).toContain(PERMISSIONS.LOAN_MANAGE);
    expect(permissionsAdded).toContain(PERMISSIONS.LOAN_APPROVE);
    // An existing row is not reported as added, however its labels are refreshed.
    expect(permissionsAdded).not.toContain(PERMISSIONS.EMPLOYEE_READ);
  });

  it('grants each system role its own defaults and not another role’s', async () => {
    reset({
      roles: [
        { id: 'r-super', name: 'Super Admin' },
        { id: 'r-employee', name: 'Employee' },
      ],
    });

    await syncPermissionCatalogue();

    // The whole point: an administrator can approve a loan, an employee cannot.
    expect(heldBy('r-super')).toEqual(expect.arrayContaining([
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.LOAN_REQUEST,
      PERMISSIONS.LOAN_MANAGE,
      PERMISSIONS.LOAN_APPROVE,
    ]));
    expect(heldBy('r-employee')).toEqual(expect.arrayContaining([
      PERMISSIONS.LOAN_READ,
      PERMISSIONS.LOAN_REQUEST,
    ]));
    expect(heldBy('r-employee')).not.toContain(PERMISSIONS.LOAN_MANAGE);
    expect(heldBy('r-employee')).not.toContain(PERMISSIONS.LOAN_APPROVE);
  });

  it('grants a role of the same name in every company', async () => {
    reset({
      roles: [
        { id: 'r-a', name: 'Employee' },
        { id: 'r-b', name: 'Employee' },
      ],
    });

    await syncPermissionCatalogue();

    expect(heldBy('r-a')).toContain(PERMISSIONS.LOAN_READ);
    expect(heldBy('r-b')).toContain(PERMISSIONS.LOAN_READ);
  });

  it('leaves a custom role entirely alone', async () => {
    reset({ roles: [{ id: 'r-custom', name: 'Payroll Auditor' }] });

    const { grantsAdded } = await syncPermissionCatalogue();

    expect(grantsAdded).toEqual([]);
    expect(heldBy('r-custom')).toEqual([]);
  });
});

describe('what the sync must never do', () => {
  it('does not restore a default an administrator removed', async () => {
    reset({ roles: [{ id: 'r-super', name: 'Super Admin' }] });
    // First boot after the release: the role is empty, so it gets everything.
    await syncPermissionCatalogue();
    expect(heldBy('r-super')).toContain(PERMISSIONS.LOAN_APPROVE);

    // An administrator then decides Super Admin should not approve loans.
    state.grants = state.grants.filter((g) => g.permissionKey !== PERMISSIONS.LOAN_APPROVE);
    state.writes = [];

    // Every subsequent boot must leave that decision standing.
    await syncPermissionCatalogue();
    await syncPermissionCatalogue();

    expect(heldBy('r-super')).not.toContain(PERMISSIONS.LOAN_APPROVE);
    expect(state.writes).not.toContain('rolePermission.createMany');
  });

  it('gives a configured role the defaults for a permission the release adds', async () => {
    // The state that caused the bug: a working installation, configured, whose
    // catalogue predates the loans release.
    const existing = Object.values(PERMISSIONS).filter((p) => !p.startsWith('loan.'));
    reset({
      permissions: existing,
      roles: [{ id: 'r-super', name: 'Super Admin' }],
      grants: existing.map((permissionKey) => ({ roleId: 'r-super', permissionKey })),
    });

    const { permissionsAdded } = await syncPermissionCatalogue();

    expect(permissionsAdded).toEqual(
      expect.arrayContaining([PERMISSIONS.LOAN_READ, PERMISSIONS.LOAN_APPROVE]),
    );
    expect(heldBy('r-super')).toEqual(
      expect.arrayContaining([
        PERMISSIONS.LOAN_READ,
        PERMISSIONS.LOAN_REQUEST,
        PERMISSIONS.LOAN_MANAGE,
        PERMISSIONS.LOAN_APPROVE,
      ]),
    );
  });

  it('does not hand a configured Employee role a permission that is not its default', async () => {
    const existing = Object.values(PERMISSIONS).filter((p) => !p.startsWith('loan.'));
    reset({
      permissions: existing,
      roles: [{ id: 'r-employee', name: 'Employee' }],
      grants: [{ roleId: 'r-employee', permissionKey: PERMISSIONS.PAYSLIP_READ }],
    });

    await syncPermissionCatalogue();

    // The loans release reaches them as read + request, and nothing more.
    expect(heldBy('r-employee')).toContain(PERMISSIONS.LOAN_READ);
    expect(heldBy('r-employee')).toContain(PERMISSIONS.LOAN_REQUEST);
    expect(heldBy('r-employee')).not.toContain(PERMISSIONS.LOAN_MANAGE);
    expect(heldBy('r-employee')).not.toContain(PERMISSIONS.LOAN_APPROVE);
  });

  it('issues no delete, update or upsert against grants - only inserts', async () => {
    reset({ roles: [{ id: 'r-super', name: 'Super Admin' }] });

    await syncPermissionCatalogue();

    // Two tables, two kinds of write. Anything else would be a way to lose data.
    expect(new Set(state.writes)).toEqual(
      new Set(['permission.upsert', 'rolePermission.createMany']),
    );
  });

  it('is a no-op on a second run', async () => {
    reset({ roles: [{ id: 'r-super', name: 'Super Admin' }] });
    await syncPermissionCatalogue();
    const after = heldBy('r-super').sort();

    state.writes = [];
    const { permissionsAdded, grantsAdded } = await syncPermissionCatalogue();

    expect(permissionsAdded).toEqual([]);
    expect(grantsAdded).toEqual([]);
    expect(heldBy('r-super').sort()).toEqual(after);
    // The label refresh still runs; no grant is written.
    expect(state.writes).not.toContain('rolePermission.createMany');
  });
});

describe('the defaults the loans screens depend on', () => {
  it('gives every role that should read loans exactly the loan rights it needs', () => {
    // Read from the catalogue itself, so this fails if the defaults regress.
    const of = (role: keyof typeof DEFAULT_ROLE_PERMISSIONS) => DEFAULT_ROLE_PERMISSIONS[role];

    for (const role of ['SUPER_ADMIN', 'HR_ADMIN'] as const) {
      expect(of(role)).toContain(PERMISSIONS.LOAN_READ);
      expect(of(role)).toContain(PERMISSIONS.LOAN_MANAGE);
      expect(of(role)).toContain(PERMISSIONS.LOAN_APPROVE);
    }

    // A manager and an employee may see loans and ask for one. Neither may
    // approve: a manager decides through the approvals queue, which is a
    // different permission, and an employee decides nothing.
    for (const role of ['MANAGER', 'EMPLOYEE'] as const) {
      expect(of(role)).toContain(PERMISSIONS.LOAN_READ);
      expect(of(role)).toContain(PERMISSIONS.LOAN_REQUEST);
      expect(of(role)).not.toContain(PERMISSIONS.LOAN_MANAGE);
      expect(of(role)).not.toContain(PERMISSIONS.LOAN_APPROVE);
    }
  });
});
