import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Changing the address an account signs in with.
 *
 * The endpoint exists because a login email was previously immutable: the only
 * way to correct one was a hand-written UPDATE against the database. What these
 * tests hold down is that making it possible did not make it casual.
 *
 *   - It is behind `user.email.manage`, which `user.manage` does not imply. An
 *     HR administrator who can invite, suspend and re-role an account still
 *     cannot re-address it, and a manager or employee cannot reach the module
 *     at all. The role sets used below are the REAL defaults from the shared
 *     catalogue, so a default that drifts fails here.
 *   - Every session ends and every unused reset link dies. The address is the
 *     identity, and a session opened against the old one says nothing about
 *     the holder of the new one.
 *   - An unaccepted invitation follows the address, so the link is not left
 *     sitting in a mailbox the account no longer belongs to.
 *   - The employee's `workEmail` moves only when asked, and when it does it
 *     moves in the same transaction as the login - or not at all.
 *   - Nothing else moves: not the password, not the status, not the roles, and
 *     not one column of the employee record beyond the one named above.
 *   - Nobody re-addresses their own account here, because the same call that
 *     would fix a typo is the one that just signed them out.
 */

/**
 * A prisma stand-in whose `$transaction` behaves like one: writes issued
 * through `tx` are staged and only become `committed` when the callback
 * returns. A callback that throws leaves `committed` empty, which is what lets
 * "neither change is persisted" be asserted rather than assumed.
 */
const db = vi.hoisted(() => {
  const committed: Array<{ model: string; args: unknown }> = [];
  const staged: Array<{ model: string; args: unknown }> = [];
  const failNext = { model: null as string | null };

  const stage =
    (model: string) =>
    async (args: unknown): Promise<unknown> => {
      if (failNext.model === model) {
        failNext.model = null;
        throw new Error(`simulated ${model} write failure`);
      }
      staged.push({ model, args });
      return model === 'passwordResetToken.updateMany' ? { count: 2 } : { id: 'x' };
    };

  const tx = {
    user: { update: vi.fn(stage('user.update')) },
    employee: { update: vi.fn(stage('employee.update')) },
    passwordResetToken: { updateMany: vi.fn(stage('passwordResetToken.updateMany')) },
  };

  return {
    committed,
    staged,
    failNext,
    tx,
    user: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    employee: { update: vi.fn() },
    session: { count: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      staged.length = 0;
      const result = await fn(tx);
      committed.push(...staged);
      staged.length = 0;
      return result;
    }),
  };
});

vi.mock('../../core/db.js', () => ({ prisma: db }));

const sessions = vi.hoisted(() => ({ revokeAllUserSessions: vi.fn() }));
vi.mock('../../auth/session.js', () => sessions);

const reset = vi.hoisted(() => ({ requestPasswordReset: vi.fn() }));
vi.mock('../../auth/password-reset.service.js', () => reset);

const audit = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  diff: vi.fn(() => ({ changed: [], before: {}, after: {} })),
}));
vi.mock('../../core/audit.js', () => audit);

const { userRoutes } = await import('./users.routes.js');
const { registerErrorHandler } = await import('../../core/error-handler.js');

const ACTOR_ID = 'user-actor';

async function appAs(
  permissions: readonly Permission[],
  actorUserId: string = ACTOR_ID,
): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    request.auth = {
      sessionId: 'session-1',
      userId: actorUserId,
      companyId: 'company-1',
      email: 'admin@example.com',
      permissions: new Set(permissions),
      dataScope: 'ALL',
      mustChangePassword: false,
    };
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
  return app;
}

const targetUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-2',
  email: 'old@example.com',
  status: 'ACTIVE',
  employee: { id: 'emp-1', workEmail: 'old@example.com' },
  ...overrides,
});

/** A well-formed request. Tests override the piece they are about. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  email: 'new@example.com',
  acknowledged: true,
  ...overrides,
});

const change = (app: FastifyInstance, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/users/user-2/change-email', payload: body });

const userWrites = () => db.committed.filter((w) => w.model === 'user.update');
const employeeWrites = () => db.committed.filter((w) => w.model === 'employee.update');

beforeEach(() => {
  vi.clearAllMocks();
  db.committed.length = 0;
  db.staged.length = 0;
  db.failNext.model = null;
  db.user.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    // The route makes two findFirst calls: the target lookup (by id) and the
    // uniqueness probe (by email). Tell them apart by what they ask for.
    'email' in args.where ? null : targetUser(),
  );
  sessions.revokeAllUserSessions.mockResolvedValue(3);
  reset.requestPasswordReset.mockResolvedValue({ status: 'delivered', provider: 'smtp' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes the uniqueness probe report another account on the address. */
function addressHeldBy(id: string, target = targetUser()) {
  db.user.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    'email' in args.where ? { id } : target,
  );
}

function targetIs(target: Record<string, unknown> | null) {
  db.user.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    'email' in args.where ? null : target,
  );
}

describe('the permission itself', () => {
  it('is held by SUPER_ADMIN by default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).toContain(PERMISSIONS.USER_EMAIL_MANAGE);
  });

  it('is held by no other system role by default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN).not.toContain(PERMISSIONS.USER_EMAIL_MANAGE);
    expect(DEFAULT_ROLE_PERMISSIONS.MANAGER).not.toContain(PERMISSIONS.USER_EMAIL_MANAGE);
    expect(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE).not.toContain(PERMISSIONS.USER_EMAIL_MANAGE);
  });

  it('is not implied by user.manage', () => {
    // If HR_ADMIN ever gains user.manage, this still has to hold: managing
    // accounts and re-addressing them are different grants.
    expect(PERMISSIONS.USER_EMAIL_MANAGE).not.toBe(PERMISSIONS.USER_MANAGE);
  });
});

describe('POST /users/:id/change-email', () => {
  describe('who may call it', () => {
    it('allows a Super Admin to change another account', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload());

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        id: 'user-2',
        email: 'new@example.com',
        previousEmail: 'old@example.com',
        employeeId: 'emp-1',
      });
    });

    it('refuses a default HR Admin, who can read accounts but not re-address them', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
      const res = await change(app, payload());

      expect(res.statusCode).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses an account administrator holding user.manage but not user.email.manage', async () => {
      const app = await appAs([PERMISSIONS.USER_READ, PERMISSIONS.USER_MANAGE]);
      const res = await change(app, payload());

      expect(res.statusCode).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a Manager', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.MANAGER);
      const res = await change(app, payload());

      expect(res.statusCode).toBe(403);
      expect(db.user.findFirst).not.toHaveBeenCalled();
    });

    it('refuses an Employee calling the API by hand', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE);
      const res = await change(app, payload());

      expect(res.statusCode).toBe(403);
      expect(db.user.findFirst).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses an employee changing their own address even with the permission', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN, 'user-2');
      const res = await change(app, payload());

      expect(res.statusCode).toBe(422);
      expect(res.json().error.details._[0]).toMatch(/own account/);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses the caller acting on themselves before looking the account up', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN, 'user-2');
      await change(app, payload());

      expect(db.user.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('the address itself', () => {
    it('normalises case and surrounding space before writing', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload({ email: '  New@Example.COM  ' }));

      expect(res.statusCode).toBe(200);
      expect(userWrites()).toEqual([
        { model: 'user.update', args: { where: { id: 'user-2' }, data: { email: 'new@example.com' } } },
      ]);
    });

    it('checks uniqueness case-insensitively and excluding the account itself', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await change(app, payload());

      const probe = db.user.findFirst.mock.calls
        .map((call: unknown[]) => call[0] as { where: Record<string, unknown> })
        .find((args) => 'email' in args.where);
      expect(probe?.where).toEqual({
        email: { equals: 'new@example.com', mode: 'insensitive' },
        NOT: { id: 'user-2' },
      });
    });

    it('refuses an address another account already holds', async () => {
      addressHeldBy('user-9');
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload({ email: 'Taken@Example.com' }));

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toBe('That email address is already in use.');
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses a no-op that differs only in case, rather than signing the person out for nothing', async () => {
      targetIs(targetUser({ email: 'Old@Example.com' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload({ email: 'OLD@example.com' }));

      expect(res.statusCode).toBe(422);
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses an empty address', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload({ email: '   ' }));

      expect(res.statusCode).toBe(422);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses something that is not an address', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload({ email: 'not-an-address' }));

      expect(res.statusCode).toBe(422);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a request that has not acknowledged the consequence', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      for (const acknowledged of [undefined, false, 'true', 1]) {
        const res = await change(app, payload({ acknowledged }));
        expect(res.statusCode).toBe(422);
        expect(res.json().error.details.acknowledged?.[0]).toMatch(/stop working/);
      }
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('404s an account outside the caller company', async () => {
      targetIs(null);
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload());

      expect(res.statusCode).toBe(404);
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('what the change does', () => {
    it('ends every session', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload());

      expect(sessions.revokeAllUserSessions).toHaveBeenCalledWith('user-2');
      expect(res.json().data.revokedSessions).toBe(3);
    });

    it('retires every unused reset or invitation link inside the same transaction', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload());

      const retired = db.committed.find((w) => w.model === 'passwordResetToken.updateMany');
      expect(retired?.args).toMatchObject({ where: { userId: 'user-2', usedAt: null } });
      expect((retired?.args as { data: { usedAt: Date } }).data.usedAt).toBeInstanceOf(Date);
      expect(res.json().data.retiredResetTokens).toBe(2);
    });

    it('leaves an active account its password and sends it nothing', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload());

      expect(reset.requestPasswordReset).not.toHaveBeenCalled();
      expect(res.json().data.invitationResent).toBe(false);
    });

    it('re-issues an unaccepted invitation to the new address, after the write', async () => {
      targetIs(targetUser({ status: 'INVITED' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload());

      expect(reset.requestPasswordReset).toHaveBeenCalledWith('new@example.com', expect.anything());
      expect(res.json().data.invitationResent).toBe(true);
      // The old address never receives anything.
      for (const [to] of reset.requestPasswordReset.mock.calls) expect(to).not.toBe('old@example.com');
    });

    it('re-addresses a suspended account without lifting the suspension or sending a link', async () => {
      targetIs(targetUser({ status: 'SUSPENDED' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload());

      expect(res.statusCode).toBe(200);
      expect(userWrites()).toEqual([
        { model: 'user.update', args: { where: { id: 'user-2' }, data: { email: 'new@example.com' } } },
      ]);
      expect(reset.requestPasswordReset).not.toHaveBeenCalled();
      expect(res.json().data.invitationResent).toBe(false);
    });

    it('writes nothing to the user row but the address', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await change(app, payload({ syncEmployeeWorkEmail: true }));

      // Exactly one user write, with exactly one column in it. No password,
      // no status, no lockout, no roles.
      const writes = userWrites();
      expect(writes).toHaveLength(1);
      expect(Object.keys((writes[0]!.args as { data: object }).data)).toEqual(['email']);
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it('records both addresses, the employee and what else happened in the audit trail', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await change(app, payload());

      expect(audit.recordAudit).toHaveBeenCalledTimes(1);
      expect(audit.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: 'company-1',
          actorId: ACTOR_ID,
          action: 'user.email.change',
          entityType: 'User',
          entityId: 'user-2',
          summary: expect.stringMatching(/old@example\.com.*new@example\.com/),
          before: { email: 'old@example.com', employeeId: 'emp-1', employeeWorkEmail: 'old@example.com' },
          after: expect.objectContaining({
            email: 'new@example.com',
            employeeId: 'emp-1',
            employeeWorkEmailUpdated: false,
            revokedSessions: 3,
            retiredResetTokens: 2,
          }),
          // The request itself, so the audit service can record IP and agent.
          request: expect.anything(),
        }),
      );
    });

    it('never puts a password or a token anywhere near the audit entry', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await change(app, payload());

      const { before, after } = audit.recordAudit.mock.calls[0]![0] as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      // The audit service redacts these keys; the point here is that the route
      // never has such a value in hand to begin with. Counts are fine - a
      // number of retired links is not a link.
      const secretKeys = ['password', 'passwordhash', 'token', 'tokenhash', 'secret'];
      for (const key of [...Object.keys(before), ...Object.keys(after)]) {
        expect(secretKeys).not.toContain(key.toLowerCase());
      }
      for (const value of [...Object.values(before), ...Object.values(after)]) {
        expect(typeof value === 'string' ? value : '').not.toMatch(/^[A-Za-z0-9_-]{40,}$/);
      }
    });
  });

  describe('the employee work email', () => {
    it('is left alone by default', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload());

      expect(employeeWrites()).toHaveLength(0);
      expect(res.json().data.employeeWorkEmailUpdated).toBe(false);
    });

    it('moves with the login when asked, in the same transaction, touching one column', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await change(app, payload({ syncEmployeeWorkEmail: true }));

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(employeeWrites()).toEqual([
        {
          model: 'employee.update',
          args: { where: { id: 'emp-1' }, data: { workEmail: 'new@example.com' } },
        },
      ]);
      // Nothing about the employee's identity is in the write: not the number,
      // not a punch code, not a status, not a department.
      expect(Object.keys((employeeWrites()[0]!.args as { data: object }).data)).toEqual(['workEmail']);
      expect(res.json().data.employeeWorkEmailUpdated).toBe(true);
      expect(audit.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({
            employeeWorkEmail: 'new@example.com',
            employeeWorkEmailUpdated: true,
          }),
        }),
      );
    });

    it('is a no-op on an account with no employee, rather than an error', async () => {
      targetIs(targetUser({ employee: null }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload({ syncEmployeeWorkEmail: true }));

      expect(res.statusCode).toBe(200);
      expect(employeeWrites()).toHaveLength(0);
      expect(res.json().data).toMatchObject({ employeeId: null, employeeWorkEmailUpdated: false });
    });

    it('persists neither change when the employee write fails', async () => {
      db.failNext.model = 'employee.update';
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload({ syncEmployeeWorkEmail: true }));

      expect(res.statusCode).toBe(500);
      // The user write was issued inside the transaction and then discarded
      // with it. Nothing reached the committed set.
      expect(db.tx.user.update).toHaveBeenCalledTimes(1);
      expect(db.committed).toHaveLength(0);
      // And nothing downstream of the write happened either.
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
      expect(audit.recordAudit).not.toHaveBeenCalled();
      expect(reset.requestPasswordReset).not.toHaveBeenCalled();
    });

    it('persists neither change when the user write fails', async () => {
      db.failNext.model = 'user.update';
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      const res = await change(app, payload({ syncEmployeeWorkEmail: true }));

      expect(res.statusCode).toBe(500);
      expect(db.committed).toHaveLength(0);
      expect(db.tx.employee.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });
  });
});

/**
 * Sending a reset link, and saying truthfully what happened to it.
 *
 * A reset link is two separate things: a token in the database, and an email
 * carrying it. Only the first is guaranteed, and for months the response
 * conflated them - `{ sent: true }` regardless, so a server whose mail
 * transport delivered nothing still produced a green "Reset link sent" toast
 * while nobody received anything. The route now reports the token and the
 * delivery separately, because they genuinely come apart.
 */
describe('POST /users/:id/send-reset', () => {
  const send = (app: FastifyInstance) =>
    app.inject({ method: 'POST', url: '/users/user-2/send-reset' });

  const body = (res: { body: string }) =>
    (JSON.parse(res.body) as { data: { sent: boolean; delivery: string; errorCode?: string } })
      .data;

  it('asks for a reset link for the account being viewed', async () => {
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    await send(app);

    expect(reset.requestPasswordReset).toHaveBeenCalledWith(
      'old@example.com',
      expect.anything(),
    );
  });

  /**
   * Which address a reset link goes to, now that the sign-in address can move.
   *
   * The default fixture has the two addresses agreeing, which is the normal
   * case and also the case that cannot tell them apart. These pull them apart
   * on purpose: a reset is keyed on the account's sign-in address, and the
   * employee's work email - a different field, on a different row, editable
   * from a different screen by people who do not hold `user.email.manage` -
   * must not be able to redirect one.
   */
  describe('which address it goes to', () => {
    it('uses the sign-in address, not the employee work email, when the two differ', async () => {
      targetIs(
        targetUser({
          email: 'signin@example.com',
          employee: { id: 'emp-1', workEmail: 'hr-directory@example.com' },
        }),
      );
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      await send(app);

      expect(reset.requestPasswordReset).toHaveBeenCalledWith(
        'signin@example.com',
        expect.anything(),
      );
    });

    it('is unaffected by a work email that changed on its own', async () => {
      // Someone edited the HR record's work email and nothing else. The login
      // is untouched, so the link must still go where the person signs in.
      targetIs(
        targetUser({
          email: 'signin@example.com',
          employee: { id: 'emp-1', workEmail: 'moved-somewhere-else@example.com' },
        }),
      );
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      await send(app);

      const [to] = reset.requestPasswordReset.mock.calls[0] as [string];
      expect(to).toBe('signin@example.com');
      expect(to).not.toBe('moved-somewhere-else@example.com');
    });

    it('follows the sign-in address after a change, and does not write to the old one', async () => {
      // The state the account is in once `POST /:id/change-email` has run: the
      // row now holds the new address. A later reset reads the row, so the old
      // inbox is never asked for again.
      targetIs(targetUser({ email: 'new@example.com' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      await send(app);

      expect(reset.requestPasswordReset).toHaveBeenCalledTimes(1);
      expect(reset.requestPasswordReset).toHaveBeenCalledWith(
        'new@example.com',
        expect.anything(),
      );
      expect(reset.requestPasswordReset).not.toHaveBeenCalledWith(
        'old@example.com',
        expect.anything(),
      );
    });

    it('reads the address from the account row rather than anything the caller sent', async () => {
      targetIs(targetUser({ email: 'signin@example.com' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

      // An address in the body is not a redirect - the route never reads one.
      await app.inject({
        method: 'POST',
        url: '/users/user-2/send-reset',
        payload: { email: 'attacker@example.com' },
      });

      expect(reset.requestPasswordReset).toHaveBeenCalledWith(
        'signin@example.com',
        expect.anything(),
      );
    });
  });

  it('reports delivered when the transport accepted the message', async () => {
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ sent: true, delivery: 'delivered' });
  });

  it('reports unconfirmed when the transport took it but delivered nothing', async () => {
    // The production case: the console provider, which logs and drops.
    reset.requestPasswordReset.mockResolvedValue({ status: 'unconfirmed', provider: 'console' });
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    expect(body(res).delivery).toBe('unconfirmed');
  });

  it('reports a failure rather than swallowing it into a success', async () => {
    reset.requestPasswordReset.mockResolvedValue({
      status: 'failed',
      provider: 'smtp',
      errorCode: 'EAUTH',
    });
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    // Still a 200: the token exists and the request was accepted. What changed
    // is that the response no longer claims the email went anywhere.
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ sent: true, delivery: 'failed', errorCode: 'EAUTH' });
  });

  it('carries a bare code and nothing about the relay', async () => {
    reset.requestPasswordReset.mockResolvedValue({
      status: 'failed',
      provider: 'smtp',
      errorCode: 'ECONNECTION',
    });
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    // No host, no username, no credential, and not the relay's own text: an
    // administrator gets something to search for, not our mail configuration.
    expect(Object.keys(body(res)).sort()).toEqual(['delivery', 'errorCode', 'sent']);
  });

  it('never returns the token or a link containing one', async () => {
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    expect(res.body).not.toContain('token');
    expect(res.body).not.toContain('reset-password');
  });

  it('records the delivery outcome in the audit trail, without the link', async () => {
    reset.requestPasswordReset.mockResolvedValue({ status: 'unconfirmed', provider: 'console' });
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    await send(app);

    const entry = audit.recordAudit.mock.calls[0]?.[0] as {
      summary: string;
      after: { delivery: string };
    };
    expect(entry.summary).toContain('unconfirmed');
    expect(entry.summary).not.toContain('token');
    expect(entry.after.delivery).toBe('unconfirmed');
  });

  it('refuses a suspended account, so a reset cannot walk around a suspension', async () => {
    targetIs(targetUser({ status: 'SUSPENDED' }));
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    expect(res.statusCode).toBe(409);
    expect(reset.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('404s an account outside the caller company', async () => {
    targetIs(null);
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);

    const res = await send(app);

    expect(res.statusCode).toBe(404);
    expect(reset.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('refuses a Manager, who cannot manage accounts at all', async () => {
    const app = await appAs(DEFAULT_ROLE_PERMISSIONS.MANAGER);

    const res = await send(app);

    expect(res.statusCode).toBe(403);
    expect(reset.requestPasswordReset).not.toHaveBeenCalled();
  });
});
