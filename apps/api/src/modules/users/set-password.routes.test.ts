import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  passwordSchema,
  type Permission,
} from '@hrms/shared';

/**
 * Setting somebody else's password.
 *
 * This is the one endpoint in the system that hands a working credential to a
 * person who is not its owner, and it exists for a blunt reason: this
 * deployment's mail transport delivers nothing, so the reset link that would
 * normally onboard somebody goes nowhere. What these tests hold down is that
 * paying that price bought exactly one capability and not a second one.
 *
 *   - It is behind `user.password.manage`, which `user.manage` does not imply.
 *     An HR administrator who can invite, suspend, re-role and send reset links
 *     still cannot do this. The role sets below are the REAL defaults from the
 *     shared catalogue, so a default that drifts fails here.
 *   - What comes back is what was hashed. A response that showed one value
 *     while storing another would produce an employee who cannot sign in and
 *     an administrator certain they can.
 *   - `mustChangePassword` is written with the hash, never without it. That
 *     single field is what makes the whole feature survivable: it is why the
 *     value an administrator just read is dead the moment it is used.
 *   - The password reaches the audit trail nowhere, in no field, at no length.
 *   - Every session ends and every unused reset link dies, in the same call.
 *   - Nobody sets their OWN password here - that request would revoke the
 *     session making it and lock the caller behind the gate it just raised.
 */

const db = vi.hoisted(() => {
  const committed: Array<{ model: string; args: unknown }> = [];
  const staged: Array<{ model: string; args: unknown }> = [];

  const stage =
    (model: string) =>
    async (args: unknown): Promise<unknown> => {
      staged.push({ model, args });
      return model === 'passwordResetToken.updateMany' ? { count: 2 } : { id: 'x' };
    };

  const tx = {
    user: { update: vi.fn(stage('user.update')) },
    passwordResetToken: { updateMany: vi.fn(stage('passwordResetToken.updateMany')) },
  };

  return {
    committed,
    staged,
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

/**
 * Argon2id is deliberately expensive, and running it for real in every case
 * here would buy nothing: what matters is WHICH STRING was handed to it, not
 * what it returned. `password.ts` has the hashing itself under test.
 */
const password = vi.hoisted(() => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../../auth/password.js', () => password);

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
  email: 'joiner@example.com',
  status: 'ACTIVE',
  ...overrides,
});

const call = (app: FastifyInstance, body: Record<string, unknown>, id = 'user-2') =>
  app.inject({ method: 'POST', url: `/users/${id}/set-password`, payload: body });

const userWrites = () => db.committed.filter((w) => w.model === 'user.update');
const tokenWrites = () =>
  db.committed.filter((w) => w.model === 'passwordResetToken.updateMany');

const writtenData = () =>
  (userWrites()[0]?.args as { data: Record<string, unknown> } | undefined)?.data;

beforeEach(() => {
  vi.clearAllMocks();
  db.committed.length = 0;
  db.staged.length = 0;
  db.user.findFirst.mockResolvedValue(targetUser());
  sessions.revokeAllUserSessions.mockResolvedValue(3);
  password.hashPassword.mockImplementation(async (plain: string) => `hashed:${plain}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the permission itself', () => {
  it('is held by SUPER_ADMIN by default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN).toContain(PERMISSIONS.USER_PASSWORD_MANAGE);
  });

  it('is held by no other system role by default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN).not.toContain(PERMISSIONS.USER_PASSWORD_MANAGE);
    expect(DEFAULT_ROLE_PERMISSIONS.MANAGER).not.toContain(PERMISSIONS.USER_PASSWORD_MANAGE);
    expect(DEFAULT_ROLE_PERMISSIONS.EMPLOYEE).not.toContain(PERMISSIONS.USER_PASSWORD_MANAGE);
  });

  it('is not the same grant as user.manage', () => {
    expect(PERMISSIONS.USER_PASSWORD_MANAGE).not.toBe(PERMISSIONS.USER_MANAGE);
  });
});

describe('POST /users/:id/set-password', () => {
  describe('who may call it', () => {
    it('allows a Super Admin', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });
      expect(res.statusCode).toBe(200);
    });

    it('refuses an HR Admin, who holds user.manage but not this', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.HR_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(res.statusCode).toBe(403);
      expect(userWrites()).toHaveLength(0);
    });

    it('refuses user.manage on its own', async () => {
      const app = await appAs([PERMISSIONS.USER_READ, PERMISSIONS.USER_MANAGE]);
      const res = await call(app, { acknowledged: true });

      expect(res.statusCode).toBe(403);
      expect(userWrites()).toHaveLength(0);
    });

    it('refuses setting your own password', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN, 'user-2');
      const res = await call(app, { acknowledged: true });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.details._[0]).toMatch(/your own account/i);
      expect(userWrites()).toHaveLength(0);
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });
  });

  describe('the value it hands back', () => {
    it('returns exactly the string it hashed', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      const { password: issued } = res.json().data;
      expect(password.hashPassword).toHaveBeenCalledWith(issued);
      expect(writtenData()?.passwordHash).toBe(`hashed:${issued}`);
    });

    it('generates a passphrase that satisfies the house password rules', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      const { password: issued, generated } = res.json().data;
      expect(generated).toBe(true);
      // Four words and a two-digit number, which is what a person can read out.
      expect(issued).toMatch(/^[a-z]+(-[a-z]+){3}-\d{2}$/);
      expect(passwordSchema.safeParse(issued).success).toBe(true);
    });

    it('does not generate the same passphrase twice', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const a = (await call(app, { acknowledged: true })).json().data.password;
      const b = (await call(app, { acknowledged: true })).json().data.password;
      expect(a).not.toBe(b);
    });

    it('uses a supplied password instead, and says it did not generate it', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { password: 'winter-ferry-2026', acknowledged: true });

      expect(res.json().data).toMatchObject({
        password: 'winter-ferry-2026',
        generated: false,
      });
      expect(writtenData()?.passwordHash).toBe('hashed:winter-ferry-2026');
    });

    it('holds a supplied password to the same rules as any other', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { password: 'short', acknowledged: true });

      expect(res.statusCode).toBe(422);
      expect(userWrites()).toHaveLength(0);
    });
  });

  describe('what it writes', () => {
    it('writes mustChangePassword with the hash, never without it', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await call(app, { acknowledged: true });

      const data = writtenData();
      expect(data?.mustChangePassword).toBe(true);
      expect(data?.passwordHash).toEqual(expect.stringContaining('hashed:'));
    });

    it('clears a lockout, so the password it issues actually works', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await call(app, { acknowledged: true });

      expect(writtenData()).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    });

    it('ends every session the person has', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(sessions.revokeAllUserSessions).toHaveBeenCalledWith('user-2');
      expect(res.json().data.revokedSessions).toBe(3);
    });

    it('retires unused reset links in the same transaction as the password', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(tokenWrites()).toHaveLength(1);
      expect(tokenWrites()[0]?.args).toMatchObject({
        where: { userId: 'user-2', usedAt: null },
      });
      expect(res.json().data.retiredResetTokens).toBe(2);
      // Both writes committed together, which is the point of the transaction.
      expect(db.committed.map((w) => w.model)).toEqual([
        'user.update',
        'passwordResetToken.updateMany',
      ]);
    });

    it('leaves an active account’s status alone', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(writtenData()).not.toHaveProperty('status');
      expect(res.json().data).toMatchObject({ status: 'ACTIVE', activated: false });
    });

    it('activates an INVITED account, because ACTIVE is the only status that can sign in', async () => {
      db.user.findFirst.mockResolvedValue(targetUser({ status: 'INVITED' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(writtenData()?.status).toBe('ACTIVE');
      expect(res.json().data).toMatchObject({ status: 'ACTIVE', activated: true });
    });
  });

  describe('what it refuses', () => {
    it('requires the acknowledgement, from the API and not only the form', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, {});

      expect(res.statusCode).toBe(422);
      expect(userWrites()).toHaveLength(0);
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('refuses a suspended account rather than quietly restoring it', async () => {
      db.user.findFirst.mockResolvedValue(targetUser({ status: 'SUSPENDED' }));
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/suspended/i);
      expect(userWrites()).toHaveLength(0);
      expect(sessions.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('404s for an account in another company', async () => {
      db.user.findFirst.mockResolvedValue(null);
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { acknowledged: true });

      expect(res.statusCode).toBe(404);
      expect(userWrites()).toHaveLength(0);
    });
  });

  describe('what the audit trail learns', () => {
    it('records that a password was set, and by whom', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      await call(app, { acknowledged: true });

      expect(audit.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.password.set',
          entityType: 'User',
          entityId: 'user-2',
          actorId: ACTOR_ID,
        }),
      );
    });

    /**
     * Asserted over the fields the ROUTE contributes, not the whole call.
     *
     * `recordAudit` is handed the Fastify request, whose body obviously still
     * holds the password on the typed path - but `audit.ts` reads exactly two
     * things off it, `clientIp(request)` and the user-agent header, and
     * persists neither the body nor the request. Serialising the whole
     * argument list would therefore fail on a value that never reaches the
     * database, and would keep failing however carefully this route behaved.
     */
    const auditPayload = () => {
      const [input] = audit.recordAudit.mock.calls.at(-1) as [Record<string, unknown>];
      const { request: _request, ...persisted } = input;
      return JSON.stringify(persisted);
    };

    it('never records a password the administrator typed', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const res = await call(app, { password: 'winter-ferry-2026', acknowledged: true });
      expect(res.statusCode).toBe(200);

      expect(auditPayload()).not.toContain('winter-ferry-2026');
      expect(auditPayload()).not.toContain('hashed:');
    });

    it('never records a generated passphrase either', async () => {
      const app = await appAs(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN);
      const issued = (await call(app, { acknowledged: true })).json().data.password;

      expect(auditPayload()).not.toContain(issued);
    });

  });
});
