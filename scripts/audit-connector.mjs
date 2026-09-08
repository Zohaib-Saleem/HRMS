/**
 * Audit: the LAN connector ingest path.
 *
 * Two halves, like the ADMS suite next to it. The first exercises the pure
 * functions directly - the timestamp decoder, the drift calculation and the
 * cursor hint - because those are where a timezone mistake turns into a wrong
 * attendance day, and they deserve to be tested without a socket or a request.
 * The second drives the real HTTP endpoints exactly as a connector would, then
 * checks the database to see that a connector punch became attendance through
 * the same pipeline a polled one does.
 *
 * What it cannot prove: that a physical terminal on a real LAN yields these
 * readings. The connector is not the subject here - the server's half of the
 * contract is.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-connector.mjs
 */
import { PrismaClient } from '@prisma/client';
import {
  toDevicePunches,
  driftMinutes,
  cursorHintFor,
} from '../apps/api/src/modules/attendance-device/connector.service.ts';

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

/** The connector speaks JSON with a bearer token, never a session cookie. */
async function connector(path, { method = 'GET', body, token = TOKEN } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
}

const ZONE = 'Asia/Karachi';
const SERIAL = 'AUDIT-CONN-0001';
const OTHER_SERIAL = 'AUDIT-CONN-0002';
const TOKEN = 'audit-connector-token-5591';

let device = null;
let employeeId = null;
let companyId = null;

/** A day far enough back that no other fixture or real record shares it. */
const DAY = '2026-04-14';

try {
  section('DECODE: WALL CLOCK TO INSTANT');

  {
    const { punches, rejected } = toDevicePunches(
      [
        { deviceUserId: '1007', rawTimestamp: `${DAY} 08:56:12`, punchState: '0', verifyMode: '1' },
        { deviceUserId: '1007', rawTimestamp: `${DAY} 18:14:03`, punchState: '1', verifyMode: '1' },
      ],
      ZONE,
    );

    check('two well-formed readings decode', punches.length, 2);
    check('nothing is rejected', rejected.length, 0);
    check('the PIN is read', punches[0].deviceUserId, '1007');
    check('the raw reading is preserved verbatim', punches[0].rawTimestamp, `${DAY} 08:56:12`);
    check('the direction is preserved', punches[0].punchState, '0');

    // Karachi is UTC+5 with no daylight saving: 08:56:12 local is 03:56:12Z.
    // This is the assertion that catches a zone applied backwards, which is the
    // failure that silently shifts every imported time by hours.
    check('the instant is the device zone applied', punches[0].punchedAt.toISOString(), `${DAY}T03:56:12.000Z`);
    check('seconds survive the conversion', punches[1].punchedAt.toISOString(), `${DAY}T13:14:03.000Z`);
  }

  {
    // The ISO 'T' separator and a missing seconds field both appear in the
    // wild, from connectors written against different client libraries.
    const { punches } = toDevicePunches(
      [
        { deviceUserId: '1007', rawTimestamp: `${DAY}T08:56:12` },
        { deviceUserId: '1007', rawTimestamp: `${DAY} 08:56` },
      ],
      ZONE,
    );
    check('a T separator is accepted', punches[0].punchedAt.toISOString(), `${DAY}T03:56:12.000Z`);
    check('missing seconds mean zero, not a rejection', punches[1].punchedAt.toISOString(), `${DAY}T03:56:00.000Z`);
    check('and the stored reading is normalised', punches[1].rawTimestamp, `${DAY} 08:56:00`);
  }

  {
    const { punches, rejected } = toDevicePunches(
      [
        { deviceUserId: '1007', rawTimestamp: '14/04/2026 08:56' },
        { deviceUserId: '1008', rawTimestamp: `${DAY} 09:00:00` },
      ],
      ZONE,
    );
    // One bad reading must not cost the batch. A connector catching up after an
    // outage sends a week in one request; a single corrupt record must not take
    // the other six days with it.
    check('an unreadable reading is rejected on its own', rejected.length, 1);
    check('and the good one still decodes', punches.length, 1);
    check('the rejection is permanent - resending will not help', rejected[0].permanent, true);
    check('and it names the offending PIN', rejected[0].deviceUserId, '1007');
  }

  {
    const { punches, rejected } = toDevicePunches(
      [{ deviceUserId: '1007', rawTimestamp: '1970-01-01 00:00:00' }],
      ZONE,
    );
    check('an implausible instant is refused', rejected.length, 1);
    check('and no punch is produced', punches.length, 0);
  }

  {
    const { rejected } = toDevicePunches(
      [{ deviceUserId: '1007', rawTimestamp: `${DAY} 08:00:00` }],
      'Not/A_Zone',
    );
    check('an unreadable zone rejects the record', rejected.length, 1);
    // A zone this runtime cannot read is a configuration fault somebody can
    // fix, so the record is worth sending again once they have.
    check('but not permanently', rejected[0].permanent, false);
  }

  section('DECODE: CLOCK DRIFT');

  {
    check('no reading means no drift', driftMinutes(null, ZONE), null);
    check('an unreadable reading means no drift', driftMinutes('not a time', ZONE), null);

    const now = new Date();
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const get = (type) => local.find((p) => p.type === type).value;
    const stamp = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;

    check('a terminal in step with the server reads as no drift', driftMinutes(stamp, ZONE), 0);

    const ahead = new Date(now.getTime() + 20 * 60000);
    const aheadParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(ahead);
    const getAhead = (type) => aheadParts.find((p) => p.type === type).value;
    const aheadStamp = `${getAhead('year')}-${getAhead('month')}-${getAhead('day')} ${getAhead('hour')}:${getAhead('minute')}:${getAhead('second')}`;
    check('a terminal 20 minutes fast reports as such', driftMinutes(aheadStamp, ZONE), 20);
  }

  section('FIXTURES');

  {
    const company = await prisma.company.findFirst({ select: { id: true } });
    if (!company) throw new Error('No company exists. Seed the database first.');
    companyId = company.id;

    const employee = await prisma.employee.findFirst({
      where: { companyId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!employee) throw new Error('No active employee exists.');
    employeeId = employee.id;

    // Remove anything a previous run left behind.
    const serials = { serialNumber: { in: [SERIAL, OTHER_SERIAL] } };
    await prisma.attendanceRawPunch.deleteMany({ where: { device: serials } });
    await prisma.attendanceDeviceSync.deleteMany({ where: { device: serials } });
    await prisma.attendanceDeviceUserMapping.deleteMany({ where: { device: serials } });
    await prisma.attendanceDeviceEnrolledUser.deleteMany({ where: { device: serials } });
    await prisma.attendanceDevice.deleteMany({ where: serials });

    const { encryptSecret } = await import('../apps/api/src/core/secrets.ts');

    device = await prisma.attendanceDevice.create({
      data: {
        companyId,
        name: 'Audit connector terminal',
        protocol: 'ZKTECO_LAN_CONNECTOR',
        host: '192.168.44.201',
        port: 4370,
        serialNumber: SERIAL,
        timeZone: ZONE,
        isEnabled: true,
        syncIntervalMinutes: 15,
        punchPairing: 'FIRST_IN_LAST_OUT',
        pushTokenCipher: encryptSecret(TOKEN),
      },
    });

    await prisma.attendanceDeviceUserMapping.create({
      data: { companyId, deviceId: device.id, deviceUserId: '1007', employeeId, isActive: true },
    });

    truthy('a connector device exists', device.id.length > 0);
    check('it starts with nothing received', device.lastPushAt, null);
    check('and no connector version recorded', device.connectorVersion, null);
    check('a device with no punches has no cursor hint', cursorHintFor(device), null);
  }

  section('AUTHENTICATION');

  {
    const noToken = await connector(`/connector/handshake?serialNumber=${SERIAL}`, { token: null });
    check('a request with no token is refused', noToken.status, 401);

    const wrongToken = await connector(`/connector/handshake?serialNumber=${SERIAL}`, { token: 'wrong' });
    check('a wrong token is refused', wrongToken.status, 401);

    const unknown = await connector('/connector/handshake?serialNumber=NO-SUCH-DEVICE');
    check('an unknown serial is refused', unknown.status, 401);
    check('and identically, so probing teaches nothing', unknown.body?.error?.message, wrongToken.body?.error?.message);
    truthy('the refusal names no serial', !unknown.text.includes('NO-SUCH-DEVICE'));

    const noSerial = await connector('/connector/handshake');
    check('a request with no serial is refused', noSerial.status, 401);
  }

  {
    // A pull device must not accept connector deliveries: its protocol says
    // this server dials it, and a connector posting to it would mean nobody
    // ever noticed the route was gone.
    const pullDevice = await prisma.attendanceDevice.create({
      data: {
        companyId,
        name: 'Audit connector pull-only',
        protocol: 'ZKTECO_TCP',
        host: '127.0.0.1',
        port: 4371,
        serialNumber: OTHER_SERIAL,
        timeZone: ZONE,
        isEnabled: true,
        syncIntervalMinutes: 15,
        punchPairing: 'FIRST_IN_LAST_OUT',
        pushTokenCipher: (await import('../apps/api/src/core/secrets.ts')).encryptSecret(TOKEN),
      },
    });

    const response = await connector(`/connector/handshake?serialNumber=${OTHER_SERIAL}`);
    check('a pull device refuses the connector endpoint', response.status, 401);

    await prisma.attendanceDevice.delete({ where: { id: pullDevice.id } });
  }

  {
    await prisma.attendanceDevice.update({ where: { id: device.id }, data: { pushTokenCipher: null } });
    const response = await connector(`/connector/handshake?serialNumber=${SERIAL}`);
    // Deliberately not a 401. A device with no token is a half-finished setup,
    // and the person reading the connector log is the administrator who has to
    // finish it; "not registered" would send them hunting the wrong problem.
    check('a device with no token set refuses with a conflict', response.status, 409);
    truthy('and says what is missing', /token/i.test(response.body?.error?.message ?? ''));

    const { encryptSecret } = await import('../apps/api/src/core/secrets.ts');
    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { pushTokenCipher: encryptSecret(TOKEN) },
    });
  }

  {
    await prisma.attendanceDevice.update({ where: { id: device.id }, data: { isEnabled: false } });
    const response = await connector(`/connector/handshake?serialNumber=${SERIAL}`);
    check('a disabled device is refused', response.status, 401);

    const push = await connector('/connector/punches', {
      method: 'POST',
      body: { serialNumber: SERIAL, punches: [{ deviceUserId: '1007', rawTimestamp: `${DAY} 08:00:00` }] },
    });
    check('a disabled device cannot receive a batch', push.status, 401);
    check('and nothing is stored', await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } }), 0);

    await prisma.attendanceDevice.update({ where: { id: device.id }, data: { isEnabled: true } });
  }

  {
    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { allowedPushCidrs: ['203.0.113.0/24'] },
    });
    const response = await connector(`/connector/handshake?serialNumber=${SERIAL}`);
    // 403 rather than 401: the caller is known, the network is not.
    check('a connector outside the allowed network is refused', response.status, 403);

    await prisma.attendanceDevice.update({
      where: { id: device.id },
      data: { allowedPushCidrs: [] },
    });
  }

  section('HANDSHAKE');

  {
    const response = await connector(`/connector/handshake?serialNumber=${SERIAL}`);
    check('a registered connector gets its configuration', response.status, 200);
    check('it is told the device timezone', response.body?.data?.timeZone, ZONE);
    check('and the poll interval to use', response.body?.data?.pollIntervalMinutes, 15);
    check('and the device it is serving', response.body?.data?.serialNumber, SERIAL);
    check('with no cursor hint yet', response.body?.data?.cursorHint, null);
    truthy('and the server clock, for drift', Boolean(response.body?.data?.serverTime));

    const after = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    truthy('contact is recorded', after.lastPushAt !== null);
    check('and the device reads as online', after.status, 'ONLINE');
    check('a handshake does not create a sync row', await prisma.attendanceDeviceSync.count({ where: { deviceId: device.id } }), 0);
  }

  section('PUNCH INGEST');

  {
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        connectorVersion: '1.0.0',
        deviceTime: `${DAY} 18:20:00`,
        punches: [
          { deviceUserId: '1007', rawTimestamp: `${DAY} 08:56:12`, punchState: '0' },
          { deviceUserId: '1007', rawTimestamp: `${DAY} 18:14:03`, punchState: '1' },
        ],
      },
    });

    check('the batch is accepted', response.status, 200);
    check('both records are counted', response.body?.data?.received, 2);
    check('both are imported', response.body?.data?.imported, 2);
    check('none is a duplicate', response.body?.data?.duplicates, 0);
    check('none is unmapped', response.body?.data?.unmapped, 0);
    truthy('a cursor hint comes back', Boolean(response.body?.data?.cursorHint));

    const punches = await prisma.attendanceRawPunch.findMany({
      where: { deviceId: device.id },
      orderBy: { punchedAt: 'asc' },
    });
    check('two raw punches are stored', punches.length, 2);
    check('at the device-zone instant', punches[0].punchedAt.toISOString(), `${DAY}T03:56:12.000Z`);
    check('and attributed to the mapped employee', punches[0].employeeId, employeeId);

    const day = await prisma.attendanceRecord.findFirst({
      where: { employeeId, date: new Date(`${DAY}T00:00:00.000Z`) },
    });
    truthy('an attendance day is derived from them', day !== null);

    const after = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    check('the connector version is recorded', after.connectorVersion, '1.0.0');
    // The pull watermark belongs to server-side polling. Advancing it here
    // would let a later direct poll skip records the connector never sent.
    check('the pull cursor is untouched', after.syncCursorAt, null);
    truthy('but the last punch is advanced', after.lastPunchAt !== null);

    const sync = await prisma.attendanceDeviceSync.findFirst({ where: { deviceId: device.id } });
    check('the batch appears in sync history', sync.trigger, 'PUSH');
    check('as a success', sync.status, 'SUCCESS');
    check('with the record count', sync.fetched, 2);
  }

  {
    // The same transaction arriving twice - a connector that lost its
    // watermark, or resent after a timeout it never saw the answer to.
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        punches: [{ deviceUserId: '1007', rawTimestamp: `${DAY} 08:56:12`, punchState: '0' }],
      },
    });

    check('a replayed record is accepted', response.status, 200);
    check('but recognised as a duplicate', response.body?.data?.duplicates, 1);
    check('and not imported again', response.body?.data?.imported, 0);
    check('so the stored count is unchanged', await prisma.attendanceRawPunch.count({ where: { deviceId: device.id } }), 2);
  }

  {
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        punches: [{ deviceUserId: '9999', rawTimestamp: `${DAY} 09:00:00` }],
      },
    });

    check('a PIN nobody has mapped is accepted', response.status, 200);
    check('and reported as unmapped', response.body?.data?.unmapped, 1);

    const stored = await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: device.id, deviceUserId: '9999' },
    });
    // Kept, not discarded: mapping the PIN later must be able to attribute it
    // retrospectively, which is only possible if the punch was stored.
    truthy('the punch is still stored', stored !== null);
    check('with nobody attached', stored.employeeId, null);
  }

  {
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: { serialNumber: SERIAL, punches: [] },
    });
    check('an empty batch is accepted', response.status, 200);
    check('and creates no sync row', response.body?.data?.syncId, null);
  }

  {
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        punches: Array.from({ length: 1001 }, () => ({
          deviceUserId: '1007',
          rawTimestamp: `${DAY} 08:00:00`,
        })),
      },
    });
    // A batch too big to finish is a batch that is retried forever.
    check('an oversized batch is refused as invalid input', response.status, 422);
  }

  {
    const response = await connector('/connector/punches', {
      method: 'POST',
      body: { serialNumber: SERIAL, punches: [{ deviceUserId: '1007', rawTimestamp: 'yesterday' }] },
    });
    check('a malformed reading is a client error, not a server one', response.status, 422);
  }

  section('CURSOR HINT');

  {
    const response = await connector(`/connector/handshake?serialNumber=${SERIAL}`);
    check('the handshake now carries a hint', response.body?.data?.cursorHint, `${DAY} 18:14:03`);
    // Expressed as a device wall-clock reading, because that is the only form
    // the connector can compare against without knowing the device timezone -
    // and not knowing it is what keeps the zone one setting in one place.
  }

  section('ENROLMENT ROSTER');

  {
    const response = await connector('/connector/roster', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        connectorVersion: '1.0.1',
        users: [
          { deviceUserId: '1007', name: 'AHMED', privilege: 0, cardNumber: '00123' },
          { deviceUserId: '1008', name: 'FATIMA', privilege: 0 },
          { deviceUserId: '1009', name: 'BILAL', privilege: 14 },
        ],
      },
    });

    check('the roster is accepted', response.status, 200);
    check('all three are stored', response.body?.data?.stored, 3);
    check('two of them are not mapped to anyone', response.body?.data?.unmapped, 2);

    const stored = await prisma.attendanceDeviceEnrolledUser.findMany({
      where: { deviceId: device.id },
      orderBy: { deviceUserId: 'asc' },
    });
    check('three roster rows exist', stored.length, 3);
    check('with the name typed into the terminal', stored[0].name, 'AHMED');
    check('and the card number', stored[0].cardNumber, '00123');

    // The roster is a cache for the mapping screen. It must never decide whose
    // attendance a punch became.
    check('no mapping was invented', await prisma.attendanceDeviceUserMapping.count({ where: { deviceId: device.id } }), 1);

    const after = await prisma.attendanceDevice.findUnique({ where: { id: device.id } });
    check('the connector version is updated', after.connectorVersion, '1.0.1');
  }

  {
    const response = await connector('/connector/roster', {
      method: 'POST',
      body: {
        serialNumber: SERIAL,
        users: [{ deviceUserId: '1007', name: 'AHMED KHAN' }],
      },
    });

    check('a shorter roster is accepted', response.status, 200);
    const stored = await prisma.attendanceDeviceEnrolledUser.findMany({ where: { deviceId: device.id } });
    // A stale roster is worse than a short one: it invites somebody to map a
    // PIN the terminal no longer holds.
    check('users the terminal no longer holds are dropped', stored.length, 1);
    check('and the remaining name is updated', stored[0].name, 'AHMED KHAN');
  }

  {
    const response = await connector('/connector/roster', {
      method: 'POST',
      body: { serialNumber: SERIAL, users: [] },
      token: 'wrong',
    });
    check('the roster endpoint checks the token too', response.status, 401);
    check('and did not clear the roster', await prisma.attendanceDeviceEnrolledUser.count({ where: { deviceId: device.id } }), 1);
  }

  section('WHAT THE ENDPOINTS CANNOT DO');

  {
    // The connector holds a credential that lives in a config file on somebody
    // else's network. It must not be a key to the API.
    const devices = await connector('/api/v1/attendance/devices');
    check('the token does not open the devices API', devices.status, 401);

    const employees = await connector('/api/v1/employees');
    check('nor the employee directory', employees.status, 401);

    const punches = await connector('/api/v1/attendance/punches');
    check('nor anyone else attendance', punches.status, 401);
  }

  section('RESTORE');

  {
    await prisma.attendanceRecord.deleteMany({
      where: { employeeId, date: new Date(`${DAY}T00:00:00.000Z`) },
    });
    await prisma.attendanceRawPunch.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDeviceSync.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDeviceUserMapping.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDeviceEnrolledUser.deleteMany({ where: { deviceId: device.id } });
    await prisma.attendanceDevice.delete({ where: { id: device.id } });

    check(
      'test devices removed',
      await prisma.attendanceDevice.count({ where: { serialNumber: { in: [SERIAL, OTHER_SERIAL] } } }),
      0,
    );
    check(
      'test days removed',
      await prisma.attendanceRecord.count({
        where: { employeeId, date: new Date(`${DAY}T00:00:00.000Z`) },
      }),
      0,
    );
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
