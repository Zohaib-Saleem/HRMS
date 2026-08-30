/**
 * User management audit.
 *
 * Drives the real API against the real database. The interesting assertions are
 * not the happy paths - they are the refusals: that a manager gains nothing,
 * that an employee gains nothing, that a terminated person cannot sign in with
 * a session they already held, and that reactivating an employee does not
 * quietly undo a suspension somebody imposed for a reason of its own.
 *
 * Everything it creates is prefixed `audit-users` and removed at the end.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-users.mjs
 */
import { PrismaClient } from '@prisma/client';

const BASE = 'http://127.0.0.1:4000/api/v1';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    fail += 1;
    console.log(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`,
    );
  }
}

const truthy = (label, actual) => check(label, Boolean(actual), true);
const section = (title) => console.log(`\n################ ${title} ################`);

/**
 * Sign-in is rate limited to ten attempts per five minutes **per IP**, and this
 * suite signs in about fifteen times because so many of its assertions are
 * about who can and cannot get in.
 *
 * Each call therefore presents its own forwarded address, which the API honours
 * because `trustProxy` is on. That is not a way around the limiter - it is what
 * the limiter is for. Fifteen sign-ins from fifteen addresses is exactly the
 * shape of ordinary traffic, and counting them as one attacker would be the
 * bug. The limiter's own behaviour is asserted separately below, from a single
 * address.
 */
let callSequence = 0;
function nextIp() {
  callSequence += 1;
  return `203.0.113.${(callSequence % 250) + 1}`;
}

async function attemptLogin(email, password, ip = nextIp()) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  return { status: response.status, cookie };
}

async function login(email, password) {
  const result = await attemptLogin(email, password);
  if (result.status === 429) {
    throw new Error(`login for ${email} was rate limited unexpectedly.`);
  }
  if (result.status !== 200) throw new Error(`login failed for ${email}: ${result.status}`);
  if (!result.cookie) throw new Error(`no session cookie for ${email}`);
  return result.cookie;
}

/** Login that is expected to fail, so the caller can assert the status. */
async function tryLogin(email, password) {
  const result = await attemptLogin(email, password);
  return result.status;
}

async function api(cookie, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json, text };
}

const PREFIX = 'audit-users';
const NEW_EMAIL = `${PREFIX}-newstarter@hrms.local`;
const SECOND_EMAIL = `${PREFIX}-second@hrms.local`;

let companyId = null;
let adminCookie = null;
let managerCookie = null;
let employeeCookie = null;
let staffEmployeeId = null;
let roles = [];
let createdUserId = null;
let secondUserId = null;
let fixtureEmployeeId = null;

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length > 0) {
    await prisma.employee.updateMany({ where: { userId: { in: ids } }, data: { userId: null } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.updateMany({ where: { actorId: { in: ids } }, data: { actorId: null } });
    await prisma.user.updateMany({
      where: { suspendedById: { in: ids } },
      data: { suspendedById: null },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.employee.deleteMany({ where: { employeeNumber: { startsWith: PREFIX } } });
}

try {
  section('FIXTURES');

  {
    const company = await prisma.company.findFirstOrThrow({ select: { id: true } });
    companyId = company.id;

    await cleanup();

    const staff = await prisma.user.findFirstOrThrow({
      where: { email: 'employee@hrms.local' },
      select: { employee: { select: { id: true } } },
    });
    staffEmployeeId = staff.employee.id;

    // An employee with no login, to be given one during the suite.
    const fixture = await prisma.employee.create({
      data: {
        companyId,
        employeeNumber: `${PREFIX}-0001`,
        firstName: 'Nadia',
        lastName: 'Karim',
        status: 'ACTIVE',
      },
    });
    fixtureEmployeeId = fixture.id;
    truthy('an employee with no login exists', fixtureEmployeeId !== null);

    adminCookie = await login('admin@hrms.local', 'Admin@12345');
    managerCookie = await login('manager@hrms.local', 'Manager@12345');
    employeeCookie = await login('employee@hrms.local', 'Employee@12345');
    truthy('three sessions', adminCookie && managerCookie && employeeCookie);

    const roleResponse = await api(adminCookie, '/roles');
    roles = roleResponse.body.data;
    truthy('roles are readable', roles.length >= 4);
  }

  section('AUTHORIZATION');

  {
    const anon = await fetch(`${BASE}/users`);
    check('user management needs a session', anon.status, 401);

    const staff = await api(employeeCookie, '/users');
    check('an employee cannot list users', staff.status, 403);

    const manager = await api(managerCookie, '/users');
    check('a manager cannot list users', manager.status, 403);

    const managerCreate = await api(managerCookie, '/users', {
      method: 'POST',
      body: {
        email: `${PREFIX}-manager-attempt@hrms.local`,
        firstName: 'A',
        lastName: 'B',
        roleIds: [roles[0].id],
      },
    });
    check('a manager cannot create a user', managerCreate.status, 403);

    const staffCreate = await api(employeeCookie, '/users', {
      method: 'POST',
      body: {
        email: `${PREFIX}-employee-attempt@hrms.local`,
        firstName: 'A',
        lastName: 'B',
        roleIds: [roles[0].id],
      },
    });
    check('an employee cannot create a user', staffCreate.status, 403);

    const written = await prisma.user.count({ where: { email: { startsWith: PREFIX } } });
    check('and nothing was written', written, 0);

    const admin = await api(adminCookie, '/users');
    check('an administrator can', admin.status, 200);
    truthy('and sees the seeded accounts', admin.body.data.length >= 3);
  }

  section('RESPONSES CARRY NO SECRETS');

  {
    const list = await api(adminCookie, '/users');
    const raw = list.text;
    check('no password hash in the list', /passwordHash|argon2|\$argon/.test(raw), false);
    check('no reset token in the list', /tokenHash|resetToken/.test(raw), false);
    check('no session token in the list', /"token"/.test(raw), false);

    const first = list.body.data[0];
    check('and no password field of any kind', 'password' in first, false);
    check('nor a hash field', 'passwordHash' in first, false);
  }

  section('CREATING AN ACCOUNT');

  {
    const employeeRole = roles.find((r) => r.key === 'EMPLOYEE');
    const created = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: NEW_EMAIL,
        firstName: 'Nadia',
        lastName: 'Karim',
        employeeId: fixtureEmployeeId,
        roleIds: [employeeRole.id],
      },
    });
    check('an account is created', created.status, 201);
    check('and starts as invited, not active', created.body.data.status, 'INVITED');
    createdUserId = created.body.data.id;

    check('no password is returned', /password/i.test(created.text), false);

    const stored = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, passwordHash: true, mustChangePassword: true },
    });
    check('it is invited in the database', stored.status, 'INVITED');
    check('and is flagged to set a password', stored.mustChangePassword, true);
    truthy(
      'the stored hash is not a usable argon2 hash',
      !stored.passwordHash.startsWith('$argon2'),
    );

    // The whole point of INVITED: it exists but cannot be used yet.
    const beforeAccepting = await tryLogin(NEW_EMAIL, 'anything-at-all');
    check('an invited account cannot sign in', beforeAccepting, 401);

    const link = await prisma.employee.findUnique({
      where: { id: fixtureEmployeeId },
      select: { userId: true },
    });
    check('the employee is linked to it', link.userId, createdUserId);

    const detail = await api(adminCookie, `/users/${createdUserId}`);
    check('the detail loads', detail.status, 200);
    check('showing the linked employee', detail.body.data.employee.id, fixtureEmployeeId);
    check('and the assigned role', detail.body.data.roles[0].key, 'EMPLOYEE');
    check('with no sessions yet', detail.body.data.activeSessionCount, 0);
  }

  section('DUPLICATE PREVENTION');

  {
    const sameEmail = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: NEW_EMAIL,
        firstName: 'Someone',
        lastName: 'Else',
        roleIds: [roles[0].id],
      },
    });
    check('a duplicate email is refused', sameEmail.status, 409);

    const upperCase = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: NEW_EMAIL.toUpperCase(),
        firstName: 'Someone',
        lastName: 'Else',
        roleIds: [roles[0].id],
      },
    });
    check('and so is the same address in another case', upperCase.status, 409);

    const sameEmployee = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: SECOND_EMAIL,
        firstName: 'Second',
        lastName: 'Account',
        employeeId: fixtureEmployeeId,
        roleIds: [roles[0].id],
      },
    });
    check('a second account for one employee is refused', sameEmployee.status, 409);
    truthy(
      'and says why',
      JSON.stringify(sameEmployee.body).includes('already has a login'),
    );

    const total = await prisma.user.count({ where: { email: { startsWith: PREFIX } } });
    check('exactly one account was created', total, 1);
  }

  section('VALIDATION');

  {
    const noRole = await api(adminCookie, '/users', {
      method: 'POST',
      body: { email: `${PREFIX}-norole@hrms.local`, firstName: 'A', lastName: 'B', roleIds: [] },
    });
    check('an account with no role is refused', noRole.status, 422);

    const badEmail = await api(adminCookie, '/users', {
      method: 'POST',
      body: { email: 'not-an-email', firstName: 'A', lastName: 'B', roleIds: [roles[0].id] },
    });
    check('a malformed email is refused', badEmail.status, 422);

    const unknownRole = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: `${PREFIX}-badrole@hrms.local`,
        firstName: 'A',
        lastName: 'B',
        roleIds: ['does-not-exist'],
      },
    });
    check('an unknown role is refused', unknownRole.status, 422);

    const noName = await api(adminCookie, '/users', {
      method: 'POST',
      body: { email: `${PREFIX}-noname@hrms.local`, firstName: '', lastName: '', roleIds: [roles[0].id] },
    });
    check('a nameless account is refused', noName.status, 422);
  }

  section('ROLE ASSIGNMENT');

  {
    const managerRole = roles.find((r) => r.key === 'MANAGER');
    const employeeRole = roles.find((r) => r.key === 'EMPLOYEE');

    const changed = await api(adminCookie, `/users/${createdUserId}/roles`, {
      method: 'PUT',
      body: { roleIds: [managerRole.id, employeeRole.id] },
    });
    check('roles can be changed', changed.status, 200);
    check('both are assigned', changed.body.data.roles.sort(), ['EMPLOYEE', 'MANAGER']);

    const stored = await prisma.userRole.count({ where: { userId: createdUserId } });
    check('and stored', stored, 2);

    const emptied = await api(adminCookie, `/users/${createdUserId}/roles`, {
      method: 'PUT',
      body: { roleIds: [] },
    });
    check('a user cannot be left with no role', emptied.status, 422);

    const managerAttempt = await api(managerCookie, `/users/${createdUserId}/roles`, {
      method: 'PUT',
      body: { roleIds: [employeeRole.id] },
    });
    check('a manager cannot change roles', managerAttempt.status, 403);

    // Back to one role for the rest of the suite.
    await api(adminCookie, `/users/${createdUserId}/roles`, {
      method: 'PUT',
      body: { roleIds: [employeeRole.id] },
    });
  }

  section('ACCEPTING AN INVITATION');

  {
    // The invitation is an ordinary reset link. The token never leaves the
    // database, so the suite reads the hash row the same way the mailer would
    // have delivered the link - it cannot recover the token itself, which is
    // exactly the property being relied on, so it issues its own.
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({
      data: {
        userId: createdUserId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const reset = await fetch(`${BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        newPassword: 'NewStarter@12345',
        confirmPassword: 'NewStarter@12345',
      }),
    });
    check('an invited account can set a password', reset.status, 200);

    const after = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, mustChangePassword: true, passwordHash: true },
    });
    check('which activates it', after.status, 'ACTIVE');
    check('and clears the must-change flag', after.mustChangePassword, false);
    truthy('and stores a real argon2 hash', after.passwordHash.startsWith('$argon2'));

    const signedIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('and now they can sign in', signedIn, 200);
  }

  section('SUSPENSION');

  {
    const newUserCookie = await login(NEW_EMAIL, 'NewStarter@12345');
    const before = await api(adminCookie, `/users/${createdUserId}`);
    truthy('the account has a session', before.body.data.activeSessionCount >= 1);

    const noReason = await api(adminCookie, `/users/${createdUserId}/suspend`, {
      method: 'POST',
      body: { reason: '' },
    });
    check('suspension needs a reason', noReason.status, 422);

    const suspended = await api(adminCookie, `/users/${createdUserId}/suspend`, {
      method: 'POST',
      body: { reason: 'audit-users security review' },
    });
    check('an administrator can suspend', suspended.status, 200);
    truthy('and sessions are revoked', suspended.body.data.revokedSessions >= 1);

    const stored = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true, statusBeforeSuspension: true, suspendedById: true },
    });
    check('the status is suspended', stored.status, 'SUSPENDED');
    check('the reason is recorded as administrative', stored.suspendedReason, 'ADMINISTRATIVE');
    check('the previous status is remembered', stored.statusBeforeSuspension, 'ACTIVE');
    truthy('and who did it', stored.suspendedById !== null);

    // The session that existed before suspension must be dead, not merely
    // marked - this is the assertion that matters.
    const stolen = await api(newUserCookie, '/me');
    check('the session it already held stops working', stolen.status, 401);

    const cannotSignIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('and it cannot sign in again', cannotSignIn, 401);

    const again = await api(adminCookie, `/users/${createdUserId}/suspend`, {
      method: 'POST',
      body: { reason: 'audit-users second attempt' },
    });
    check('suspending twice is refused', again.status, 409);

    const resetWhileSuspended = await api(adminCookie, `/users/${createdUserId}/send-reset`, {
      method: 'POST',
    });
    check('a suspended account cannot be sent a reset link', resetWhileSuspended.status, 409);

    // Nor can it walk around the suspension by asking for one itself. Counted
    // as a delta because the invitation token issued at creation is still on
    // file: what matters is that no *new* one is minted.
    const tokensBefore = await prisma.passwordResetToken.count({ where: { userId: createdUserId } });
    const selfServe = await fetch(`${BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: NEW_EMAIL }),
    });
    check('forgot-password answers the same either way', selfServe.status, 200);
    const tokensAfter = await prisma.passwordResetToken.count({ where: { userId: createdUserId } });
    check('but issues no new token for a suspended account', tokensAfter, tokensBefore);

    // And a token issued *before* the suspension cannot be redeemed during it,
    // which is the part that would actually let somebody back in.
    const { createHash, randomBytes } = await import('node:crypto');
    const staleToken = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({
      data: {
        userId: createdUserId,
        tokenHash: createHash('sha256').update(staleToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const redeem = await fetch(`${BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: staleToken,
        newPassword: 'Bypass@12345',
        confirmPassword: 'Bypass@12345',
      }),
    });
    check('an outstanding reset link cannot lift a suspension', redeem.status, 422);
    const stillSuspended = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true },
    });
    check('and the account stays suspended', stillSuspended.status, 'SUSPENDED');
    const stillBlocked = await tryLogin(NEW_EMAIL, 'Bypass@12345');
    check('with the attempted password refused', stillBlocked, 401);
  }

  section('RESTORING');

  {
    const restored = await api(adminCookie, `/users/${createdUserId}/restore`, { method: 'POST' });
    check('an administrator can restore', restored.status, 200);
    check('to the status it had before', restored.body.data.status, 'ACTIVE');

    const stored = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true, statusBeforeSuspension: true },
    });
    check('the suspension reason is cleared', stored.suspendedReason, null);
    check('and the remembered status too', stored.statusBeforeSuspension, null);

    const signedIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('and they can sign in again', signedIn, 200);

    const again = await api(adminCookie, `/users/${createdUserId}/restore`, { method: 'POST' });
    check('restoring an active account is refused', again.status, 409);
  }

  section('TERMINATION SUSPENDS THE LOGIN');

  {
    const userCookie = await login(NEW_EMAIL, 'NewStarter@12345');

    const terminated = await api(adminCookie, `/employees/${fixtureEmployeeId}/terminate`, {
      method: 'POST',
      body: { terminationDate: '2026-08-31', reason: 'audit-users fixture' },
    });
    check('the employee is terminated', terminated.status, 200);

    const stored = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true, statusBeforeSuspension: true },
    });
    check('their login is suspended', stored.status, 'SUSPENDED');
    check('for the termination, not administratively', stored.suspendedReason, 'EMPLOYMENT_TERMINATED');
    check('and the previous status is remembered', stored.statusBeforeSuspension, 'ACTIVE');

    const held = await api(userCookie, '/me');
    check('the session they already held stops working', held.status, 401);

    const cannotSignIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('and a terminated employee cannot sign in', cannotSignIn, 401);

    const live = await prisma.session.count({
      where: { userId: createdUserId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    check('no session survives', live, 0);
  }

  section('REACTIVATION RESTORES THE LOGIN');

  {
    const reactivated = await api(adminCookie, `/employees/${fixtureEmployeeId}/reactivate`, {
      method: 'POST',
    });
    check('the employee is reactivated', reactivated.status, 200);

    const stored = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true },
    });
    check('and their login comes back', stored.status, 'ACTIVE');
    check('with the suspension cleared', stored.suspendedReason, null);

    const signedIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('so they can sign in again', signedIn, 200);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'employee.reactivate', entityId: fixtureEmployeeId },
      orderBy: { createdAt: 'desc' },
    });
    truthy('the audit entry records the login was restored', log.summary.includes('restored their login'));
  }

  section('AN INDEPENDENTLY SUSPENDED ACCOUNT IS NOT RESTORED');

  {
    // The rule this whole module exists for. Suspend deliberately, terminate,
    // then reactivate: the account must stay off, because the reason it was
    // switched off has nothing to do with the employment.
    await api(adminCookie, `/users/${createdUserId}/suspend`, {
      method: 'POST',
      body: { reason: 'audit-users independent security concern' },
    });

    const beforeTermination = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { suspendedReason: true },
    });
    check('it is suspended administratively', beforeTermination.suspendedReason, 'ADMINISTRATIVE');

    await api(adminCookie, `/employees/${fixtureEmployeeId}/terminate`, {
      method: 'POST',
      body: { terminationDate: '2026-08-31', reason: 'audit-users second termination' },
    });

    const afterTermination = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true },
    });
    check('terminating does not overwrite the reason', afterTermination.suspendedReason, 'ADMINISTRATIVE');
    check('and it stays suspended', afterTermination.status, 'SUSPENDED');

    const reactivated = await api(adminCookie, `/employees/${fixtureEmployeeId}/reactivate`, {
      method: 'POST',
    });
    check('the employee reactivates', reactivated.status, 200);

    const afterReactivation = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true, suspendedReason: true },
    });
    check('but the login stays suspended', afterReactivation.status, 'SUSPENDED');
    check('with its own reason intact', afterReactivation.suspendedReason, 'ADMINISTRATIVE');

    const cannotSignIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('and they still cannot sign in', cannotSignIn, 401);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'employee.reactivate', entityId: fixtureEmployeeId },
      orderBy: { createdAt: 'desc' },
    });
    truthy(
      'the audit entry says the login was left alone',
      log.summary.includes('left suspended'),
    );

    // An administrator can still override it deliberately from the users screen.
    const override = await api(adminCookie, `/users/${createdUserId}/restore`, { method: 'POST' });
    check('an administrator can still restore it deliberately', override.status, 200);
    const finalState = await prisma.user.findUnique({
      where: { id: createdUserId },
      select: { status: true },
    });
    check('which does bring it back', finalState.status, 'ACTIVE');
  }

  section('A TERMINATED EMPLOYEE CANNOT BE GIVEN A LOGIN');

  {
    const terminatedEmployee = await prisma.employee.create({
      data: {
        companyId,
        employeeNumber: `${PREFIX}-0002`,
        firstName: 'Gone',
        lastName: 'Already',
        status: 'TERMINATED',
        terminationDate: new Date('2026-01-31'),
      },
    });

    const attempt = await api(adminCookie, '/users', {
      method: 'POST',
      body: {
        email: SECOND_EMAIL,
        firstName: 'Gone',
        lastName: 'Already',
        employeeId: terminatedEmployee.id,
        roleIds: [roles.find((r) => r.key === 'EMPLOYEE').id],
      },
    });
    check('creating a login for a terminated employee is refused', attempt.status, 422);

    const linkable = await api(adminCookie, '/users/linkable-employees');
    check('and they do not appear as linkable',
      linkable.body.data.some((e) => e.id === terminatedEmployee.id), false);
  }

  section('SESSION REVOCATION');

  {
    const cookie = await login(NEW_EMAIL, 'NewStarter@12345');
    const before = await api(cookie, '/me');
    check('the session works', before.status, 200);

    const revoked = await api(adminCookie, `/users/${createdUserId}/revoke-sessions`, {
      method: 'POST',
    });
    check('an administrator can revoke sessions', revoked.status, 200);
    truthy('and says how many', revoked.body.data.revoked >= 1);

    const after = await api(cookie, '/me');
    check('the session stops working', after.status, 401);

    // Revocation is not suspension: they can still sign in again.
    const signedIn = await tryLogin(NEW_EMAIL, 'NewStarter@12345');
    check('but the account still works', signedIn, 200);

    const managerAttempt = await api(managerCookie, `/users/${createdUserId}/revoke-sessions`, {
      method: 'POST',
    });
    check('a manager cannot revoke sessions', managerAttempt.status, 403);
  }

  section('PROTECTING THE ADMINISTRATOR');

  {
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'admin@hrms.local' },
      select: { id: true },
    });

    const self = await api(adminCookie, `/users/${admin.id}/suspend`, {
      method: 'POST',
      body: { reason: 'audit-users self suspension' },
    });
    check('an administrator cannot suspend themselves', self.status, 422);

    const selfRevoke = await api(adminCookie, `/users/${admin.id}/revoke-sessions`, {
      method: 'POST',
    });
    check('nor revoke their own sessions from here', selfRevoke.status, 422);

    const stillWorks = await api(adminCookie, '/users');
    check('and their session is untouched', stillWorks.status, 200);
  }

  section('PASSWORD RESET FROM THE ADMIN SCREEN');

  {
    const before = await prisma.passwordResetToken.count({ where: { userId: createdUserId } });

    const sent = await api(adminCookie, `/users/${createdUserId}/send-reset`, { method: 'POST' });
    check('a reset link can be sent', sent.status, 200);
    check('and the response carries no token', /token/i.test(sent.text), false);

    const after = await prisma.passwordResetToken.count({ where: { userId: createdUserId } });
    check('a token was issued', after, before + 1);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'user.password_reset.sent', entityId: createdUserId },
      orderBy: { createdAt: 'desc' },
    });
    truthy('it is audited', log !== null);
    check('and the audit entry carries no token', /token/i.test(JSON.stringify(log)), false);

    const managerAttempt = await api(managerCookie, `/users/${createdUserId}/send-reset`, {
      method: 'POST',
    });
    check('a manager cannot send one', managerAttempt.status, 403);
  }

  section('AUDIT TRAIL');

  {
    const logs = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'user.' } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
    const actions = new Set(logs.map((l) => l.action));

    truthy('creation is recorded', actions.has('user.create'));
    truthy('role changes are recorded', actions.has('user.roles.update'));
    truthy('suspension is recorded', actions.has('user.suspend'));
    truthy('restoration is recorded', actions.has('user.restore'));
    truthy('session revocation is recorded', actions.has('user.sessions.revoke'));
    truthy('reset initiation is recorded', actions.has('user.password_reset.sent'));

    const create = logs.find((l) => l.action === 'user.create');
    truthy('each entry names the actor', create.actorId !== null);
    truthy('and the account it concerns', create.entityId !== null);
    check('and carries no password material', /password|hash|token/i.test(JSON.stringify(create.after)), false);

    const invitation = await prisma.auditLog.findFirst({
      where: { action: 'auth.invitation.accepted', entityId: createdUserId },
    });
    truthy('accepting the invitation is recorded', invitation !== null);
  }

  section('UNLINKING AND RELINKING');

  {
    const unlinked = await api(adminCookie, `/users/${createdUserId}`, {
      method: 'PATCH',
      body: { firstName: 'Nadia', lastName: 'Karim', employeeId: null },
    });
    check('an account can be unlinked from its employee', unlinked.status, 200);

    const employee = await prisma.employee.findUnique({
      where: { id: fixtureEmployeeId },
      select: { userId: true },
    });
    check('the employee has no login again', employee.userId, null);

    const relinked = await api(adminCookie, `/users/${createdUserId}`, {
      method: 'PATCH',
      body: { firstName: 'Nadia', lastName: 'Karim', employeeId: fixtureEmployeeId },
    });
    check('and can be linked back', relinked.status, 200);

    const after = await prisma.employee.findUnique({
      where: { id: fixtureEmployeeId },
      select: { userId: true },
    });
    check('to the same account', after.userId, createdUserId);

    const takeSomeoneElses = await api(adminCookie, `/users/${createdUserId}`, {
      method: 'PATCH',
      body: { firstName: 'Nadia', lastName: 'Karim', employeeId: staffEmployeeId },
    });
    check('but not to an employee who already has one', takeSomeoneElses.status, 409);
  }

  section('THE SIGN-IN RATE LIMIT STILL BITES');

  {
    // Everything above deliberately spreads its sign-ins across addresses. This
    // block does the opposite, to prove the limiter the rest of the suite is
    // working around is genuinely still there.
    const ip = '198.51.100.42';
    let sawLimit = false;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const result = await attemptLogin('nobody@hrms.local', 'wrong-password', ip);
      if (result.status === 429) {
        sawLimit = true;
        break;
      }
    }
    check('repeated attempts from one address are rate limited', sawLimit, true);
  }

  section('OTHER MODULES ARE UNAFFECTED');

  {
    const employees = await api(adminCookie, '/employees?limit=1');
    check('employees still answer', employees.status, 200);

    const attendance = await api(adminCookie, '/attendance?limit=1');
    check('attendance still answers', attendance.status, 200);

    const payroll = await api(adminCookie, '/payroll/runs');
    check('payroll still answers', payroll.status, 200);

    const roleList = await api(adminCookie, '/roles');
    check('roles still answer', roleList.status, 200);

    const iclock = await fetch('http://127.0.0.1:4000/iclock/cdata?SN=NOPE');
    check('the device push endpoint still refuses an unknown device', iclock.status, 401);

    const seeded = await tryLogin('employee@hrms.local', 'Employee@12345');
    check('a seeded account still signs in', seeded, 200);
  }

  section('RESTORE');

  {
    await cleanup();

    const left = await prisma.user.count({ where: { email: { startsWith: PREFIX } } });
    check('test accounts removed', left, 0);
    const employeesLeft = await prisma.employee.count({
      where: { employeeNumber: { startsWith: PREFIX } },
    });
    check('test employees removed', employeesLeft, 0);
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
  try {
    await cleanup();
  } catch (cleanupError) {
    console.error('cleanup also failed:', cleanupError);
  }
} finally {
  await prisma.$disconnect();
}

console.log('\n################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
