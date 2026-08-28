/**
 * End-to-end verification of the attendance-terminal integration.
 *
 * Runs a simulator that speaks the real ZKTeco wire protocol on a real socket,
 * points the HRMS at it, and drives the whole path: connect, pull, store raw
 * punches, resolve employees, score the day through the existing attendance
 * engine, and surface the result.
 *
 * Repeatable: it creates its own devices, removes them at the end, and restores
 * the company timezone it started with.
 *
 *   npx tsx scripts/audit-zkt.mjs
 */
import { PrismaClient } from '@prisma/client';
import { startSimulator, punch } from './zkt-simulator.mjs';

const BASE = 'http://localhost:5173/api/v1';
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const check = (label, expected, actual) => {
  const e = String(expected);
  const a = String(actual);
  if (e === a) {
    console.log(`  PASS  ${label} (${a})`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label} - expected ${e}, got ${a}`);
    fail += 1;
  }
};
const info = (msg) => console.log(`  INFO  ${msg}`);
const section = (title) => console.log(`\n################ ${title} ################`);

// --- a cookie jar, because sessions are cookie-based -----------------------
function makeClient() {
  const jar = new Map();
  return async (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const response = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, data: body?.data ?? null };
  };
}

const login = async (email, password) => {
  const client = makeClient();
  const res = await client('/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status}`);
  return client;
};

const KHI = 'Asia/Karachi';
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  const admin = await login('admin@hrms.local', 'Admin@12345');
  const manager = await login('manager@hrms.local', 'Manager@12345');
  const employee = await login('employee@hrms.local', 'Employee@12345');
  info('signed in as admin, manager and employee');

  const company = (await admin('/company')).data;
  const originalTimeZone = company.timezone;

  // Attendance is calculated in the company zone; these tests are about a
  // Pakistan deployment, so set it and restore afterwards.
  await admin('/company', {
    method: 'PATCH',
    body: {
      name: company.name,
      legalName: company.legalName,
      email: company.email,
      phone: company.phone,
      website: company.website,
      addressLine1: company.addressLine1,
      addressLine2: company.addressLine2,
      city: company.city,
      state: company.state,
      postalCode: company.postalCode,
      country: company.country,
      timezone: KHI,
      currency: company.currency,
      dateFormat: company.dateFormat,
      weekStartsOn: company.weekStartsOn,
    },
  });
  info(`company timezone set to ${KHI} for the run (was ${originalTimeZone})`);

  const employees = (await admin('/employees?limit=100')).data;
  const kwame = employees.find((e) => e.firstName === 'Kwame');
  const tomas = employees.find((e) => e.firstName === 'Tomas');
  const shifts = (await admin('/shifts?limit=20')).data;
  const general = shifts.find((s) => s.name === 'General'); // 09:00-18:00

  // Kwame keeps the 09:00-18:00 shift so late, early and overtime have a
  // reference point.
  await admin('/shifts/assignments', {
    method: 'POST',
    body: { employeeId: kwame.id, shiftId: general.id, effectiveFrom: '2026-01-01' },
  });

  // Clean anything a previous run left, so every run is a first run.
  await prisma.attendanceRawPunch.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDeviceSync.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDeviceUserMapping.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDevice.deleteMany({ where: { name: { startsWith: 'ZKT Test' } } });

  const D = '2026-08-10'; // a Monday
  const sim = await startSimulator({
    port: 14370,
    punches: [
      punch('1007', `${D} 08:56:12`, 0),
      punch('1007', `${D} 18:14:03`, 1),
      punch('9999', `${D} 09:01:00`, 0), // nobody the HRMS knows
    ],
  });
  info(`simulator listening on 127.0.0.1:${sim.port}`);

  // ------------------------------------------------------------------------
  section('1. DEVICE CONFIGURATION AND SECURITY');

  const created = await admin('/attendance/devices', {
    method: 'POST',
    body: {
      name: 'ZKT Test Main',
      protocol: 'ZKTECO_TCP',
      host: '127.0.0.1',
      port: sim.port,
      timeZone: KHI,
      isEnabled: true,
      syncIntervalMinutes: 15,
      punchPairing: 'FIRST_IN_LAST_OUT',
      commKey: '123456',
    },
  });
  check('admin creates a device', 201, created.status);
  const deviceId = created.data.id;

  check('the comm key is never returned', false, 'commKey' in (created.data ?? {}));
  check('only whether one is set', true, created.data.hasCommKey);
  const stored = await prisma.attendanceDevice.findUnique({ where: { id: deviceId } });
  check('and it is not stored in plaintext', false, String(stored.commKeyCipher).includes('123456'));
  check('it is stored encrypted', true, String(stored.commKeyCipher).startsWith('v1.'));

  check('an invalid timezone is rejected', 422,
    (await admin('/attendance/devices', { method: 'POST', body: { name: 'ZKT Test Bad', host: '10.0.0.9', port: 4370, timeZone: 'Mars/Olympus' } })).status);
  check('a duplicate name is rejected', 409,
    (await admin('/attendance/devices', { method: 'POST', body: { name: 'ZKT Test Main', host: '10.0.0.9', port: 4370, timeZone: KHI } })).status);

  section('25. AUTHORIZATION');
  check('employee cannot list devices', 403, (await employee('/attendance/devices')).status);
  check('manager cannot list devices', 403, (await manager('/attendance/devices')).status);
  check('employee cannot create a device', 403,
    (await employee('/attendance/devices', { method: 'POST', body: { name: 'X', host: '1.2.3.4', port: 4370, timeZone: 'UTC' } })).status);
  check('employee cannot change a device IP', 403,
    (await employee(`/attendance/devices/${deviceId}`, { method: 'PATCH', body: { name: 'ZKT Test Main', host: '6.6.6.6', port: 4370, timeZone: KHI } })).status);
  check('employee cannot trigger a sync', 403,
    (await employee(`/attendance/devices/${deviceId}/sync`, { method: 'POST' })).status);
  check('employee cannot read raw punches', 403, (await employee('/attendance/punches')).status);
  check('manager cannot read raw punches', 403, (await manager('/attendance/punches')).status);
  check('unauthenticated cannot list devices', 401, (await makeClient()('/attendance/devices')).status);

  // ------------------------------------------------------------------------
  section('1-2. CONNECTION TEST (real socket)');
  const test = await admin(`/attendance/devices/${deviceId}/test`, { method: 'POST' });
  check('test connection succeeds', 200, test.status);
  check('the device is reachable', true, test.data.reachable);
  check('it reports its serial number', 'SIM0123456789', test.data.serialNumber);
  check('and its model name', 'ZKTeco Simulator', test.data.deviceName);
  check('latency is measured, not assumed', true, typeof test.data.latencyMs === 'number');
  check('device status is now ONLINE', 'ONLINE',
    (await admin(`/attendance/devices?limit=50`)).data.find((d) => d.id === deviceId).status);

  const dead = await admin('/attendance/devices', {
    method: 'POST',
    body: { name: 'ZKT Test Offline', host: '127.0.0.1', port: 14399, timeZone: KHI, isEnabled: true },
  });
  const deadId = dead.data.id;
  const deadTest = await admin(`/attendance/devices/${deadId}/test`, { method: 'POST' });
  check('an unreachable device reports unreachable', false, deadTest.data.reachable);
  check('and explains why', true, /refused|reach|answer/i.test(deadTest.data.error ?? ''));
  check('its status is OFFLINE, not Connected', 'OFFLINE',
    (await admin('/attendance/devices?limit=50')).data.find((d) => d.id === deadId).status);

  // ------------------------------------------------------------------------
  section('3. FIRST SYNCHRONISATION');
  const first = await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  check('sync succeeds', 200, first.status);
  info(`first sync: ${JSON.stringify(first.data)}`);
  check('three transactions fetched', 3, first.data.recordsFetched);
  check('three punches inserted', 3, first.data.recordsImported);
  check('no duplicates on a first run', 0, first.data.duplicatesIgnored);
  check('with no mappings yet, all three are unmapped', 3, first.data.unmappedRecords);
  check('nothing was rejected', 0, first.data.errors);

  section('8. UNMAPPED PUNCHES ARE KEPT, NOT DROPPED');
  const unmapped = await admin('/attendance/punches?unmappedOnly=true&limit=50');
  check('the unmapped punch is retrievable', true, unmapped.data.some((p) => p.deviceUserId === '9999'));
  check('it has no employee attached', null, unmapped.data.find((p) => p.deviceUserId === '9999').employeeId);

  // ------------------------------------------------------------------------
  section('12-13. TIMEZONE NORMALISATION (Asia/Karachi)');
  const punches = (await admin(`/attendance/punches?deviceId=${deviceId}&limit=50`)).data;
  const morning = punches.find((p) => p.rawTimestamp.includes('08:56:12'));
  check('the raw device reading is preserved verbatim', `${D} 08:56:12`, morning.rawTimestamp);
  check('08:56 Karachi normalises to 03:56 UTC', `${D}T03:56:12.000Z`, morning.punchedAt);
  check('the device zone is recorded with the punch', KHI, morning.deviceTimeZone);
  check('and it belongs to the local day, not the UTC one', D, morning.localDayKey);

  section('14. MIDNIGHT AND THE UTC DAY BOUNDARY');
  // 02:00 Karachi on the 11th is 21:00 UTC on the 10th. The naive UTC reading
  // would file this under the wrong day.
  sim.addPunches([punch('1007', '2026-08-11 02:00:00', 0)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const nightPunch = (await admin(`/attendance/punches?deviceId=${deviceId}&limit=50`)).data
    .find((p) => p.rawTimestamp.includes('02:00:00'));
  check('a 02:00 local punch is stored as 21:00 UTC the day before', '2026-08-10T21:00:00.000Z', nightPunch.punchedAt);
  check('but is filed under the local day it happened on', '2026-08-11', nightPunch.localDayKey);

  // ------------------------------------------------------------------------
  section('5-17. DUPLICATE HANDLING');
  const second = await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  info(`re-sync: ${JSON.stringify(second.data)}`);
  check('nothing new is inserted', 0, second.data.recordsImported);
  check('everything re-read is a duplicate', true, second.data.duplicatesIgnored > 0);
  const punchCount = await prisma.attendanceRawPunch.count({ where: { deviceId } });
  check('the punch count did not grow', 4, punchCount);

  // Exactly the same transaction, offered again.
  sim.addPunches([punch('1007', `${D} 08:56:12`, 0)]);
  const third = await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  check('an identical transaction is not imported twice', 0, third.data.recordsImported);
  check('still four punches', 4, await prisma.attendanceRawPunch.count({ where: { deviceId } }));

  // ------------------------------------------------------------------------
  section('9. EMPLOYEE MAPPING');
  const mapped = await admin(`/attendance/devices/${deviceId}/mappings`, {
    method: 'POST',
    body: { deviceUserId: '1007', employeeId: kwame.id, deviceUserName: 'Kwame Mensah' },
  });
  check('mapping is created', 201, mapped.status);
  check('and existing punches are attributed to the employee', true, mapped.data.attributedPunches >= 3);
  check('employee cannot create a mapping', 403,
    (await employee(`/attendance/devices/${deviceId}/mappings`, { method: 'POST', body: { deviceUserId: '1', employeeId: kwame.id } })).status);

  check('the unknown user stays unmapped', true,
    (await admin('/attendance/punches?unmappedOnly=true&limit=100')).data.every((p) => p.deviceUserId === '9999'));
  check('and the mapped user no longer is', false,
    (await admin('/attendance/punches?unmappedOnly=true&limit=100')).data.some((p) => p.deviceUserId === '1007'));

  const reprocessed = await admin('/attendance/punches/reprocess', { method: 'POST', body: { deviceId } });
  info(`reprocess: ${JSON.stringify(reprocessed.data)}`);
  check('mapped punches are reprocessed into attendance', true, reprocessed.data.daysRecalculated >= 1);

  // ------------------------------------------------------------------------
  section('8-22-23-24. THE ATTENDANCE ENGINE SCORES THE DAY');
  const day = (await admin(`/attendance?employeeId=${kwame.id}&from=${D}&to=${D}&limit=1`)).data[0];
  info(`scored day: ${JSON.stringify({ status: day.status, worked: day.workedMinutes, late: day.lateMinutes, early: day.earlyLeaveMinutes, ot: day.overtimeMinutes, source: day.source })}`);
  check('the day exists', true, Boolean(day));
  check('its source is the device', 'DEVICE', day.source);
  check('first punch became the check-in', `${D}T03:56:12.000Z`, day.checkInAt);
  check('last punch became the check-out', `${D}T13:14:03.000Z`, day.checkOutAt);
  check('worked minutes are 08:56 to 18:14 local', 558, day.workedMinutes);
  check('arriving at 08:56 for an 09:00 shift is not late', 0, day.lateMinutes);
  check('leaving at 18:14 after an 18:00 shift is not early', 0, day.earlyLeaveMinutes);
  check('overtime is the part past the threshold', 78, day.overtimeMinutes);
  check('and the policy called it present', 'PRESENT', day.status);

  section('22-23. LATE AND EARLY LEAVE COME FROM THE ENGINE');
  const L = '2026-08-12';
  sim.addPunches([punch('1007', `${L} 09:41:00`, 0), punch('1007', `${L} 16:30:00`, 1)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const lateDay = (await admin(`/attendance?employeeId=${kwame.id}&from=${L}&to=${L}&limit=1`)).data[0];
  info(`late day: ${JSON.stringify({ late: lateDay.lateMinutes, early: lateDay.earlyLeaveMinutes, status: lateDay.status })}`);
  check('41 minutes after a 09:00 shift start is 41 late', 41, lateDay.lateMinutes);
  check('leaving 90 minutes before an 18:00 end is 90 early', 90, lateDay.earlyLeaveMinutes);

  section('16. A MISSING OUT PUNCH IS NEVER INVENTED');
  const M = '2026-08-13';
  sim.addPunches([punch('1007', `${M} 09:00:00`, 0)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const openDay = (await admin(`/attendance?employeeId=${kwame.id}&from=${M}&to=${M}&limit=1`)).data[0];
  check('the check-in is recorded', `${M}T04:00:00.000Z`, openDay.checkInAt);
  check('no check-out is manufactured', null, openDay.checkOutAt);
  check('and no worked minutes are claimed', null, openDay.workedMinutes);

  section('20. WEEKEND');
  const W = '2026-08-15'; // Saturday
  sim.addPunches([punch('1007', `${W} 10:00:00`, 0), punch('1007', `${W} 14:00:00`, 1)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const weekend = (await admin(`/attendance/summary?employeeId=${kwame.id}&from=${W}&to=${W}`)).data.days[0];
  check('a Saturday still derives as WEEKEND', 'WEEKEND', weekend.status);
  check('though the punch is kept underneath', true,
    (await admin(`/attendance/punches?employeeId=${kwame.id}&limit=100`)).data.some((p) => p.localDayKey === W));

  section('19-21. HOLIDAY AND APPROVED LEAVE OUTRANK A PUNCH');
  const H = '2026-08-17';
  await admin('/holidays', { method: 'POST', body: { name: 'ZKT Test Holiday', date: H, isActive: true } });
  sim.addPunches([punch('1007', `${H} 09:00:00`, 0), punch('1007', `${H} 18:00:00`, 1)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const holiday = (await admin(`/attendance/summary?employeeId=${kwame.id}&from=${H}&to=${H}`)).data.days[0];
  check('a holiday still derives as HOLIDAY', 'HOLIDAY', holiday.status);
  check('and names the holiday', 'ZKT Test Holiday', holiday.holidayName);

  const leaveDay = (await admin(`/attendance/summary?employeeId=${tomas.id}&from=2026-09-21&to=2026-09-21`)).data.days[0];
  check('approved leave still derives as ON_LEAVE', 'ON_LEAVE', leaveDay.status);

  section('18. A MANUAL CORRECTION IS NEVER OVERWRITTEN BY A SYNC');
  const C = '2026-08-18';
  sim.addPunches([punch('1007', `${C} 09:30:00`, 0), punch('1007', `${C} 17:00:00`, 1)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  await admin('/attendance', {
    method: 'POST',
    body: { employeeId: kwame.id, date: C, status: 'PRESENT', checkInAt: `${C}T04:00:00Z`, checkOutAt: `${C}T13:00:00Z`, notes: 'Corrected by HR.' },
  });
  const beforeResync = (await admin(`/attendance?employeeId=${kwame.id}&from=${C}&to=${C}&limit=1`)).data[0];
  check('the correction is stored as ADMIN', 'ADMIN', beforeResync.source);
  sim.addPunches([punch('1007', `${C} 19:45:00`, 1)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  await admin('/attendance/punches/reprocess', { method: 'POST', body: { deviceId } });
  const afterResync = (await admin(`/attendance?employeeId=${kwame.id}&from=${C}&to=${C}&limit=1`)).data[0];
  check('a later sync does not overwrite it', 'ADMIN', afterResync.source);
  check('the corrected check-out survives', beforeResync.checkOutAt, afterResync.checkOutAt);
  check('but the new raw punch is still kept as evidence', true,
    (await admin(`/attendance/punches?employeeId=${kwame.id}&limit=100`)).data.some((p) => p.rawTimestamp.includes('19:45:00')));

  // ------------------------------------------------------------------------
  section('4-27. INCREMENTAL SYNC AND HISTORICAL CATCH-UP');
  const deviceBefore = (await admin('/attendance/devices?limit=50')).data.find((d) => d.id === deviceId);
  check('a sync cursor is recorded', true, deviceBefore.syncCursorAt !== null);

  // Pretend the HRMS was down for days while the terminal kept recording.
  await prisma.attendanceDevice.update({ where: { id: deviceId }, data: { syncCursorAt: new Date('2026-08-19T00:00:00Z') } });
  sim.addPunches([
    punch('1007', '2026-08-20 09:00:00', 0),
    punch('1007', '2026-08-20 18:00:00', 1),
    punch('1007', '2026-08-21 09:00:00', 0),
    punch('1007', '2026-08-21 18:00:00', 1),
  ]);
  const catchUp = await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  info(`catch-up: ${JSON.stringify(catchUp.data)}`);
  check('an outage is caught up from the cursor, not just today', 4, catchUp.data.recordsImported);
  check('both missed days were scored', true,
    (await admin(`/attendance?employeeId=${kwame.id}&from=2026-08-20&to=2026-08-21&limit=10`)).data.length === 2);

  section('6. A CRASHED SYNC DOES NOT LOCK THE DEVICE FOREVER');
  await prisma.attendanceDevice.update({
    where: { id: deviceId },
    data: { syncLockedAt: new Date(Date.now() - 60 * 60 * 1000), syncLockToken: 'orphaned' },
  });
  const afterCrash = await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  check('a stale lock is reclaimed', 200, afterCrash.status);

  section('26. CONCURRENT SYNC REQUESTS');
  await prisma.attendanceDevice.update({ where: { id: deviceId }, data: { syncLockedAt: null, syncLockToken: null } });
  const [a, b] = await Promise.all([
    admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' }),
    admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' }),
  ]);
  const codes = [a.status, b.status].sort().join(',');
  check('exactly one wins and the other is told so', '200,409', codes);

  section('7. DEVICE OFFLINE');
  const offlineSync = await admin(`/attendance/devices/${deadId}/sync`, { method: 'POST' });
  check('a sync against a dead device returns cleanly', 200, offlineSync.status);
  check('and is recorded as FAILED rather than crashing', 'FAILED', offlineSync.data.status);
  check('with a diagnosable reason', true, /refused|reach|answer/i.test(offlineSync.data.error ?? ''));
  check('the HRMS is still healthy', 200, (await admin('/company')).status);

  // ------------------------------------------------------------------------
  section('10-11. MULTIPLE DEVICES, ONE EMPLOYEE');
  const sim2 = await startSimulator({
    port: 14371,
    punches: [punch('7', '2026-08-24 08:58:00', 0), punch('7', '2026-08-24 18:20:00', 1)],
  });
  const back = await admin('/attendance/devices', {
    method: 'POST',
    body: { name: 'ZKT Test Back Door', protocol: 'ZKTECO_TCP', host: '127.0.0.1', port: sim2.port, timeZone: KHI, isEnabled: true, punchPairing: 'FIRST_IN_LAST_OUT' },
  });
  const backId = back.data.id;
  // The same person is enrolled under a different number on the other terminal.
  await admin(`/attendance/devices/${backId}/mappings`, {
    method: 'POST',
    body: { deviceUserId: '7', employeeId: kwame.id, deviceUserName: 'Kwame Mensah' },
  });
  const backSync = await admin(`/attendance/devices/${backId}/sync`, { method: 'POST' });
  check('the second device syncs independently', 2, backSync.data.recordsImported);
  const crossDay = (await admin(`/attendance?employeeId=${kwame.id}&from=2026-08-24&to=2026-08-24&limit=1`)).data[0];
  check('a punch on another terminal still scores the day', 'PRESENT', crossDay.status);
  const bothDevices = (await admin(`/attendance/punches?employeeId=${kwame.id}&limit=100`)).data;
  check('punches record which terminal produced them', true,
    new Set(bothDevices.map((p) => p.deviceName)).size === 2);

  // Same employee, same instant, two terminals: two distinct events. The
  // instant is one the main device also reported, so this proves the
  // fingerprint includes the device rather than only the person and the time.
  sim.addPunches([punch('1007', '2026-08-25 09:00:00', 0)]);
  sim2.addPunches([punch('7', '2026-08-25 09:00:00', 0)]);
  await admin(`/attendance/devices/${deviceId}/sync`, { method: 'POST' });
  const overlap = await admin(`/attendance/devices/${backId}/sync`, { method: 'POST' });
  check('the same instant on a different device is a separate punch', 1, overlap.data.recordsImported);
  check('and both are stored', 2,
    (await admin('/attendance/punches?limit=100')).data.filter((x) => x.rawTimestamp === '2026-08-25 09:00:00').length);

  section('4b. A BACK-DATED TRANSACTION INSIDE THE OVERLAP IS STILL CAUGHT');
  // A record whose reading is earlier than the cursor, but within the window
  // each sync re-examines.
  const cursorNow = (await admin('/attendance/devices?limit=50')).data.find((d) => d.id === backId).syncCursorAt;
  sim2.addPunches([punch('7', '2026-08-25 08:30:00', 0)]);
  const lateArrival = await admin(`/attendance/devices/${backId}/sync`, { method: 'POST' });
  check('a punch back-dated behind the cursor is still imported', 1, lateArrival.data.recordsImported);
  info(`cursor was ${cursorNow}; the sync re-read the preceding day`);

  // ------------------------------------------------------------------------
  section('15. OVERNIGHT SHIFT');
  const night = await admin('/shifts', {
    method: 'POST',
    body: { name: 'ZKT Night', startTime: '22:00', endTime: '06:00', breakMinutes: 0, isActive: true },
  });
  check('an overnight shift can be defined', 201, night.status);
  info('early-leave is deliberately not scored for overnight shifts; see the report');

  // ------------------------------------------------------------------------
  section('13. SYNC HISTORY');
  const history = await admin(`/attendance/devices/${deviceId}/sync-history?limit=50`);
  check('history is recorded', true, history.data.length > 5);
  const successful = history.data.find((h) => h.status === 'SUCCESS');
  check('a run records what it fetched', true, typeof successful.recordsFetched === 'number');
  check('and its cursor window', true, successful.cursorBefore !== null);
  const failedRun = (await admin(`/attendance/devices/${deadId}/sync-history?limit=10`)).data[0];
  check('a failed run is kept too', 'FAILED', failedRun.status);

  section('16. DEVICE USERS');
  const users = await admin(`/attendance/devices/${deviceId}/users`);
  check('device users can be listed', 200, users.status);
  check('the enrolled users are read from the device', true, users.data.length >= 2);
  const mappedUser = users.data.find((u) => u.deviceUserId === '1007');
  check('a mapped user shows its employee', 'Kwame Mensah', mappedUser.employeeName);
  const unmappedUser = users.data.find((u) => u.deviceUserId === '1008');
  check('an unmapped user is shown as unmapped', null, unmappedUser?.employeeId ?? null);
  check('no employee was auto-created for the unknown user', 12,
    (await admin('/employees?limit=100')).data.length);

  section('22. DELETION PROTECTS EVIDENCE');
  check('a device with punches cannot be deleted', 409,
    (await admin(`/attendance/devices/${deviceId}`, { method: 'DELETE' })).status);
  check('one with no punches can be', 200,
    (await admin(`/attendance/devices/${deadId}`, { method: 'DELETE' })).status);

  // ------------------------------------------------------------------------
  section('RESTORE');
  await sim.close();
  await sim2.close();
  await prisma.attendanceRawPunch.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDeviceSync.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDeviceUserMapping.deleteMany({ where: { device: { name: { startsWith: 'ZKT Test' } } } });
  await prisma.attendanceDevice.deleteMany({ where: { name: { startsWith: 'ZKT Test' } } });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: kwame.id, source: 'DEVICE' } });
  await prisma.holiday.deleteMany({ where: { name: 'ZKT Test Holiday' } });
  await prisma.shift.deleteMany({ where: { name: 'ZKT Night' } });

  const restore = await admin('/company', {
    method: 'PATCH',
    body: {
      name: company.name, legalName: company.legalName, email: company.email, phone: company.phone,
      website: company.website, addressLine1: company.addressLine1, addressLine2: company.addressLine2,
      city: company.city, state: company.state, postalCode: company.postalCode, country: company.country,
      timezone: originalTimeZone, currency: company.currency, dateFormat: company.dateFormat,
      weekStartsOn: company.weekStartsOn,
    },
  });
  check('company timezone restored', originalTimeZone, restore.data.timezone);
  check('test devices removed', 0, await prisma.attendanceDevice.count({ where: { name: { startsWith: 'ZKT Test' } } }));

  console.log(`\n################ SUMMARY ################`);
  console.log(`PASS=${pass}  FAIL=${fail}`);
}

main()
  .catch((error) => {
    console.error('\nSUITE ERROR:', error);
    fail += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = fail === 0 ? 0 : 1;
  });
