import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_SCOPES,
  PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_META,
} from '@hrms/shared';

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
  companies: [] as Array<{ id: string; name: string }>,
  roles: [] as Array<{ id: string; companyId: string; key: string; name: string }>,
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
      company: { findMany: vi.fn(async () => state.companies.map((c) => ({ ...c }))) },
      role: {
        findMany: vi.fn(async ({ where }: { where: { name: string } }) =>
          state.roles.filter((r) => r.name === where.name),
        ),
        findUnique: vi.fn(
          async ({ where }: { where: { companyId_key: { companyId: string; key: string } } }) =>
            state.roles.find(
              (r) =>
                r.companyId === where.companyId_key.companyId && r.key === where.companyId_key.key,
            ) ?? null,
        ),
        create: vi.fn(
          async ({ data }: { data: { companyId: string; key: string; name: string } }) => {
            state.writes.push('role.create');
            const row = { id: `role-${data.companyId}-${data.key}`, ...data };
            state.roles.push(row);
            return row;
          },
        ),
      },
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

/** The seeder's own name-to-key mapping, so a test can name a role in English. */
const KEY_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(SYSTEM_ROLE_META).map(([key, meta]) => [meta.name, key]),
);

function reset(seed: {
  permissions?: string[];
  companies?: Array<{ id: string; name: string }>;
  roles?: Array<{ id: string; name: string; companyId?: string; key?: string }>;
  grants?: Array<{ roleId: string; permissionKey: string }>;
}) {
  state.permissions = (seed.permissions ?? []).map((key) => ({ id: `perm-${key}`, key }));
  state.companies = seed.companies ?? [];
  /*
   * A seeded role is assumed to be the system role of that name unless the case
   * says otherwise, so the existing tests keep describing roles the way they
   * always did - by name - while the creation step sees them as already there.
   */
  state.roles = (seed.roles ?? []).map((r) => ({
    companyId: r.companyId ?? 'c1',
    key: r.key ?? KEY_BY_NAME[r.name] ?? r.name.toUpperCase().replace(/ /g, '_'),
    ...r,
  }));
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

    // Two kinds of write, and nothing that could remove or overwrite a grant.
    expect(new Set(state.writes)).toEqual(
      new Set(['permission.upsert', 'rolePermission.createMany']),
    );
  });

  it('never updates, upserts or deletes a role - only creates one', async () => {
    reset({
      companies: [{ id: 'c1', name: 'GamEmpires' }],
      roles: [{ id: 'r-super', name: 'Super Admin' }],
    });

    await syncPermissionCatalogue();

    // The roles table is writable now, and this is the whole of what it allows.
    expect(state.writes.filter((w) => w.startsWith('role.'))).toEqual(
      state.writes.filter((w) => w === 'role.create'),
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


/**
 * A release that introduces a ROLE has the problem a release that introduces a
 * permission has, one step earlier: nothing in the API creates a role, so a
 * role added after a company was provisioned would exist on new installations
 * and on no existing one, with no way for an administrator to make it by hand.
 */
describe('a system role a release introduced', () => {
  it('creates the role a company is missing, and grants it its defaults', async () => {
    reset({ companies: [{ id: 'c1', name: 'GamEmpires' }] });

    const { rolesCreated } = await syncPermissionCatalogue();

    expect(rolesCreated).toContainEqual({ company: 'GamEmpires', role: 'Office Boy' });

    const officeBoy = state.roles.find((r) => r.key === SYSTEM_ROLES.LUNCH_OPERATOR);
    expect(officeBoy).toBeDefined();
    expect(heldBy(officeBoy!.id)).toEqual(
      expect.arrayContaining([
        PERMISSIONS.LUNCH_COLLECTION_READ,
        PERMISSIONS.LUNCH_PAYMENT_MARK,
        PERMISSIONS.LUNCH_ORDER_FULFIL,
        PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
      ]),
    );
  });

  it('creates the IT Asset Manager on an installation that predates it', async () => {
    /*
     * The migration story for this role, and the reason it needs none: it is a
     * system role, so the boot-time sync creates it in every company that
     * lacks it and grants it its defaults on that same run. Nothing has to be
     * run by hand on any host, and an administrator who has since edited the
     * role keeps their edits - see the "never revoked" tests above.
     */
    reset({ companies: [{ id: 'c1', name: 'GamEmpires' }] });

    const { rolesCreated } = await syncPermissionCatalogue();

    expect(rolesCreated).toContainEqual({ company: 'GamEmpires', role: 'IT Asset Manager' });

    const itRole = state.roles.find((r) => r.key === SYSTEM_ROLES.IT_ASSET_MANAGER);
    expect(itRole).toBeDefined();
    const held = heldBy(itRole!.id);

    // The register, which is the job.
    expect(held).toEqual(
      expect.arrayContaining([
        PERMISSIONS.ASSET_READ,
        PERMISSIONS.ASSET_READ_ALL,
        PERMISSIONS.ASSET_CREATE,
        PERMISSIONS.ASSET_UPDATE,
        PERMISSIONS.ASSET_ASSIGN,
        PERMISSIONS.ASSET_RETURN,
        PERMISSIONS.ASSET_REPAIR,
        PERMISSIONS.ASSET_RETIRE,
        PERMISSIONS.ASSET_REPORT,
      ]),
    );
    // And not the grant that opens the HR screens.
    expect(held).not.toContain(PERMISSIONS.EMPLOYEE_READ);
  });

  it('creates it in every company on the installation', async () => {
    reset({
      companies: [
        { id: 'c1', name: 'GamEmpires' },
        { id: 'c2', name: 'Second Co' },
      ],
    });

    const { rolesCreated } = await syncPermissionCatalogue();

    expect(rolesCreated.filter((r) => r.role === 'Office Boy')).toHaveLength(2);
  });

  it('does not create one the company already has', async () => {
    reset({
      companies: [{ id: 'c1', name: 'GamEmpires' }],
      roles: [
        { id: 'r-ob', companyId: 'c1', key: SYSTEM_ROLES.LUNCH_OPERATOR, name: 'Office Boy' },
      ],
      grants: [{ roleId: 'r-ob', permissionKey: PERMISSIONS.LUNCH_PAYMENT_MARK }],
    });

    const { rolesCreated } = await syncPermissionCatalogue();

    // The other system roles this bare company lacks are created; this one is
    // already there and is left exactly as it is.
    expect(rolesCreated.some((r) => r.role === 'Office Boy')).toBe(false);
    expect(state.roles.filter((r) => r.key === SYSTEM_ROLES.LUNCH_OPERATOR)).toHaveLength(1);
    expect(state.roles.find((r) => r.key === SYSTEM_ROLES.LUNCH_OPERATOR)!.id).toBe('r-ob');
  });

  it('matches on the key, so a renamed role is not duplicated', async () => {
    reset({
      companies: [{ id: 'c1', name: 'GamEmpires' }],
      // The administrator has called it something else. It is still the role.
      roles: [{ id: 'r-ob', companyId: 'c1', key: SYSTEM_ROLES.LUNCH_OPERATOR, name: 'Canteen' }],
    });

    const { rolesCreated } = await syncPermissionCatalogue();

    expect(rolesCreated.some((r) => r.role === 'Office Boy')).toBe(false);
    expect(state.roles.filter((r) => r.key === SYSTEM_ROLES.LUNCH_OPERATOR)).toHaveLength(1);
  });

  it('creates nothing on a second run', async () => {
    reset({ companies: [{ id: 'c1', name: 'GamEmpires' }] });
    await syncPermissionCatalogue();

    state.writes = [];
    const { rolesCreated } = await syncPermissionCatalogue();

    expect(rolesCreated).toEqual([]);
    expect(state.writes).not.toContain('role.create');
  });
});

describe('what the IT asset manager may and may not do', () => {
  const itManager = DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.IT_ASSET_MANAGER];
  const employee = DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.EMPLOYEE];

  it('is the Employee role plus the register, and nothing else', () => {
    /*
     * The shape of the role in one assertion. Everything it holds beyond an
     * ordinary member of staff is an asset grant - so it cannot quietly become
     * an HR role by acquiring one more line.
     */
    const extra = itManager.filter((p) => !employee.includes(p));
    expect(extra.every((p) => p.startsWith('asset.'))).toBe(true);
    expect(extra.length).toBeGreaterThan(0);

    // And it holds everything an ordinary employee does, so the holder's own
    // attendance, leave, payslip and lunch work exactly as before.
    for (const permission of employee) expect(itManager).toContain(permission);
  });

  it('cannot read the employee directory', () => {
    // The grant behind People, Team attendance, Attendance reports and the
    // Employee Master Report. Picking somebody to hand a laptop to is
    // `/assets/employee-lookup`, which is six fields.
    expect(itManager).not.toContain(PERMISSIONS.EMPLOYEE_READ);
    expect(itManager).not.toContain(PERMISSIONS.EMPLOYEE_SENSITIVE_READ);
  });

  it('cannot reach payroll, salary, or another person’s loan or medical record', () => {
    for (const permission of [
      PERMISSIONS.PAYROLL_READ,
      PERMISSIONS.PAYROLL_MANAGE,
      PERMISSIONS.LOAN_MANAGE,
      PERMISSIONS.LOAN_APPROVE,
      PERMISSIONS.MEDICAL_MANAGE,
      PERMISSIONS.MEDICAL_CLAIM_APPROVE,
    ]) {
      expect(itManager).not.toContain(permission);
    }
  });

  it('cannot manage attendance, leave or devices', () => {
    for (const permission of [
      PERMISSIONS.ATTENDANCE_MANAGE,
      PERMISSIONS.ATTENDANCE_RULES_MANAGE,
      PERMISSIONS.LEAVE_MANAGE,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.DEVICE_MANAGE,
    ]) {
      expect(itManager).not.toContain(permission);
    }
  });

  it('cannot write an asset off for good', () => {
    // Retiring is reversible and is theirs; disposal is not and is not.
    expect(itManager).toContain(PERMISSIONS.ASSET_RETIRE);
    expect(itManager).not.toContain(PERMISSIONS.ASSET_DISPOSE);
  });

  it('sees only its own record, which is what keeps every module above honest', () => {
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.IT_ASSET_MANAGER]).toBe('OWN');
  });

  it('is not protected, so a company can adjust it', () => {
    expect(SYSTEM_ROLE_META[SYSTEM_ROLES.IT_ASSET_MANAGER].isProtected).toBe(false);
  });
});

describe('the roles that already existed are untouched by the new one', () => {
  it('leaves HR Admin holding the HR grants it always held', () => {
    for (const permission of [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_MANAGE,
      PERMISSIONS.EMPLOYEE_SENSITIVE_READ,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.ATTENDANCE_MANAGE,
      PERMISSIONS.PAYROLL_READ,
      PERMISSIONS.PAYROLL_MANAGE,
      PERMISSIONS.ASSET_READ_ALL,
      PERMISSIONS.ASSET_DISPOSE,
    ]) {
      expect(DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.HR_ADMIN]).toContain(permission);
    }
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.HR_ADMIN]).toBe('ALL');
  });

  it('leaves the Manager reading their own reporting line', () => {
    expect(DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.MANAGER]).toContain(PERMISSIONS.EMPLOYEE_READ);
    expect(DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.MANAGER]).toContain(PERMISSIONS.ATTENDANCE_READ);
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.MANAGER]).toBe('REPORTS_AND_OWN');
  });

  it('leaves the Employee role exactly as it was - no asset write of any kind', () => {
    const employeeGrants = DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.EMPLOYEE];
    expect(employeeGrants).toContain(PERMISSIONS.ASSET_READ);
    expect(employeeGrants).toContain(PERMISSIONS.ASSET_ACKNOWLEDGE);
    for (const permission of [
      PERMISSIONS.ASSET_READ_ALL,
      PERMISSIONS.ASSET_CREATE,
      PERMISSIONS.ASSET_UPDATE,
      PERMISSIONS.ASSET_ASSIGN,
      PERMISSIONS.ASSET_TRANSFER,
      PERMISSIONS.ASSET_RETURN,
      PERMISSIONS.ASSET_DISPOSE,
      PERMISSIONS.EMPLOYEE_READ,
    ]) {
      expect(employeeGrants).not.toContain(permission);
    }
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.EMPLOYEE]).toBe('OWN');
  });

  it('leaves Super Admin holding everything, as it must', () => {
    expect(DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.SUPER_ADMIN]).toEqual(ALL_PERMISSIONS);
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.SUPER_ADMIN]).toBe('ALL');
    expect(SYSTEM_ROLE_META[SYSTEM_ROLES.SUPER_ADMIN].isProtected).toBe(true);
  });
});

describe('what the office boy may and may not do', () => {
  const officeBoy = DEFAULT_ROLE_PERMISSIONS[SYSTEM_ROLES.LUNCH_OPERATOR];

  it('runs the lunch round and eats on it', () => {
    for (const permission of [
      PERMISSIONS.LUNCH_COLLECTION_READ,
      PERMISSIONS.LUNCH_PAYMENT_MARK,
      PERMISSIONS.LUNCH_ORDER_FULFIL,
      PERMISSIONS.LUNCH_ORDER_CANCEL_ANY,
      PERMISSIONS.LUNCH_ORDER_CREATE,
      PERMISSIONS.LUNCH_ORDER_READ_OWN,
      PERMISSIONS.LUNCH_ORDER_CANCEL_OWN,
    ]) {
      expect(officeBoy).toContain(permission);
    }
  });

  it('cannot undo a payment he recorded, nor set a price', () => {
    // The one who takes the money is not the one who can unmake having taken it.
    expect(officeBoy).not.toContain(PERMISSIONS.LUNCH_PAYMENT_CORRECT);
    // And what lunch costs is not his to decide.
    expect(officeBoy).not.toContain(PERMISSIONS.LUNCH_MENU_MANAGE);
  });

  it('holds nothing outside lunch at all', () => {
    // Not narrowed by a data scope - absent. This is the whole claim the role
    // makes: hiring somebody to carry plates hands them no HR system.
    expect(officeBoy.every((p) => p.startsWith('lunch.'))).toBe(true);
  });

  it('sees only his own record, whatever he is later granted', () => {
    expect(DEFAULT_ROLE_SCOPES[SYSTEM_ROLES.LUNCH_OPERATOR]).toBe('OWN');
  });

  it('is not protected, so a company can adjust it', () => {
    expect(SYSTEM_ROLE_META[SYSTEM_ROLES.LUNCH_OPERATOR].isProtected).toBe(false);
  });
});
