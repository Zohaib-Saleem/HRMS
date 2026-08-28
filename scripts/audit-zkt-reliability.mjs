/**
 * Phase 7: production reliability of the attendance-terminal integration.
 *
 * Every failure mode is produced for real - a socket that refuses, one that
 * goes silent, one that resets mid-transfer, a terminal that answers with
 * unframeable bytes, a transfer that stops half way - and the assertions are
 * about what the HRMS does with its own data afterwards: what it stored, what
 * it counted, and above all where it left the cursor.
 *
 *   npx dotenv -e .env -- npx tsx scripts/audit-zkt-reliability.mjs
 */
import { PrismaClient } from '@prisma/client';
import { startSimulator, punch } from './zkt-simulator.mjs';
import { computeNextCursor } from '../apps/api/src/modules/attendance-device/sync.service.ts';

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
const info = (m) => console.log(`  INFO  ${m}`);
const section = (t) => console.log(`\n################ ${t} ################`);

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
    return { status: response.status, body, data: body?.data ?? null, raw: text };
  };
}

const login = async (email, password) => {
  const client = makeClient();
  const res = await client('/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status}`);
  return client;
};

const KHI = 'Asia/Karachi';
const PREFIX = 'P7 ';

const wipe = async () => {
  await prisma.attendanceRawPunch.deleteMany({ where: { device: { name: { startsWith: PREFIX } } } });
  await prisma.attendanceDeviceSync.deleteMany({ where: { device: { name: { startsWith: PREFIX } } } });
  await prisma.attendanceDeviceUserMapping.deleteMany({ where: { device: { name: { startsWith: PREFIX } } } });
  await prisma.attendanceDevice.deleteMany({ where: { name: { startsWith: PREFIX } } });
};

const cursorOf = async (id) =>
  (await prisma.attendanceDevice.findUnique({ where: { id }, select: { syncCursorAt: true } }))
    .syncCursorAt;

async function main() {
  const admin = await login('admin@hrms.local', 'Admin@12345');
  const employee = await login('employee@hrms.local', 'Employee@12345');

  const company = (await admin('/company')).data;
  info(`company timezone: ${company.timezone}`);

  const employees = (await admin('/employees?limit=100')).data;
  const worker = employees.find((e) => e.firstName === 'Sofia');
  // No shift is assigned: this suite is about reliability, not scoring, and a
  // shift would only add lateness noise to the assertions.

  await wipe();

  const addDevice = async (name, port, extra = {}) => {
    const res = await admin('/attendance/devices', {
      method: 'POST',
      body: {
        name: PREFIX + name,
        protocol: 'ZKTECO_TCP',
        host: '127.0.0.1',
        port,
        timeZone: KHI,
        isEnabled: true,
        syncIntervalMinutes: 15,
        punchPairing: 'FIRST_IN_LAST_OUT',
        ...extra,
      },
    });
    if (res.status !== 201) throw new Error(`Could not create device ${name}: ${res.raw}`);
    return res.data.id;
  };

  const D = '2026-08-16'; // a Monday well clear of other fixtures

  // ========================================================================
  section('1. DEVICE OFFLINE — NOTHING LISTENING');
  const offlineId = await addDevice('Offline', 14401);
  const offlineTest = await admin(`/attendance/devices/${offlineId}/test`, { method: 'POST' });
  check('test reports unreachable', false, offlineTest.data.reachable);
  check('with a diagnosable reason', true, /refused|reach|answer/i.test(offlineTest.data.error ?? ''));
  check('device status is OFFLINE', 'OFFLINE',
    (await admin('/attendance/devices?limit=50')).data.find((d) => d.id === offlineId).status);

  const offlineSync = await admin(`/attendance/devices/${offlineId}/sync`, { method: 'POST' });
  check('sync returns cleanly rather than throwing', 200, offlineSync.status);
  check('and is recorded FAILED', 'FAILED', offlineSync.data.status);
  check('nothing was imported', 0, offlineSync.data.recordsImported);
  check('no fake attendance was created', 0,
    await prisma.attendanceRawPunch.count({ where: { deviceId: offlineId } }));
  check('the cursor never moved', null, await cursorOf(offlineId));
  check('the last error is stored on the device', true,
    Boolean((await admin('/attendance/devices?limit=50')).data.find((d) => d.id === offlineId).lastError));
  check('the API is still healthy afterwards', 200, (await admin('/company')).status);

  section('14. BOUNDED RETRY');
  const attempts = offlineSync.data.attempts;
  info(`connection attempts on an unreachable device: ${attempts}`);
  check('it retried', true, attempts > 1);
  check('but did not retry indefinitely', true, attempts <= 3);
  check('the attempt count is recorded in history', attempts,
    (await admin(`/attendance/devices/${offlineId}/sync-history?limit=1`)).data[0].attempts);

  // ========================================================================
  section('2. SOCKET FAULTS ARE ISOLATED');
  const faults = [
    ['silent', 'device accepts then never answers'],
    ['garbage', 'device sends unframeable bytes'],
    ['reset', 'device resets the connection'],
    ['dropMidTransfer', 'device disappears mid-transfer'],
  ];

  for (const [fault, description] of faults) {
    const port = 14410 + faults.findIndex((f) => f[0] === fault);
    const sim = await startSimulator({
      port,
      fault,
      chunkSize: 40,
      punches: [punch('1007', `${D} 09:00:00`, 0), punch('1007', `${D} 18:00:00`, 1)],
    });
    const id = await addDevice(`Fault ${fault}`, port);
    const result = await admin(`/attendance/devices/${id}/sync`, { method: 'POST' });

    check(`${description}: sync completes without throwing`, 200, result.status);
    check(`${description}: recorded FAILED`, 'FAILED', result.data.status);
    check(`${description}: cursor untouched`, null, await cursorOf(id));
    check(`${description}: no punches stored`, 0,
      await prisma.attendanceRawPunch.count({ where: { deviceId: id } }));
    check(`${description}: API still healthy`, 200, (await admin('/company')).status);
    await sim.close();
  }

  // A device left disabled by a failed read would be a terminal nobody can
  // clock in on; the adapter re-enables it in a finally block.
  info('the adapter re-enables the terminal in a finally block after any failure');

  // ========================================================================
  section('3. PARTIAL DOWNLOAD PROTECTION');
  const partialPort = 14420;
  const manyPunches = [];
  for (let i = 0; i < 50; i += 1) {
    const hh = String(6 + Math.floor(i / 10)).padStart(2, '0');
    const mm = String((i % 10) * 6).padStart(2, '0');
    manyPunches.push(punch('1007', `2026-08-17 ${hh}:${mm}:00`, i % 2));
  }
  const partialSim = await startSimulator({
    port: partialPort,
    fault: 'truncate',
    chunkSize: 200,
    punches: manyPunches,
  });
  const partialId = await addDevice('Partial', partialPort);

  const truncated = await admin(`/attendance/devices/${partialId}/sync`, { method: 'POST' });
  info(`truncated transfer: ${JSON.stringify({ status: truncated.data.status, imported: truncated.data.recordsImported, error: truncated.data.error?.slice(0, 60) })}`);
  check('a half-sent log is an error, not a short success', 'FAILED', truncated.data.status);
  check('the error names it as incomplete', true, /incomplete|stopped|interrupt/i.test(truncated.data.error ?? ''));
  check('none of the 50 were marked synchronised', 0,
    await prisma.attendanceRawPunch.count({ where: { deviceId: partialId } }));
  check('the cursor did not advance', null, await cursorOf(partialId));
  await partialSim.close();

  // The same device, now healthy: nothing was lost by the failure.
  const healthySim = await startSimulator({ port: partialPort, chunkSize: 200, punches: manyPunches });
  const recovered = await admin(`/attendance/devices/${partialId}/sync`, { method: 'POST' });
  check('the next sync retrieves everything that was missed', 50, recovered.data.recordsImported);
  check('and the cursor now advances', true, (await cursorOf(partialId)) !== null);
  await healthySim.close();

  // ========================================================================
  section('15. CURSOR SAFETY RULE');
  /**
   * Tested directly rather than through a socket.
   *
   * The decision that matters most - how far the watermark may move - depends
   * on whether a record failed transiently or is permanently unreadable, and a
   * genuine transient storage failure cannot be provoked from outside: the
   * mapping table has its own foreign key, so a mapping pointing at a missing
   * employee cannot even be created. The rule is a pure function for exactly
   * this reason, and is exercised here on its own terms.
   */
  const t = (iso) => new Date(iso);

  check('a failed read never moves the cursor', null,
    computeNextCursor({ failed: true, cursorUnsafe: true, latestStoredAt: t('2026-08-18T09:00:00Z'), earliestUnstoredAt: null }));
  check('a failure that cannot be placed in time never moves it', null,
    computeNextCursor({ failed: false, cursorUnsafe: true, latestStoredAt: t('2026-08-18T09:00:00Z'), earliestUnstoredAt: null }));
  check('a clean run moves it to the newest stored record', '2026-08-18T18:00:00.000Z',
    computeNextCursor({ failed: false, cursorUnsafe: false, latestStoredAt: t('2026-08-18T18:00:00Z'), earliestUnstoredAt: null })?.toISOString());
  check('a run with nothing to store leaves it alone', null,
    computeNextCursor({ failed: false, cursorUnsafe: false, latestStoredAt: null, earliestUnstoredAt: null }));

  const held = computeNextCursor({
    failed: false,
    cursorUnsafe: false,
    latestStoredAt: t('2026-08-18T18:00:00Z'),
    earliestUnstoredAt: t('2026-08-18T10:00:00Z'),
  });
  check('a record awaiting retry holds the cursor behind itself', true,
    held !== null && held.getTime() < Date.parse('2026-08-18T10:00:00Z'));
  check('even though later records stored successfully', true,
    held !== null && held.getTime() < Date.parse('2026-08-18T18:00:00Z'));
  check('so those later records are simply re-read and deduplicated', '2026-08-18T09:59:59.000Z',
    held?.toISOString());

  const allFailed = computeNextCursor({
    failed: false,
    cursorUnsafe: false,
    latestStoredAt: null,
    earliestUnstoredAt: t('2026-08-18T10:00:00Z'),
  });
  check('with nothing stored it sits just before the first failure', '2026-08-18T09:59:59.000Z',
    allFailed?.toISOString());

  // ========================================================================
  section('8. MALFORMED RECORD ISOLATION');
  const badPort = 14440;
  const badSim = await startSimulator({
    port: badPort,
    punches: [
      punch('1007', '2026-08-19 09:00:00', 0),
      { uid: 3, deviceUserId: '', status: 1, punch: 0, clock: { year: 2026, month: 8, day: 19, hour: 10, minute: 0, second: 0 } },
      punch('1007', '2026-08-19 18:00:00', 1),
    ],
  });
  const badId = await addDevice('Malformed', badPort);
  await admin(`/attendance/devices/${badId}/mappings`, {
    method: 'POST',
    body: { deviceUserId: '1007', employeeId: worker.id },
  });

  const withBad = await admin(`/attendance/devices/${badId}/sync`, { method: 'POST' });
  info(`fetched ${withBad.data.recordsFetched}, imported ${withBad.data.recordsImported}, duplicates ${withBad.data.duplicatesIgnored}, unmapped ${withBad.data.unmappedRecords}, errors ${withBad.data.errors}`);
  check('the good records still import', 2, withBad.data.recordsImported);
  check('the bad one is counted, not fatal', 1, withBad.data.errors);
  check('the run is PARTIAL', 'PARTIAL', withBad.data.status);

  const badHistory = (await admin(`/attendance/devices/${badId}/sync-history?limit=1`)).data[0];
  check('the failure is described in history', 1, badHistory.errorDetails.length);
  check('and says what was wrong', true, /device user ID/i.test(badHistory.errorDetails[0]?.reason ?? ''));
  check('marked as permanent, so it is not retried forever', true, badHistory.errorDetails[0]?.permanent === true);
  check('a permanently bad record does not hold the cursor', true, (await cursorOf(badId)) !== null);
  await badSim.close();

  // ========================================================================
  section('4 & 10. REPEATED SYNC IS IDEMPOTENT');
  const dupPort = 14450;
  const dupSim = await startSimulator({
    port: dupPort,
    punches: [punch('1007', '2026-08-20 09:00:00', 0), punch('1007', '2026-08-20 18:00:00', 1)],
  });
  const dupId = await addDevice('Duplicate', dupPort);
  await admin(`/attendance/devices/${dupId}/mappings`, {
    method: 'POST',
    body: { deviceUserId: '1007', employeeId: worker.id },
  });

  const first = await admin(`/attendance/devices/${dupId}/sync`, { method: 'POST' });
  check('first sync imports both', 2, first.data.recordsImported);

  for (let i = 0; i < 3; i += 1) {
    const again = await admin(`/attendance/devices/${dupId}/sync`, { method: 'POST' });
    check(`repeat ${i + 1}: nothing new imported`, 0, again.data.recordsImported);
    check(`repeat ${i + 1}: counted as duplicatesIgnored`, 2, again.data.duplicatesIgnored);
    check(`repeat ${i + 1}: not treated as an error`, 0, again.data.errors);
    check(`repeat ${i + 1}: run still SUCCESS`, 'SUCCESS', again.data.status);
  }
  check('exactly two raw punches exist', 2,
    await prisma.attendanceRawPunch.count({ where: { deviceId: dupId } }));
  check('and exactly one attendance record', 1,
    await prisma.attendanceRecord.count({ where: { employeeId: worker.id, date: new Date('2026-08-20T00:00:00Z') } }));

  // ========================================================================
  section('5. CONCURRENT SYNC');
  await prisma.attendanceDevice.update({
    where: { id: dupId },
    data: { syncLockedAt: null, syncLockToken: null },
  });
  const before = await prisma.attendanceRawPunch.count({ where: { deviceId: dupId } });
  const [a, b, c] = await Promise.all([
    admin(`/attendance/devices/${dupId}/sync`, { method: 'POST' }),
    admin(`/attendance/devices/${dupId}/sync`, { method: 'POST' }),
    admin(`/attendance/devices/${dupId}/sync`, { method: 'POST' }),
  ]);
  const statuses = [a.status, b.status, c.status].sort();
  info(`three simultaneous Sync Now: ${statuses.join(', ')}`);
  check('exactly one proceeds', 1, statuses.filter((s) => s === 200).length);
  check('the others are refused cleanly', 2, statuses.filter((s) => s === 409).length);
  check('the refusal is a structured conflict, not a crash', 'CONFLICT',
    [a, b, c].find((r) => r.status === 409).body.error.code);
  check('no duplicate punches were created', before,
    await prisma.attendanceRawPunch.count({ where: { deviceId: dupId } }));
  check('the lock was released', null,
    (await prisma.attendanceDevice.findUnique({ where: { id: dupId }, select: { syncLockedAt: true } })).syncLockedAt);
  await dupSim.close();

  // ========================================================================
  section('6. MULTIPLE DEVICES ARE INDEPENDENT');
  const frontPort = 14460;
  const backPort = 14461;
  const frontSim = await startSimulator({
    port: frontPort,
    punches: [punch('1007', '2026-08-21 09:00:00', 0)],
  });
  const backSim = await startSimulator({
    port: backPort,
    punches: [punch('55', '2026-08-21 18:00:00', 1)],
  });
  const frontId = await addDevice('Front', frontPort, { commKey: '111111' });
  const backId = await addDevice('Back', backPort, { commKey: '222222' });
  await admin(`/attendance/devices/${frontId}/mappings`, {
    method: 'POST', body: { deviceUserId: '1007', employeeId: worker.id },
  });
  await admin(`/attendance/devices/${backId}/mappings`, {
    method: 'POST', body: { deviceUserId: '55', employeeId: worker.id },
  });

  await admin(`/attendance/devices/${frontId}/sync`, { method: 'POST' });
  await admin(`/attendance/devices/${backId}/sync`, { method: 'POST' });

  check('each device keeps its own punches', 1,
    await prisma.attendanceRawPunch.count({ where: { deviceId: frontId } }));
  check('and the other keeps its own', 1,
    await prisma.attendanceRawPunch.count({ where: { deviceId: backId } }));
  const frontCursor = await cursorOf(frontId);
  const backCursor = await cursorOf(backId);
  check('cursors are independent', true,
    frontCursor !== null && backCursor !== null && frontCursor.getTime() !== backCursor.getTime());
  check('sync history is per device', true,
    (await admin(`/attendance/devices/${frontId}/sync-history?limit=10`)).data.every((h) => h.deviceId === frontId));
  check('mappings are per device', 1,
    await prisma.attendanceDeviceUserMapping.count({ where: { deviceId: frontId } }));
  check('each stores its own comm key', true,
    (await prisma.attendanceDevice.findUnique({ where: { id: frontId } })).commKeyCipher !==
      (await prisma.attendanceDevice.findUnique({ where: { id: backId } })).commKeyCipher);

  // Taking one device down must not affect the other.
  await frontSim.close();
  const backStillWorks = await admin(`/attendance/devices/${backId}/sync`, { method: 'POST' });
  const frontNowFails = await admin(`/attendance/devices/${frontId}/sync`, { method: 'POST' });
  check('one device failing does not affect the other', 'SUCCESS', backStillWorks.data.status);
  check('the failed one is marked, in isolation', 'FAILED', frontNowFails.data.status);
  check('and its punches survive its own failure', 1,
    await prisma.attendanceRawPunch.count({ where: { deviceId: frontId } }));
  await backSim.close();

  // ========================================================================
  section('7. UNMAPPED USERS');
  const unmappedPort = 14470;
  const unmappedSim = await startSimulator({
    port: unmappedPort,
    punches: [
      punch('7777', '2026-08-22 09:02:00', 0),
      punch('7777', '2026-08-22 18:05:00', 1),
    ],
  });
  const unmappedId = await addDevice('Unmapped', unmappedPort);

  const unmappedSync = await admin(`/attendance/devices/${unmappedId}/sync`, { method: 'POST' });
  check('unmapped punches are still imported', 2, unmappedSync.data.recordsImported);
  check('and reported as unmapped', 2, unmappedSync.data.unmappedRecords);
  check('not as errors', 0, unmappedSync.data.errors);
  check('the raw data is preserved', 2,
    await prisma.attendanceRawPunch.count({ where: { deviceId: unmappedId } }));
  check('no attendance was invented for anyone', 0,
    await prisma.attendanceRecord.count({ where: { date: new Date('2026-08-22T00:00:00Z'), source: 'DEVICE' } }));
  check('they appear in the unmapped view', true,
    (await admin('/attendance/punches?unmappedOnly=true&limit=100')).data.some((p) => p.deviceUserId === '7777'));

  const mapping = await admin(`/attendance/devices/${unmappedId}/mappings`, {
    method: 'POST',
    body: { deviceUserId: '7777', employeeId: worker.id, deviceUserName: 'Late mapping' },
  });
  check('mapping attributes the punches already imported', 2, mapping.data.attributedPunches);
  const reprocessed = await admin('/attendance/punches/reprocess', {
    method: 'POST', body: { deviceId: unmappedId },
  });
  check('and reprocessing scores the day', true, reprocessed.data.daysRecalculated >= 1);
  const rescued = (await admin(`/attendance?employeeId=${worker.id}&from=2026-08-22&to=2026-08-22&limit=1`)).data[0];
  check('the day now exists', true, Boolean(rescued));
  check('sourced from the device', 'DEVICE', rescued?.source);
  check('the original raw timestamps are unchanged', '2026-08-22 09:02:00',
    (await prisma.attendanceRawPunch.findFirst({
      where: { deviceId: unmappedId }, orderBy: { punchedAt: 'asc' },
    })).rawTimestamp);
  await unmappedSim.close();

  // ========================================================================
  section('16 & 17. RAW DATA AND MANUAL CORRECTIONS');
  const rawBefore = await prisma.attendanceRawPunch.findFirst({
    where: { deviceId: unmappedId }, orderBy: { punchedAt: 'asc' },
  });
  await admin('/attendance', {
    method: 'POST',
    body: {
      employeeId: worker.id, date: '2026-08-22', status: 'PRESENT',
      checkInAt: '2026-08-22T04:00:00Z', checkOutAt: '2026-08-22T13:00:00Z',
      notes: 'Corrected by HR.',
    },
  });
  const corrected = (await admin(`/attendance?employeeId=${worker.id}&from=2026-08-22&to=2026-08-22&limit=1`)).data[0];
  check('the correction is stored as ADMIN', 'ADMIN', corrected.source);

  await prisma.attendanceRawPunch.updateMany({ where: { deviceId: unmappedId }, data: { processedAt: null } });
  await admin('/attendance/punches/reprocess', { method: 'POST', body: { deviceId: unmappedId } });
  const afterReprocess = (await admin(`/attendance?employeeId=${worker.id}&from=2026-08-22&to=2026-08-22&limit=1`)).data[0];
  check('a later reprocess does not overwrite it', 'ADMIN', afterReprocess.source);
  check('the corrected times survive', corrected.checkOutAt, afterReprocess.checkOutAt);

  const rawAfter = await prisma.attendanceRawPunch.findFirst({ where: { id: rawBefore.id } });
  check('the raw punch is untouched by any recalculation', rawBefore.rawTimestamp, rawAfter.rawTimestamp);
  check('its device user id is preserved', rawBefore.deviceUserId, rawAfter.deviceUserId);
  check('its device is preserved', rawBefore.deviceId, rawAfter.deviceId);
  check('its punch state is preserved', String(rawBefore.punchState), String(rawAfter.punchState));
  check('and the instant is unchanged', rawBefore.punchedAt.toISOString(), rawAfter.punchedAt.toISOString());

  // ========================================================================
  section('18. KARACHI TIMEZONE REGRESSION');
  const tzPort = 14480;
  const tzSim = await startSimulator({
    port: tzPort,
    punches: [
      punch('1007', '2026-08-23 08:56:12', 0), // ordinary morning
      punch('1007', '2026-08-23 23:58:00', 1), // just before local midnight
      punch('1007', '2026-08-24 00:03:00', 0), // just after local midnight
      punch('1007', '2026-08-24 02:00:00', 1), // previous UTC day, this local day
      punch('1007', '2026-08-23 08:56:12', 0), // exact duplicate
    ],
  });
  const tzId = await addDevice('Timezone', tzPort);
  await admin(`/attendance/devices/${tzId}/mappings`, {
    method: 'POST', body: { deviceUserId: '1007', employeeId: worker.id },
  });
  const tzSync = await admin(`/attendance/devices/${tzId}/sync`, { method: 'POST' });
  check('the duplicate is collapsed on import', 4, tzSync.data.recordsImported);
  check('and counted as ignored', 1, tzSync.data.duplicatesIgnored);

  const tzPunches = await prisma.attendanceRawPunch.findMany({
    where: { deviceId: tzId }, orderBy: { punchedAt: 'asc' },
  });
  const byRaw = (t) => tzPunches.find((p) => p.rawTimestamp.endsWith(t));
  check('08:56:12 Karachi stores as 03:56:12 UTC', '2026-08-23T03:56:12.000Z',
    byRaw('08:56:12').punchedAt.toISOString());
  check('and belongs to the local day', '2026-08-23', byRaw('08:56:12').localDayKey);
  check('23:58 local stores as 18:58 UTC', '2026-08-23T18:58:00.000Z',
    byRaw('23:58:00').punchedAt.toISOString());
  check('still on the local day it happened', '2026-08-23', byRaw('23:58:00').localDayKey);
  check('00:03 local is 19:03 UTC on the previous UTC day', '2026-08-23T19:03:00.000Z',
    byRaw('00:03:00').punchedAt.toISOString());
  check('but belongs to the new local day', '2026-08-24', byRaw('00:03:00').localDayKey);
  check('02:00 local is 21:00 UTC the day before', '2026-08-23T21:00:00.000Z',
    byRaw('02:00:00').punchedAt.toISOString());
  check('and is filed under the local day', '2026-08-24', byRaw('02:00:00').localDayKey);
  check('the device zone is recorded with every punch', true,
    tzPunches.every((p) => p.deviceTimeZone === KHI));
  await tzSim.close();

  // ========================================================================
  section('11. SYNC HISTORY DIAGNOSTICS');
  const history = (await admin(`/attendance/devices/${tzId}/sync-history?limit=5`)).data[0];
  for (const field of [
    'deviceId', 'startedAt', 'completedAt', 'status', 'recordsFetched', 'recordsImported',
    'duplicatesIgnored', 'unmappedRecords', 'errors', 'attempts', 'cursorBefore', 'cursorAfter',
  ]) {
    check(`history carries ${field}`, true, field in history);
  }
  check('a completed run has a completion time', true, history.completedAt !== null);
  const historyText = JSON.stringify(await admin(`/attendance/devices/${tzId}/sync-history?limit=50`));
  check('history never carries a comm key', false, /commKey|commKeyCipher/i.test(historyText));
  const deviceText = JSON.stringify(await admin('/attendance/devices?limit=50'));
  check('the device list never carries a comm key', false, /"commKey"|commKeyCipher/i.test(deviceText));
  check('only whether one is set', true, /hasCommKey/.test(deviceText));

  // ========================================================================
  section('12. API ERROR RESPONSES');
  const notFound = await admin('/attendance/devices/does-not-exist/sync', { method: 'POST' });
  check('an unknown device is 404', 404, notFound.status);
  check('with a structured code', 'NOT_FOUND', notFound.body.error.code);
  check('and no stack trace', false, 'stack' in notFound.body.error);

  const badBody = await admin('/attendance/devices', {
    method: 'POST', body: { name: 'x', host: '', port: 99999, timeZone: 'Nowhere/Nothing' },
  });
  check('invalid input is 422', 422, badBody.status);
  check('with field-level detail', true, Object.keys(badBody.body.error.details ?? {}).length > 0);
  check('and no internal error text', false, /prisma|postgres|sql/i.test(JSON.stringify(badBody.body)));

  check('an employee is refused', 403, (await employee('/attendance/devices')).status);
  check('with a clean code', 'FORBIDDEN', (await employee('/attendance/devices')).body.error.code);
  check('and no leaked device addresses', false, /127\.0\.0\.1|commKey/.test(
    JSON.stringify((await employee('/attendance/devices')).body)));
  check('unauthenticated is 401', 401, (await makeClient()('/attendance/devices')).status);

  // ========================================================================
  section('9. RECOVERY AFTER INTERRUPTION');
  const recoverPort = 14490;
  // Two packets in - the session handshake and the quiesce - the terminal dies,
  // so the log request itself is never answered. Resetting any later would only
  // interrupt the cleanup, which is a different case and is covered below.
  const interrupted = await startSimulator({
    port: recoverPort,
    resetAfterPackets: 2,
    punches: [punch('1007', '2026-08-25 09:00:00', 0), punch('1007', '2026-08-25 18:00:00', 1)],
  });
  const recoverId = await addDevice('Recovery', recoverPort);
  await admin(`/attendance/devices/${recoverId}/mappings`, {
    method: 'POST', body: { deviceUserId: '1007', employeeId: worker.id },
  });

  const broke = await admin(`/attendance/devices/${recoverId}/sync`, { method: 'POST' });
  check('an interrupted exchange fails cleanly', 'FAILED', broke.data.status);
  check('the cursor stays where it was', null, await cursorOf(recoverId));
  check('the lock is released even after failure', null,
    (await prisma.attendanceDevice.findUnique({ where: { id: recoverId }, select: { syncLockedAt: true } })).syncLockedAt);
  await interrupted.close();

  const rebooted = await startSimulator({
    port: recoverPort,
    punches: [punch('1007', '2026-08-25 09:00:00', 0), punch('1007', '2026-08-25 18:00:00', 1)],
  });
  const afterReboot = await admin(`/attendance/devices/${recoverId}/sync`, { method: 'POST' });
  check('the next sync recovers everything', 2, afterReboot.data.recordsImported);
  check('and the cursor now advances', true, (await cursorOf(recoverId)) !== null);
  await rebooted.close();

  // A terminal that drops after handing over its log has still handed it over.
  const lateResetPort = 14491;
  const lateReset = await startSimulator({
    port: lateResetPort,
    resetAfterPackets: 3, // survives the log request, dies during cleanup
    punches: [punch('1007', '2026-08-26 09:00:00', 0), punch('1007', '2026-08-26 18:00:00', 1)],
  });
  const lateId = await addDevice('LateReset', lateResetPort);
  await admin(`/attendance/devices/${lateId}/mappings`, {
    method: 'POST', body: { deviceUserId: '1007', employeeId: worker.id },
  });
  const lateOutcome = await admin(`/attendance/devices/${lateId}/sync`, { method: 'POST' });
  check('a reset during cleanup does not discard the data already read', 'SUCCESS', lateOutcome.data.status);
  check('the punches are stored', 2, lateOutcome.data.recordsImported);
  await lateReset.close();
  check('and the day is scored', 'PRESENT',
    (await admin(`/attendance?employeeId=${worker.id}&from=2026-08-25&to=2026-08-25&limit=1`)).data[0]?.status);

  // ========================================================================
  section('RESTORE');
  await prisma.attendanceRecord.deleteMany({
    where: { employeeId: worker.id, date: { gte: new Date('2026-08-16T00:00:00Z'), lte: new Date('2026-08-26T00:00:00Z') } },
  });
  await wipe();
  check('test devices removed', 0,
    await prisma.attendanceDevice.count({ where: { name: { startsWith: PREFIX } } }));
  check('test punches removed', 0,
    await prisma.attendanceRawPunch.count({ where: { device: { name: { startsWith: PREFIX } } } }));

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
