/**
 * Phase 8 audit: ADMS push.
 *
 * Two halves. The first exercises the wire-format parser directly, because a
 * format parser is worth testing against captured device output rather than
 * against a server. The second drives the real HTTP endpoints exactly as a
 * terminal would - query string, plain-text body, no session - and then checks
 * the database to see that a pushed punch became attendance through the same
 * pipeline a polled one does.
 *
 * What it cannot prove: that a physical K50 sends this format. The encoder is
 * this suite and the decoder is the application, so a shared misunderstanding
 * of the firmware would pass here and fail on the wall.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-adms.mjs
 */
import { PrismaClient } from '@prisma/client';
import { deviceInputSchema } from '@hrms/shared';
import {
  parseAttlog,
  buildHandshake,
} from '../apps/api/src/modules/attendance-device/adms.protocol.ts';

const BASE = 'http://127.0.0.1:4000';
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
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

function truthy(label, actual) {
  check(label, Boolean(actual), true);
}

function section(title) {
  console.log(`\n################ ${title} ################`);
}

/** The device speaks plain text with a query string, never JSON. */
async function iclock(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body === null ? {} : { body, headers: { 'content-type': 'text/plain' } }),
  });
  return { status: response.status, text: await response.text() };
}

const ZONE = 'Asia/Karachi';
const SERIAL = 'AUDIT-ADMS-0001';
const OTHER_SERIAL = 'AUDIT-ADMS-0002';
const TOKEN = 'audit-push-token-8842';

let device = null;
let tokenDevice = null;
let employeeId = null;
let companyId = null;

/** A day far enough back that no other fixture or real record shares it. */
const DAY = '2026-03-17';

try {
  section('PROTOCOL: ATTLOG PARSING');

  {
    const body = [
      '1007\t2026-03-17 08:56:12\t0\t1\t0',
      '1007\t2026-03-17 18:14:03\t1\t1\t0',
    ].join('\r\n');
    const result = parseAttlog(body, ZONE);

    check('two well-formed records parse', result.punches.length, 2);
    check('no errors', result.errors.length, 0);
    check('the device user ID is read', result.punches[0].deviceUserId, '1007');
    check('the raw reading is preserved verbatim', result.punches[0].rawTimestamp, '2026-03-17 08:56:12');
    check('the punch state is read', result.punches[0].punchState, '0');
    check('the verify mode is read', result.punches[0].verifyMode, '1');
    check('ADMS carries no transaction id', result.punches[0].deviceTransactionId, null);

    // Karachi is UTC+5 with no daylight saving: 08:56:12 local is 03:56:12Z.
    check(
      'the device zone is applied to the reading',
      result.punches[0].punchedAt.toISOString(),
      '2026-03-17T03:56:12.000Z',
    );
    check(
      'seconds survive the conversion',
      result.punches[1].punchedAt.toISOString(),
      '2026-03-17T13:14:03.000Z',
    );
  }

  {
    // The same instant read as if the device were in UTC, to prove the zone is
    // actually consulted rather than assumed.
    const utc = parseAttlog('1007\t2026-03-17 08:56:12\t0\t1', 'UTC');
    check(
      'a device in another zone yields another instant',
      utc.punches[0].punchedAt.toISOString(),
      '2026-03-17T08:56:12.000Z',
    );
  }

  {
    const body = [
      '1007\t2026-03-17 08:00:00\t0\t1',
      '',
      'this is not a record',
      '1008\t2026-03-17 08:01:00\t0\t1',
      '1009\t17/03/2026 08:02:00\t0\t1',
      '\t2026-03-17 08:03:00\t0\t1',
      '1010\t1899-01-01 08:04:00\t0\t1',
    ].join('\n');
    const result = parseAttlog(body, ZONE);

    check('good records survive a batch with bad ones', result.punches.length, 2);
    check('each bad line is its own error', result.errors.length, 4);
    check('blank lines are skipped, not failed', result.skipped, 1);
    truthy('the error names the line number', result.errors[0].line > 0);
    truthy(
      'an implausible date is rejected',
      result.errors.some((e) => e.reason.includes('plausible')),
    );
    truthy(
      'a missing user id is rejected',
      result.errors.some((e) => e.reason.includes('device user ID')),
    );
  }

  {
    // Firmware that sends spaces instead of tabs. Real models do this.
    const result = parseAttlog('1007 2026-03-17 08:56:12 0 1 0', ZONE);
    check('space-separated firmware still parses', result.punches.length, 1);
    check('the date and time are rejoined', result.punches[0].rawTimestamp, '2026-03-17 08:56:12');
  }

  {
    // Fewer fields than the specification promises.
    const result = parseAttlog('1007\t2026-03-17 08:56:12', ZONE);
    check('a record with only the required fields parses', result.punches.length, 1);
    check('the missing state is null, not empty', result.punches[0].punchState, null);
  }

  {
    const result = parseAttlog('', ZONE);
    check('an empty body is not an error', result.errors.length, 0);
    check('and yields no punches', result.punches.length, 0);
  }

  section('PROTOCOL: HANDSHAKE');

  {
    const text = buildHandshake({
      serialNumber: SERIAL,
      pollIntervalSeconds: 30,
      timeZoneOffsetHours: 5,
    });
    truthy('the handshake names the device', text.startsWith(`GET OPTION FROM: ${SERIAL}`));
    truthy('it sets the attendance stamp', text.includes('ATTLOGStamp=None'));
    truthy('it sets the poll delay', text.includes('Delay=30'));
    truthy('it carries the timezone', text.includes('TimeZone=5'));
    truthy('it does not enable encryption the device cannot negotiate', text.includes('Encrypt=0'));
  }

  section('FIXTURES');

  {
    const company = await prisma.company.findFirst({ select: { id: true, timezone: true } });
    if (!company) throw new Error('No company exists. Seed the database first.');
    companyId = company.id;

    const employee = await prisma.employee.findFirst({
      where: { companyId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!employee) throw new Error('No active employee exists.');
    employeeId = employee.id;

    // Remove anything a previous run left behind.
    await prisma.attendanceRawPunch.deleteMany({
      where: { device: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } } },
    });
    await prisma.attendanceDeviceSync.deleteMany({
      where: { device: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } } },
    });
    await prisma.attendanceDeviceUserMapping.deleteMany({
      where: { device: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } } },
    });
    await prisma.attendanceDevice.deleteMany({
      where: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } },
    });

    device = await prisma.attendanceDevice.create({
      data: {
        companyId,
        name: 'Audit ADMS terminal',
        protocol: 'ZKTECO_ADMS',
        host: '127.0.0.1',
        port: 4370,
        serialNumber: SERIAL,
        timeZone: ZONE,
        isEnabled: true,
        syncIntervalMinutes: 15,
        punchPairing: 'FIRST_IN_LAST_OUT',
      },
    });

    await prisma.attendanceDeviceUserMapping.create({
      data: { companyId, deviceId: device.id, deviceUserId: '1007', employeeId, isActive: true },
    });

    truthy('an ADMS device exists', device.id.length > 0);
    check('it starts with no push recorded', device.lastPushAt, null);
  }

  section('AUTHENTICATION');

  {
    const unknown = await iclock('/iclock/cdata?SN=NO-SUCH-DEVICE&options=all');
    check('an unknown serial is refused', unknown.status, 401);
    truthy('and is told nothing useful', !unknown.text.includes('NO-SUCH-DEVICE'));

    const missing = await iclock('/iclock/cdata');
    check('a request with no serial is refused', missing.status, 401);

    const post = await iclock('/iclock/cdata?SN=NO-SUCH-DEVICE&table=ATTLOG', {
      method: 'POST',
      body: '1007\t2026-03-17 08:00:00\t0\t1',
    });
    check('an unknown serial cannot push either', post.status, 401);

    const stored = await prisma.attendanceRawPunch.count({ where: { deviceUserId: '1007', deviceId: device.id } });
    check('and nothing was stored', stored, 0);
  }

  {
    // A pull device must not accept pushes: its protocol says it is polled.
    const pullDevice = await prisma.attendanceDevice.create({
      data: {
        companyId,
        name: 'Audit ADMS pull-only',
        protocol: 'ZKTECO_TCP',
        host: '127.0.0.1',
        port: 4371,
        serialNumber: OTHER_SERIAL,
        timeZone: ZONE,
        isEnabled: true,
        syncIntervalMinutes: 15,
        punchPairing: 'FIRST_IN_LAST_OUT',
      },
    });

    const response = await iclock(`/iclock/cdata?SN=${OTHER_SERIAL}&options=all`);
    check('a pull device is refused the push endpoint', response.status, 401);

    await prisma.attendanceDevice.delete({ where: { id: pullDevice.id } });
  }

  {
    await prisma.attendanceDevice.update({ where: { id: device.id }, data: { isEnabled: false } });
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all`);
    check('a disabled device is refused', response.status, 401);

    const push = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `1007\t${DAY} 08:00:00\t0\t1`,
    });
    check('a disabled device cannot push', push.status, 401);
    const stored = await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } });
    check('and still nothing is stored', stored, 0);

    await prisma.attendanceDevice.update({ where: { id: device.id }, data: { isEnabled: true } });
  }

  section('HANDSHAKE OVER HTTP');

  {
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all&pushver=2.4.1`);
    check('a registered device gets its configuration', response.status, 200);
    truthy('the body is the OPTION block', response.text.startsWith(`GET OPTION FROM: ${SERIAL}`));
    truthy('it carries the Karachi offset', response.text.includes('TimeZone=5'));

    const after = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    truthy('contact is recorded', after.lastPushAt !== null);
    check('and the device reads as online', after.status, 'ONLINE');

    const syncs = await prisma.attendanceDeviceSync.count({ where: { deviceId: device.id } });
    check('a handshake does not create a sync row', syncs, 0);
  }

  {
    const lower = await iclock(`/iclock/cdata?sn=${SERIAL}&options=all`);
    check('firmware that sends a lowercase SN also works', lower.status, 200);

    const mixedCase = await iclock(`/iclock/cdata?SN=${SERIAL.toLowerCase()}&options=all`);
    check('a serial typed in the wrong case still matches', mixedCase.status, 200);
  }

  section('PUSHING ATTENDANCE');

  {
    const body = [`1007\t${DAY} 08:56:12\t0\t1\t0`, `1007\t${DAY} 18:14:03\t1\t1\t0`].join('\r\n');
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG&Stamp=9999`, {
      method: 'POST',
      body,
    });

    check('the device is answered in the form it expects', response.status, 200);
    check('and told how many records were taken', response.text.trim(), 'OK: 2');

    const punches = await prisma.attendanceRawPunch.findMany({
      where: { deviceId: device.id },
      orderBy: { punchedAt: 'asc' },
    });
    check('both punches are stored', punches.length, 2);
    check('the raw reading is preserved', punches[0].rawTimestamp, `${DAY} 08:56:12`);
    check('the device zone is stored with it', punches[0].deviceTimeZone, ZONE);
    check('the punch is mapped to the employee', punches[0].employeeId, employeeId);
    check('the company day is derived', punches[0].localDayKey, DAY);

    const sync = await prisma.attendanceDeviceSync.findFirst({
      where: { deviceId: device.id },
      orderBy: { startedAt: 'desc' },
    });
    check('the push is recorded in sync history', sync.trigger, 'PUSH');
    check('with a terminal status', sync.status, 'SUCCESS');
    check('the record count is kept', sync.fetched, 2);
    check('and the import count', sync.inserted, 2);
    check('nothing was rejected', sync.rejected, 0);
    truthy('and it is finished', sync.finishedAt !== null);
  }

  {
    const day = await prisma.attendanceRecord.findFirst({
      where: { employeeId, date: new Date(`${DAY}T00:00:00.000Z`) },
    });
    truthy('the day was scored from the pushed punches', day !== null);
    check('it reads as present', day.status, 'PRESENT');
    check('the first punch became the check-in', day.checkInAt.toISOString(), `${DAY}T03:56:12.000Z`);
    check('the last became the check-out', day.checkOutAt.toISOString(), `${DAY}T13:14:03.000Z`);
    check('the punches came from the device, not a person', day.source, 'DEVICE');
  }

  section('DUPLICATE PROTECTION');

  {
    // A terminal that does not get its acknowledgement resends the whole batch.
    const body = [`1007\t${DAY} 08:56:12\t0\t1\t0`, `1007\t${DAY} 18:14:03\t1\t1\t0`].join('\n');
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: 'POST', body });
    check('the resend is accepted', response.status, 200);

    const punches = await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } });
    check('but nothing is stored twice', punches, 2);

    const sync = await prisma.attendanceDeviceSync.findFirst({
      where: { deviceId: device.id },
      orderBy: { startedAt: 'desc' },
    });
    check('the repeat is counted as duplicates', sync.duplicates, 2);
    check('and not as imports', sync.inserted, 0);
    check('nor as errors', sync.rejected, 0);
  }

  section('MALFORMED RECORDS ARE ISOLATED');

  {
    const body = [
      `1007\t${DAY} 12:30:00\t0\t1`,
      'garbage that is not a record at all',
      `1007\t${DAY} 12:45:00\t0\t1`,
    ].join('\n');
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: 'POST', body });
    check('the batch is still accepted', response.status, 200);

    const punches = await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } });
    check('the readable records are stored', punches, 4);

    const sync = await prisma.attendanceDeviceSync.findFirst({
      where: { deviceId: device.id },
      orderBy: { startedAt: 'desc' },
    });
    check('the run is marked partial', sync.status, 'PARTIAL');
    check('the bad line is counted', sync.rejected, 1);
    check('the good ones are imported', sync.inserted, 2);
    truthy('the failure is described', Array.isArray(sync.errorDetails) && sync.errorDetails.length === 1);
    check('and marked as never retryable', sync.errorDetails[0].permanent, true);
  }

  section('UNMAPPED USERS');

  {
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `9999\t${DAY} 09:15:00\t0\t1`,
    });
    check('a punch from an unknown device user is accepted', response.status, 200);

    const punch = await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: device.id, deviceUserId: '9999' },
    });
    truthy('it is stored rather than discarded', punch !== null);
    check('with no employee attached', punch.employeeId, null);

    const sync = await prisma.attendanceDeviceSync.findFirst({
      where: { deviceId: device.id },
      orderBy: { startedAt: 'desc' },
    });
    check('and it is reported as unmapped', sync.unmapped, 1);
    check('not as an error', sync.rejected, 0);

    const employees = await prisma.employee.count({ where: { companyId } });
    truthy('no employee was invented for it', employees > 0);
    const invented = await prisma.employee.findFirst({ where: { companyId, employeeNumber: '9999' } });
    check('no employee record matches the device user id', invented, null);
  }

  section('OTHER TABLES ARE NOT INVENTED');

  {
    const before = await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } });
    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=OPERLOG`, {
      method: 'POST',
      body: 'OPLOG 1\t2026-03-17 09:00:00\tsomething the device did',
    });
    check('an operation log is acknowledged', response.status, 200);
    const after = await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } });
    check('but nothing is stored from it', after, before);
  }

  section('COMMANDS ARE NEVER ISSUED');

  {
    const response = await iclock(`/iclock/getrequest?SN=${SERIAL}`);
    check('the device is answered', response.status, 200);
    check('and given no command to run', response.text.trim(), 'OK');

    const cmd = await iclock(`/iclock/devicecmd?SN=${SERIAL}`, {
      method: 'POST',
      body: 'ID=1&Return=0',
    });
    check('a command result is acknowledged', cmd.status, 200);

    const unauthorised = await iclock('/iclock/getrequest?SN=NO-SUCH-DEVICE');
    check('an unknown device gets no commands either', unauthorised.status, 401);
  }

  section('PATH TOKEN');

  {
    // A serial number is printed on the case. The token is what makes the URL
    // a credential rather than a label.
    const { encryptSecret } = await import('../apps/api/src/core/secrets.ts');
    tokenDevice = await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { pushTokenCipher: encryptSecret(TOKEN) },
    });

    const withoutToken = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all`);
    check('the plain path stops working once a token is set', withoutToken.status, 401);

    const wrongToken = await iclock(`/iclock/wrong-token/cdata?SN=${SERIAL}&options=all`);
    check('a wrong token is refused', wrongToken.status, 401);
    check('and looks exactly like an unknown device', wrongToken.text.trim(), 'Unauthorized');

    const rightToken = await iclock(`/iclock/${TOKEN}/cdata?SN=${SERIAL}&options=all`);
    check('the right token is accepted', rightToken.status, 200);

    const pushed = await iclock(`/iclock/${TOKEN}/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `1007\t${DAY} 14:00:00\t0\t1`,
    });
    check('and can push', pushed.status, 200);

    const blocked = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `1007\t${DAY} 15:00:00\t0\t1`,
    });
    check('while an untokened push is refused', blocked.status, 401);

    const stranded = await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: device.id, rawTimestamp: `${DAY} 15:00:00` },
    });
    check('and stores nothing', stranded, null);

    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { pushTokenCipher: null },
    });
  }

  section('SAVING A DEVICE DOES NOT DISCARD ITS TOKEN');

  {
    // The token box is write-only, so an administrator editing anything else
    // submits it blank. If blank were rejected, or treated as "clear it", the
    // device would silently stop being able to push after an unrelated edit.
    const { encryptSecret } = await import('../apps/api/src/core/secrets.ts');
    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { pushTokenCipher: encryptSecret(TOKEN) },
    });

    const parsed = deviceInputSchema.safeParse({
      name: 'Audit ADMS terminal',
      protocol: 'ZKTECO_ADMS',
      host: '127.0.0.1',
      port: 4370,
      serialNumber: SERIAL,
      timeZone: ZONE,
      isEnabled: true,
      syncIntervalMinutes: 15,
      punchPairing: 'FIRST_IN_LAST_OUT',
      pushToken: '',
      allowedPushCidrs: [],
    });
    check('a blank token box passes validation', parsed.success, true);

    const withToken = deviceInputSchema.safeParse({
      name: 'x',
      protocol: 'ZKTECO_ADMS',
      host: '127.0.0.1',
      port: 4370,
      timeZone: ZONE,
      pushToken: 'short',
      allowedPushCidrs: [],
    });
    check('but a too-short one does not', withToken.success, false);

    const still = await iclock(`/iclock/${TOKEN}/cdata?SN=${SERIAL}&options=all`);
    check('the stored token still admits the device', still.status, 200);

    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { pushTokenCipher: null },
    });
  }

  section('SOURCE ADDRESS RESTRICTION');

  {
    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { allowedPushCidrs: ['10.99.0.0/16'] },
    });

    const blocked = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all`);
    check('a device pushing from outside the allow-list is refused', blocked.status, 403);

    const push = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `1007\t${DAY} 16:00:00\t0\t1`,
    });
    check('and cannot push', push.status, 403);
    const stored = await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: device.id, rawTimestamp: `${DAY} 16:00:00` },
    });
    check('nothing from it is stored', stored, null);

    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { allowedPushCidrs: ['127.0.0.0/8'] },
    });
    const allowed = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all`);
    check('a device inside the allow-list is admitted', allowed.status, 200);

    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { allowedPushCidrs: [] },
    });
    const open = await iclock(`/iclock/cdata?SN=${SERIAL}&options=all`);
    check('an empty allow-list means anywhere', open.status, 200);
  }

  section('MANUAL ATTENDANCE IS NOT OVERWRITTEN');

  {
    const manualDay = '2026-03-18';
    const manualDate = new Date(`${manualDay}T00:00:00.000Z`);
    await prisma.attendanceRecord.deleteMany({ where: { employeeId, date: manualDate } });
    const manual = await prisma.attendanceRecord.create({
      data: {
        companyId,
        employeeId,
        date: manualDate,
        status: 'PRESENT',
        source: 'ADMIN',
        checkInAt: new Date(`${manualDay}T04:00:00.000Z`),
        checkOutAt: new Date(`${manualDay}T13:00:00.000Z`),
      },
    });

    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
      method: 'POST',
      body: `1007\t${manualDay} 10:30:00\t0\t1`,
    });
    check('the push is accepted', response.status, 200);

    const after = await prisma.attendanceRecord.findUnique({ where: { id: manual.id } });
    check('the administrator entry still stands', after.source, 'ADMIN');
    check('its check-in is untouched', after.checkInAt.toISOString(), manual.checkInAt.toISOString());
    check('and its check-out', after.checkOutAt.toISOString(), manual.checkOutAt.toISOString());

    const raw = await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: device.id, rawTimestamp: `${manualDay} 10:30:00` },
    });
    truthy('while the device reading is still kept', raw !== null);

    await prisma.attendanceRecord.delete({ where: { id: manual.id } });
  }

  section('THE CURSOR IS LEFT TO THE PULL PATH');

  {
    const before = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    check('a pushing device has no watermark of its own', before.syncCursorAt, null);

    const syncs = await prisma.attendanceDeviceSync.findMany({
      where: { deviceId: device.id, trigger: 'PUSH' },
      orderBy: { startedAt: 'desc' },
      take: 1,
    });
    check('and no push moves one', syncs[0].cursorTo, null);
  }

  section('OFFLINE BACKLOG');

  {
    // A terminal that lost the network for three days posts everything at once.
    const backlogDays = ['2026-03-20', '2026-03-21', '2026-03-22'];
    const body = backlogDays.flatMap((d) => [
      `1007\t${d} 09:00:00\t0\t1`,
      `1007\t${d} 17:30:00\t1\t1`,
    ]).join('\n');

    const response = await iclock(`/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: 'POST', body });
    check('the whole backlog is accepted at once', response.text.trim(), 'OK: 6');

    const days = await prisma.attendanceRecord.findMany({
      where: { employeeId, date: { in: backlogDays.map((d) => new Date(`${d}T00:00:00.000Z`)) } },
      orderBy: { date: 'asc' },
    });
    check('every day in it is scored', days.length, 3);
    check('none of them is lost to the age of the record', days.filter((d) => d.status === 'PRESENT').length, 3);
    check(
      'and the times are the ones the device recorded',
      days[0].checkInAt.toISOString(),
      '2026-03-20T04:00:00.000Z',
    );
  }

  section('A PUSHING DEVICE IS NEVER POLLED');

  {
    // The scheduler opens connections. A pushing terminal is not listening for
    // one, so polling it would fail on every tick and record a working device
    // as broken. Run the real scheduler and check it leaves this one alone.
    // Force it to be due. Without this the last push has already set
    // lastSyncAt and the device is not due, so the check would prove nothing.
    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { lastSyncAt: null, status: 'ONLINE', lastError: null },
    });

    const before = await prisma.attendanceDeviceSync.count({
      where: { deviceId: device.id, trigger: 'SCHEDULED' },
    });

    const { syncDueDevices } = await import(
      '../apps/api/src/modules/attendance-device/sync.service.ts'
    );
    await syncDueDevices();

    const after = await prisma.attendanceDeviceSync.count({
      where: { deviceId: device.id, trigger: 'SCHEDULED' },
    });
    check('the scheduler does not try to poll it', after, before);

    const row = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    check('so it is not marked as failing', row.status, 'ONLINE');
    check('and carries no error', row.lastError, null);
  }

  section('THE PUSH ENDPOINT EXPOSES NOTHING');

  {
    // Anything beyond the four calls a terminal makes must not exist.
    const paths = [
      '/iclock/cdata/../../api/v1/employees',
      `/iclock/rtdata?SN=${SERIAL}`,
      `/iclock/querydata?SN=${SERIAL}`,
      `/iclock/fdata?SN=${SERIAL}`,
    ];
    for (const path of paths) {
      const response = await iclock(path);
      truthy(`${path} is not served`, response.status === 404 || response.status === 401);
      truthy(`${path} leaks no employee data`, !response.text.includes('firstName'));
    }
  }

  section('THE API IS STILL PROTECTED');

  {
    // The push routes are unauthenticated; nothing else may have become so.
    const devices = await fetch(`${BASE}/api/v1/attendance/devices`);
    check('the device list still needs a session', devices.status, 401);

    const punches = await fetch(`${BASE}/api/v1/attendance/punches`);
    check('raw punches still need a session', punches.status, 401);

    const employees = await fetch(`${BASE}/api/v1/employees`);
    check('employees still need a session', employees.status, 401);
  }

  section('RESTORE');

  {
    await prisma.attendanceRecord.deleteMany({
      where: {
        employeeId,
        date: {
          in: [DAY, '2026-03-20', '2026-03-21', '2026-03-22'].map(
            (d) => new Date(`${d}T00:00:00.000Z`),
          ),
        },
      },
    });
    await prisma.attendanceRawPunch.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDeviceSync.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDeviceUserMapping.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDevice.delete({ where: { id: device.id } });

    const left = await prisma.attendanceDevice.count({
      where: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } },
    });
    check('test devices removed', left, 0);

    const days = await prisma.attendanceRecord.count({
      where: {
        employeeId,
        date: { in: [DAY, '2026-03-20'].map((d) => new Date(`${d}T00:00:00.000Z`)) },
      },
    });
    check('test days removed', days, 0);
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
} finally {
  await prisma.$disconnect();
}

console.log(`\n################ SUMMARY ################`);
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
