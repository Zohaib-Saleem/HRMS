import { createHash, randomUUID } from 'node:crypto';
import type { AttendanceDevice, AttendanceSyncTrigger, Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { decryptSecret } from '../../core/secrets.js';
import { dayKeyInZone } from '../../core/zoned-time.js';
import { resolveAttendancePolicy } from '../time/attendance-policy.js';
import { adapterFor } from './registry.js';
import { recalculateDays } from './attendance-import.service.js';
import { DeviceAuthError, type DeviceConnection, type DevicePunch } from './adapter.js';

/**
 * Pulling transactions off a terminal and turning them into punches.
 *
 * Four things this has to survive, because all four happen in practice:
 *
 *   - the same sync running twice, from a schedule and a button at once;
 *   - the HRMS being down for days while the terminal keeps recording;
 *   - one malformed transaction in an otherwise good batch;
 *   - the terminal vanishing mid-conversation.
 *
 * The first is handled by a per-device lock, the second by a cursor rather than
 * a "today" window, the third by importing record by record, and the fourth by
 * never advancing the cursor past something that was not actually stored.
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
 * seen. Re-reading the last day costs only deduplicated inserts, because the
 * protocol returns the whole log either way.
 */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Connection attempts per sync, and how long to wait between them.
 *
 * Bounded on purpose. A terminal that is switched off should produce one tidy
 * failure and be retried on the next scheduled tick, not a process that keeps
 * dialling. Backoff is short because the scheduler is the real retry loop.
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 2000];

/** Errors kept per run. Enough to diagnose, not enough to fill the column. */
const MAX_ERROR_DETAILS = 20;

/** Carries how many attempts were made, so a failed run can still report it. */
export class DeviceReadError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DeviceReadError';
  }
}

/** A punch instant outside this range is a decode failure, not a real reading. */
const PLAUSIBLE_FROM = Date.UTC(2000, 0, 1);
const PLAUSIBLE_TO = Date.UTC(2100, 0, 1);

export interface SyncOutcome {
  syncId: string;
  deviceId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  recordsFetched: number;
  recordsImported: number;
  duplicatesIgnored: number;
  unmappedRecords: number;
  errors: number;
  recalculatedDays: number;
  attempts: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
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
 * A record this system will never be able to read.
 *
 * Kept apart from an ordinary failure because the two need opposite handling:
 * a storage failure should hold the cursor so the record is tried again, while
 * a record that is simply corrupt would then block the cursor forever.
 */
class MalformedPunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPunchError';
  }
}

/**
 * The identity of a punch.
 *
 * Built from the device, the person, the exact instant and whatever the device
 * calls the transaction. A timestamp alone would collapse two people punching
 * in the same second; including the device means the same person on two
 * terminals is two events, which is what actually happened.
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

/** Rejects a transaction this system cannot store meaningfully. */
function assertUsable(punch: DevicePunch): void {
  if (!punch.deviceUserId || punch.deviceUserId.trim() === '') {
    throw new MalformedPunchError('the transaction carries no device user ID');
  }
  const at = punch.punchedAt?.getTime();
  if (at === undefined || Number.isNaN(at)) {
    throw new MalformedPunchError(`the timestamp "${punch.rawTimestamp}" could not be read`);
  }
  if (at < PLAUSIBLE_FROM || at > PLAUSIBLE_TO) {
    throw new MalformedPunchError(`the timestamp "${punch.rawTimestamp}" is outside any plausible range`);
  }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches the log, retrying a limited number of times.
 *
 * Only connection-level failures are retried. A device that rejects the comm
 * key will reject it again in two seconds, so that fails immediately rather
 * than hammering a terminal with bad credentials.
 */
async function fetchWithRetry(
  device: AttendanceDevice,
  since: Date,
): Promise<{ punches: DevicePunch[]; attempts: number }> {
  const adapter = adapterFor(device.protocol);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      logger.info({ event: 'DEVICE_CONNECT', deviceId: device.id, attempt }, 'connecting to device');
      const punches = await adapter.getAttendance(connectionFor(device), { since });
      logger.info(
        { event: 'DEVICE_DISCONNECT', deviceId: device.id, fetched: punches.length },
        'device read complete',
      );
      return { punches, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (error instanceof DeviceAuthError) throw error;
      if (attempt === MAX_ATTEMPTS) break;

      const wait = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      logger.warn(
        {
          event: 'SYNC_RETRY',
          deviceId: device.id,
          attempt,
          waitMs: wait,
          reason: error instanceof Error ? error.message : 'unknown',
        },
        'device read failed, retrying',
      );
      await sleep(wait);
    }
  }

  throw new DeviceReadError(
    lastError instanceof Error ? lastError.message : 'The device could not be read.',
    MAX_ATTEMPTS,
    lastError,
  );
}

/**
 * Where the watermark may safely move to.
 *
 * Extracted because it is the single most consequential decision in a sync and
 * the one hardest to reach through a socket: moving it too far loses punches
 * for good, while leaving it behind costs only a re-read that deduplicates.
 *
 *   - a failed read tells us nothing reliable, so the cursor does not move;
 *   - a record expected to be retried holds the cursor behind itself;
 *   - a record that can never be read does not, or it would block forever.
 */
export function computeNextCursor(input: {
  failed: boolean;
  cursorUnsafe: boolean;
  latestStoredAt: Date | null;
  earliestUnstoredAt: Date | null;
}): Date | null {
  if (input.failed || input.cursorUnsafe) return null;
  if (!input.earliestUnstoredAt) return input.latestStoredAt;

  const safe = new Date(input.earliestUnstoredAt.getTime() - 1000);
  if (!input.latestStoredAt) return safe;
  return input.latestStoredAt < safe ? input.latestStoredAt : safe;
}

/** Synchronises one device. Safe to call concurrently; the loser is told so. */
export async function syncDevice(
  deviceId: string,
  trigger: AttendanceSyncTrigger = 'SCHEDULED',
): Promise<SyncOutcome> {
  const device = await prisma.attendanceDevice.findUniqueOrThrow({ where: { id: deviceId } });
  const cursorBefore = device.syncCursorAt;

  if (!device.isEnabled) {
    return {
      syncId: '',
      deviceId,
      status: 'SKIPPED',
      recordsFetched: 0,
      recordsImported: 0,
      duplicatesIgnored: 0,
      unmappedRecords: 0,
      errors: 0,
      recalculatedDays: 0,
      attempts: 0,
      cursorBefore: cursorBefore?.toISOString() ?? null,
      cursorAfter: cursorBefore?.toISOString() ?? null,
      error: 'The device is disabled.',
    };
  }

  const token = await acquireLock(deviceId);
  if (!token) throw new SyncInProgressError();

  // From the cursor less the overlap, or a bounded look-back on a first run.
  // This is what makes an outage an ordinary catch-up rather than lost days.
  const since = cursorBefore
    ? new Date(cursorBefore.getTime() - CURSOR_OVERLAP_MS)
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

  logger.info(
    { event: 'SYNC_STARTED', deviceId, syncId: sync.id, trigger, since: since.toISOString() },
    'device sync started',
  );

  let recordsFetched = 0;
  let recordsImported = 0;
  let duplicatesIgnored = 0;
  let unmappedRecords = 0;
  let errors = 0;
  let recalculatedDays = 0;
  let attempts = 0;
  let failure: string | null = null;

  // Cursor inputs, kept apart on purpose.
  let latestStoredAt: Date | null = null;
  let earliestUnstoredAt: Date | null = null;
  /** Set when a failure has no usable timestamp, so no safe cursor exists. */
  let cursorUnsafe = false;

  const errorDetails: Array<Record<string, unknown>> = [];
  const noteError = (detail: Record<string, unknown>) => {
    errors += 1;
    if (errorDetails.length < MAX_ERROR_DETAILS) errorDetails.push(detail);
  };

  try {
    const fetched = await fetchWithRetry(device, since);
    attempts = fetched.attempts;
    recordsFetched = fetched.punches.length;

    const [mappings, policy] = await Promise.all([
      prisma.attendanceDeviceUserMapping.findMany({
        where: { deviceId, isActive: true },
        select: { deviceUserId: true, employeeId: true },
      }),
      resolveAttendancePolicy(device.companyId),
    ]);
    const employeeByDeviceUser = new Map(mappings.map((m) => [m.deviceUserId, m.employeeId]));

    const touched = new Map<string, { employeeId: string; dayKey: string }>();

    for (const punch of fetched.punches) {
      try {
        assertUsable(punch);

        const outcome = await importPunch({
          device,
          syncId: sync.id,
          punch,
          companyTimeZone: policy.timeZone,
          employeeId: employeeByDeviceUser.get(punch.deviceUserId) ?? null,
        });

        if (outcome.duplicate) {
          duplicatesIgnored += 1;
          logger.debug(
            { event: 'DUPLICATE_IGNORED', deviceId, deviceUserId: punch.deviceUserId },
            'duplicate punch ignored',
          );
        } else {
          recordsImported += 1;
          logger.debug(
            { event: 'RECORD_IMPORTED', deviceId, deviceUserId: punch.deviceUserId },
            'punch imported',
          );
        }

        if (!outcome.employeeId) {
          unmappedRecords += 1;
          logger.info(
            { event: 'UNMAPPED_USER', deviceId, deviceUserId: punch.deviceUserId },
            'punch has no employee mapping',
          );
        }

        // Only a stored record may move the cursor.
        if (!latestStoredAt || punch.punchedAt > latestStoredAt) latestStoredAt = punch.punchedAt;

        if (outcome.employeeId && !outcome.duplicate) {
          touched.set(`${outcome.employeeId}:${outcome.dayKey}`, {
            employeeId: outcome.employeeId,
            dayKey: outcome.dayKey,
          });
        }
      } catch (error) {
        const permanent = error instanceof MalformedPunchError;
        const reason = error instanceof Error ? error.message : 'unknown failure';

        noteError({
          deviceUserId: punch.deviceUserId || null,
          rawTimestamp: punch.rawTimestamp || null,
          reason,
          permanent,
        });

        logger.warn(
          { event: 'RECORD_ERROR', deviceId, deviceUserId: punch.deviceUserId, permanent, reason },
          'punch could not be imported',
        );

        // A record that can never be read must not hold the watermark hostage;
        // one that merely failed to store must be tried again, so the cursor
        // stays behind it.
        if (!permanent) {
          const at = punch.punchedAt?.getTime();
          if (at === undefined || Number.isNaN(at)) cursorUnsafe = true;
          else if (!earliestUnstoredAt || punch.punchedAt < earliestUnstoredAt) {
            earliestUnstoredAt = punch.punchedAt;
          }
        }
      }
    }

    const recalc = await recalculateDays({
      companyId: device.companyId,
      pairing: device.punchPairing,
      days: [...touched.values()],
    });
    recalculatedDays = recalc.recalculated;
    if (recalc.failed > 0) {
      noteError({ reason: `${recalc.failed} day(s) could not be recalculated`, permanent: false });
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : 'The synchronisation failed.';
    if (error instanceof DeviceReadError) attempts = error.attempts;
    // A read that failed part-way tells us nothing reliable about what the
    // device holds, so the cursor stays exactly where it was.
    cursorUnsafe = true;
  }

  const nextCursor = computeNextCursor({
    failed: failure !== null,
    cursorUnsafe,
    latestStoredAt,
    earliestUnstoredAt,
  });

  const status = failure ? 'FAILED' : errors > 0 ? 'PARTIAL' : 'SUCCESS';
  const finishedAt = new Date();

  await prisma.attendanceDeviceSync.update({
    where: { id: sync.id },
    data: {
      finishedAt,
      status,
      attempts,
      fetched: recordsFetched,
      inserted: recordsImported,
      duplicates: duplicatesIgnored,
      unmapped: unmappedRecords,
      rejected: errors,
      cursorTo: nextCursor,
      error: failure,
      errorDetails: errorDetails.length > 0 ? (errorDetails as Prisma.InputJsonValue) : undefined,
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
            ...(nextCursor ? { syncCursorAt: nextCursor } : {}),
            ...(latestStoredAt ? { lastPunchAt: latestStoredAt } : {}),
          }),
    },
  });

  await releaseLock(deviceId, token);

  const outcome: SyncOutcome = {
    syncId: sync.id,
    deviceId,
    status,
    recordsFetched,
    recordsImported,
    duplicatesIgnored,
    unmappedRecords,
    errors,
    recalculatedDays,
    attempts,
    cursorBefore: cursorBefore?.toISOString() ?? null,
    cursorAfter: (nextCursor ?? cursorBefore)?.toISOString() ?? null,
    error: failure,
  };

  if (failure) {
    logger.warn({ event: 'SYNC_FAILED', deviceId, syncId: sync.id, attempts, reason: failure }, 'device sync failed');
  } else {
    logger.info(
      {
        event: 'SYNC_COMPLETED',
        deviceId,
        syncId: sync.id,
        status,
        recordsFetched,
        recordsImported,
        duplicatesIgnored,
        unmappedRecords,
        errors,
        recalculatedDays,
        cursorAfter: outcome.cursorAfter,
      },
      'device sync completed',
    );
  }

  return outcome;
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
    } catch (error) {
      // Already running, or unreachable beyond its retries. Either way the next
      // tick tries again; one terminal being down must not stop the loop.
      if (!(error instanceof SyncInProgressError)) {
        logger.warn(
          { event: 'SYNC_FAILED', deviceId: device.id, reason: error instanceof Error ? error.message : 'unknown' },
          'scheduled device sync failed',
        );
      }
    }
  }

  return outcomes;
}
