import { createHash, randomUUID } from 'node:crypto';
import type { AttendanceDevice, AttendanceSyncTrigger } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { decryptSecret } from '../../core/secrets.js';
import { dayKeyInZone } from '../../core/zoned-time.js';
import { resolveAttendancePolicy } from '../time/attendance-policy.js';
import { adapterFor } from './registry.js';
import { recalculateDays } from './attendance-import.service.js';
import type { DeviceConnection, DevicePunch } from './adapter.js';

/**
 * Pulling transactions off a terminal and turning them into punches.
 *
 * Three things this has to survive, because all three happen in practice:
 *
 *   - the same sync running twice, from a schedule and a button at once;
 *   - the HRMS being down for days while the terminal keeps recording;
 *   - one malformed transaction in an otherwise good batch.
 *
 * The first is handled by a per-device lock, the second by a cursor rather than
 * a "today" window, and the third by importing punch by punch and counting the
 * failures instead of abandoning the batch.
 */

/** A lock older than this is assumed to belong to a crashed process. */
const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * How far back a first sync reaches.
 *
 * Only used when a device has never synced. After that the cursor decides, so
 * an outage of any length is caught up from where it left off.
 */
const FIRST_SYNC_LOOKBACK_DAYS = 30;

/**
 * How far back before the cursor each sync also re-examines.
 *
 * The cursor is a timestamp watermark, so a transaction that arrives late with
 * an older reading - a terminal whose clock was corrected backwards, or a
 * record written out of order - would otherwise fall behind it and never be
 * seen. Re-reading the last day costs nothing but a few deduplicated inserts,
 * because the protocol returns the whole log either way.
 *
 * Anything back-dated further than this needs a deliberate full resync, which
 * is a real limit rather than something this window quietly hides.
 */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface SyncOutcome {
  syncId: string;
  deviceId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  fetched: number;
  inserted: number;
  duplicates: number;
  unmapped: number;
  rejected: number;
  recalculatedDays: number;
  error: string | null;
}

/** Raised when a sync is already running for the device. */
export class SyncInProgressError extends Error {
  constructor() {
    super('A synchronisation is already running for this device.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * The identity of a punch.
 *
 * Built from the device, the person, the exact instant and whatever the device
 * calls the transaction. A timestamp alone would collapse two people punching
 * in the same second; including the device means the same person on two
 * terminals is two events, which is what actually happened.
 *
 * Two punches identical in all of these are indistinguishable even in
 * principle - the terminal read the same finger twice in one second - and
 * collapsing them is the desired behaviour rather than a limitation.
 */
export function punchFingerprint(input: {
  deviceUserId: string;
  punchedAt: Date;
  punchState: string | null;
  deviceTransactionId: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.deviceUserId,
        input.punchedAt.toISOString(),
        input.punchState ?? '',
        input.deviceTransactionId ?? '',
      ].join('|'),
    )
    .digest('hex');
}

export function connectionFor(device: AttendanceDevice): DeviceConnection {
  return {
    host: device.host,
    port: device.port,
    timeZone: device.timeZone,
    commKey: decryptSecret(device.commKeyCipher),
    timeoutMs: 10_000,
  };
}

/**
 * Takes the device lock.
 *
 * The conditional update is the whole mechanism: two callers race on one row
 * and the database decides, so a scheduled run and a button press cannot both
 * proceed even across processes.
 */
async function acquireLock(deviceId: string): Promise<string | null> {
  const token = randomUUID();
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);

  const claimed = await prisma.attendanceDevice.updateMany({
    where: {
      id: deviceId,
      OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: staleBefore } }],
    },
    data: { syncLockedAt: new Date(), syncLockToken: token },
  });

  return claimed.count === 1 ? token : null;
}

async function releaseLock(deviceId: string, token: string): Promise<void> {
  await prisma.attendanceDevice.updateMany({
    where: { id: deviceId, syncLockToken: token },
    data: { syncLockedAt: null, syncLockToken: null },
  });
}

/** Synchronises one device. Safe to call concurrently; the loser is told so. */
export async function syncDevice(
  deviceId: string,
  trigger: AttendanceSyncTrigger = 'SCHEDULED',
): Promise<SyncOutcome> {
  const device = await prisma.attendanceDevice.findUniqueOrThrow({ where: { id: deviceId } });

  if (!device.isEnabled) {
    return {
      syncId: '',
      deviceId,
      status: 'SKIPPED',
      fetched: 0,
      inserted: 0,
      duplicates: 0,
      unmapped: 0,
      rejected: 0,
      recalculatedDays: 0,
      error: 'The device is disabled.',
    };
  }

  const token = await acquireLock(deviceId);
  if (!token) throw new SyncInProgressError();

  // The window: from the cursor, or a bounded look-back on a first run. This
  // is what makes an outage a normal catch-up rather than lost days.
  const since = device.syncCursorAt
    ? new Date(device.syncCursorAt.getTime() - CURSOR_OVERLAP_MS)
    : new Date(Date.now() - FIRST_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const sync = await prisma.attendanceDeviceSync.create({
    data: {
      companyId: device.companyId,
      deviceId,
      trigger,
      status: 'RUNNING',
      cursorFrom: since,
    },
  });

  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let unmapped = 0;
  let rejected = 0;
  let recalculatedDays = 0;
  let failure: string | null = null;
  let latestPunchAt: Date | null = null;

  try {
    const adapter = adapterFor(device.protocol);
    const punches = await adapter.getAttendance(connectionFor(device), { since });
    fetched = punches.length;

    const [mappings, policy] = await Promise.all([
      prisma.attendanceDeviceUserMapping.findMany({
        where: { deviceId, isActive: true },
        select: { deviceUserId: true, employeeId: true },
      }),
      resolveAttendancePolicy(device.companyId),
    ]);
    const employeeByDeviceUser = new Map(mappings.map((m) => [m.deviceUserId, m.employeeId]));

    const touched = new Map<string, { employeeId: string; dayKey: string }>();

    for (const punch of punches) {
      try {
        const outcome = await importPunch({
          device,
          syncId: sync.id,
          punch,
          companyTimeZone: policy.timeZone,
          employeeId: employeeByDeviceUser.get(punch.deviceUserId) ?? null,
        });

        if (outcome.duplicate) duplicates += 1;
        else inserted += 1;
        if (!outcome.employeeId) unmapped += 1;

        if (!latestPunchAt || punch.punchedAt > latestPunchAt) latestPunchAt = punch.punchedAt;

        if (outcome.employeeId && !outcome.duplicate) {
          touched.set(`${outcome.employeeId}:${outcome.dayKey}`, {
            employeeId: outcome.employeeId,
            dayKey: outcome.dayKey,
          });
        }
      } catch {
        // One unreadable transaction must not cost us the rest of the batch.
        rejected += 1;
      }
    }

    const recalc = await recalculateDays({
      companyId: device.companyId,
      pairing: device.punchPairing,
      days: [...touched.values()],
    });
    recalculatedDays = recalc.recalculated;
  } catch (error) {
    failure = error instanceof Error ? error.message : 'The synchronisation failed.';
  }

  const status = failure ? 'FAILED' : rejected > 0 ? 'PARTIAL' : 'SUCCESS';
  const finishedAt = new Date();

  await prisma.attendanceDeviceSync.update({
    where: { id: sync.id },
    data: {
      finishedAt,
      status,
      fetched,
      inserted,
      duplicates,
      unmapped,
      rejected,
      cursorTo: latestPunchAt,
      error: failure,
    },
  });

  await prisma.attendanceDevice.update({
    where: { id: deviceId },
    data: {
      status: failure ? 'ERROR' : 'ONLINE',
      lastError: failure,
      ...(failure
        ? {}
        : {
            lastSeenAt: finishedAt,
            lastSyncAt: finishedAt,
            // Advanced only on success, and only to the newest punch actually
            // seen. Moving it to "now" would skip anything the device had not
            // finished writing.
            ...(latestPunchAt
              ? { syncCursorAt: latestPunchAt, lastPunchAt: latestPunchAt }
              : {}),
          }),
    },
  });

  await releaseLock(deviceId, token);

  return {
    syncId: sync.id,
    deviceId,
    status,
    fetched,
    inserted,
    duplicates,
    unmapped,
    rejected,
    recalculatedDays,
    error: failure,
  };
}

/**
 * Stores one punch.
 *
 * Idempotency is the unique index on (device, fingerprint), not a prior read:
 * two workers importing the same transaction at the same moment both attempt
 * the insert and the database settles it.
 */
async function importPunch(input: {
  device: AttendanceDevice;
  syncId: string;
  punch: DevicePunch;
  companyTimeZone: string;
  employeeId: string | null;
}): Promise<{ duplicate: boolean; employeeId: string | null; dayKey: string }> {
  const { device, syncId, punch, companyTimeZone, employeeId } = input;

  // The day is the company's, not the device's: a terminal in another zone
  // still contributes to the working day the company is having.
  const dayKey = dayKeyInZone(punch.punchedAt, companyTimeZone);
  const fingerprint = punchFingerprint(punch);

  const created = await prisma.attendanceRawPunch.createMany({
    data: [
      {
        companyId: device.companyId,
        deviceId: device.id,
        syncId,
        deviceUserId: punch.deviceUserId,
        employeeId,
        deviceTransactionId: punch.deviceTransactionId,
        rawTimestamp: punch.rawTimestamp,
        deviceTimeZone: device.timeZone,
        punchedAt: punch.punchedAt,
        localDayKey: dayKey,
        punchState: punch.punchState,
        verifyMode: punch.verifyMode,
        fingerprint,
      },
    ],
    skipDuplicates: true,
  });

  return { duplicate: created.count === 0, employeeId, dayKey };
}

/** Every enabled device that is due, for the scheduler. */
export async function syncDueDevices(): Promise<SyncOutcome[]> {
  const devices = await prisma.attendanceDevice.findMany({
    where: { isEnabled: true },
    select: { id: true, lastSyncAt: true, syncIntervalMinutes: true },
  });

  const now = Date.now();
  const outcomes: SyncOutcome[] = [];

  for (const device of devices) {
    const dueAt = device.lastSyncAt
      ? device.lastSyncAt.getTime() + device.syncIntervalMinutes * 60_000
      : 0;
    if (dueAt > now) continue;

    try {
      outcomes.push(await syncDevice(device.id, 'SCHEDULED'));
    } catch {
      // Already running, or unreachable. Either way the next tick retries and
      // the scheduler must not stop because one terminal is down.
    }
  }

  return outcomes;
}
