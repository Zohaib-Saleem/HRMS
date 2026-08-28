import { randomUUID } from 'node:crypto';
import type { AttendanceDevice, Prisma } from '@prisma/client';
import { prisma } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { decryptSecret } from '../../core/secrets.js';
import { ipMatches, resolveAttendancePolicy } from '../time/attendance-policy.js';
import { ingestPunches } from './sync.service.js';
import { recalculateDays } from './attendance-import.service.js';
import { parseAttlog, type AdmsLineError } from './adms.protocol.js';

/**
 * Receiving pushed attendance.
 *
 * A pushing terminal authenticates with nothing but a serial number printed on
 * its own case, so this file treats every request as hostile until three things
 * line up: the serial belongs to an enabled ADMS device, the secret path token
 * matches if one is configured, and the source address is inside the device
 * allow-list if one is configured.
 *
 * Once a batch is accepted it goes through the same ingest the pull path uses.
 * No rule about pairing, day status or overtime lives here; a punch that
 * arrives by push is indistinguishable downstream from one that was fetched,
 * which is the entire point.
 */

/** Errors kept per push, matching the pull path limit. */
const MAX_ERROR_DETAILS = 20;

export type PushRejection =
  | 'UNKNOWN_DEVICE'
  | 'DEVICE_DISABLED'
  | 'WRONG_PROTOCOL'
  | 'BAD_TOKEN'
  | 'BLOCKED_SOURCE';

export class PushAuthError extends Error {
  readonly rejection: PushRejection;

  constructor(rejection: PushRejection, message: string) {
    super(message);
    this.name = 'PushAuthError';
    this.rejection = rejection;
  }
}

/**
 * Finds the device a request claims to be, and proves the claim.
 *
 * An unknown serial and a wrong token deliberately fail with the same message:
 * a caller probing serial numbers learns nothing from the response about which
 * half of the credential was wrong.
 */
export async function authenticatePush(input: {
  serialNumber: string | undefined;
  token: string | null;
  sourceIp: string | null;
}): Promise<AttendanceDevice> {
  const serial = input.serialNumber?.trim();
  if (!serial) throw new PushAuthError('UNKNOWN_DEVICE', 'This device is not registered.');

  // Serials are printed on a label and typed by a human at least once, so the
  // comparison is case-insensitive on both sides.
  const device = await prisma.attendanceDevice.findFirst({
    where: { serialNumber: { equals: serial, mode: 'insensitive' } },
  });

  if (!device) throw new PushAuthError('UNKNOWN_DEVICE', 'This device is not registered.');
  if (device.protocol !== 'ZKTECO_ADMS') {
    throw new PushAuthError(
      'WRONG_PROTOCOL',
      'This device is not configured to push records. Set its protocol to ADMS first.',
    );
  }
  if (!device.isEnabled) throw new PushAuthError('DEVICE_DISABLED', 'This device is disabled.');

  if (device.pushTokenCipher) {
    const expected = decryptSecret(device.pushTokenCipher);
    // An unreadable stored token fails closed. Treating it as absent would turn
    // a key-rotation mistake into an open endpoint.
    if (!expected || !input.token || input.token !== expected) {
      throw new PushAuthError('BAD_TOKEN', 'This device is not registered.');
    }
  }

  if (device.allowedPushCidrs.length > 0) {
    const ip = input.sourceIp ?? '';
    if (!ip || !device.allowedPushCidrs.some((entry) => ipMatches(ip, entry))) {
      throw new PushAuthError('BLOCKED_SOURCE', 'This device may not push from this network.');
    }
  }

  return device;
}

export interface PushResult {
  /** Records the device sent, readable or not. */
  received: number;
  imported: number;
  duplicates: number;
  unmapped: number;
  errors: number;
  recalculatedDays: number;
  syncId: string | null;
}

/**
 * Records a heartbeat from a device that had nothing to say.
 *
 * Terminals poll constantly. Writing a sync row for every empty poll would bury
 * the real history, so only the timestamp moves.
 */
export async function noteDeviceContact(deviceId: string): Promise<void> {
  const now = new Date();
  await prisma.attendanceDevice.update({
    where: { id: deviceId },
    data: { lastPushAt: now, lastSeenAt: now, status: 'ONLINE', lastError: null },
  });
}

/**
 * Ingests one pushed ATTLOG batch.
 *
 * The batch is recorded as a sync run with a PUSH trigger, so pushed and pulled
 * imports appear in one history and a device that pushes can be diagnosed with
 * the same screen as one that is polled.
 */
export async function ingestPush(input: {
  device: AttendanceDevice;
  body: string;
}): Promise<PushResult> {
  const { device, body } = input;

  const parsed = parseAttlog(body, device.timeZone);
  const received = parsed.punches.length + parsed.errors.length;



  if (received === 0) {
    // A stamp request or an empty body. Nothing to record beyond the contact.
    await noteDeviceContact(device.id);
    return {
      received: 0,
      imported: 0,
      duplicates: 0,
      unmapped: 0,
      errors: 0,
      recalculatedDays: 0,
      syncId: null,
    };
  }

  const sync = await prisma.attendanceDeviceSync.create({
    data: {
      id: randomUUID(),
      companyId: device.companyId,
      deviceId: device.id,
      trigger: 'PUSH',
      status: 'RUNNING',
      // A push carries no window: the device chose what to send.
      cursorFrom: device.syncCursorAt,
    },
  });

  const policy = await resolveAttendancePolicy(device.companyId);

  const mappings = await prisma.attendanceDeviceUserMapping.findMany({
    where: { deviceId: device.id, isActive: true },
    select: { deviceUserId: true, employeeId: true },
  });
  const employeeByDeviceUser = new Map<string, string>(
    mappings.map((m) => [m.deviceUserId, m.employeeId] as const),
  );

  const tally = await ingestPunches({
    device,
    syncId: sync.id,
    punches: parsed.punches,
    companyTimeZone: policy.timeZone,
    employeeByDeviceUser,
  });

  // Unreadable lines are the device errors, not the ingest errors, but they
  // belong in the same count so the history shows what was actually sent.
  const errorDetails = [
    ...tally.errorDetails,
    ...parsed.errors.slice(0, MAX_ERROR_DETAILS).map((error: AdmsLineError) => ({
      deviceUserId: null,
      rawTimestamp: error.raw,
      reason: error.reason,
      // A malformed line cannot become readable by being sent again.
      permanent: true,
    })),
  ].slice(0, MAX_ERROR_DETAILS);

  const errors = tally.errors + parsed.errors.length;

  const recalc = await recalculateDays({
    companyId: device.companyId,
    pairing: device.punchPairing,
    days: [...tally.touched.values()],
  });

  const status = errors > 0 ? 'PARTIAL' : 'SUCCESS';
  const completedAt = new Date();

  await prisma.attendanceDeviceSync.update({
    where: { id: sync.id },
    data: {
      status,
      finishedAt: completedAt,
      attempts: 1,
      fetched: received,
      inserted: tally.imported,
      duplicates: tally.duplicates,
      unmapped: tally.unmapped,
      rejected: errors,
      errorDetails:
        errorDetails.length > 0 ? (errorDetails as Prisma.InputJsonValue) : undefined,
      // The watermark belongs to the pull path. A push must not advance it:
      // the device decides what to send, so a moved cursor would let a later
      // poll skip records that were never pushed at all.
      cursorTo: device.syncCursorAt,
    },
  });

  await prisma.attendanceDevice.update({
    where: { id: device.id },
    data: {
      lastPushAt: completedAt,
      lastSeenAt: completedAt,
      lastSyncAt: completedAt,
      status: 'ONLINE',
      lastError: null,
      ...(tally.latestStoredAt && (!device.lastPunchAt || tally.latestStoredAt > device.lastPunchAt)
        ? { lastPunchAt: tally.latestStoredAt }
        : {}),
    },
  });

  logger.info(
    {
      event: 'PUSH_BATCH',
      deviceId: device.id,
      received,
      imported: tally.imported,
      duplicates: tally.duplicates,
      unmapped: tally.unmapped,
      errors,
    },
    'attendance batch received from device',
  );

  return {
    received,
    imported: tally.imported,
    duplicates: tally.duplicates,
    unmapped: tally.unmapped,
    errors,
    recalculatedDays: recalc.recalculated,
    syncId: sync.id,
  };
}
