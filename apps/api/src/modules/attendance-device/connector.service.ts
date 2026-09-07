import { randomUUID } from 'node:crypto';
import type { AttendanceDevice, Prisma } from '@prisma/client';
import type { ConnectorPunch, ConnectorRoster } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { decryptSecret } from '../../core/secrets.js';
import { instantInZone } from '../../core/zoned-time.js';
import { ipMatches, resolveAttendancePolicy } from '../time/attendance-policy.js';
import { ingestPunches } from './sync.service.js';
import { recalculateDays } from './attendance-import.service.js';
import type { DevicePunch } from '@hrms/zkteco';

/**
 * Receiving attendance from a connector on the device's own LAN.
 *
 * The problem this solves is a routing one, not an attendance one. A terminal
 * whose firmware has no ADMS option can only be pulled from, and pulling means
 * opening a socket to an address on an office LAN that this server has no route
 * to. So the pull moves to a machine that does have the route, and what crosses
 * the internet is an ordinary outbound HTTPS request instead of an exposed
 * device port.
 *
 * Everything downstream of `ingestPunches` is shared with the pull and ADMS
 * paths. That is deliberate and load-bearing: a punch that arrived by connector
 * must be indistinguishable from the same punch pulled directly, or the same
 * transaction would be scored twice under two different identities.
 *
 * What this file owns is exactly two things - proving the caller is the
 * connector for a registered device, and turning its wall-clock readings into
 * instants using the zone the HRMS holds. No pairing rule, no day status and no
 * overtime decision lives here.
 */

/** Errors kept per batch, matching the pull and push paths. */
const MAX_ERROR_DETAILS = 20;

/** A punch instant outside this range is a decode failure, not a reading. */
const PLAUSIBLE_FROM = Date.UTC(2000, 0, 1);
const PLAUSIBLE_TO = Date.UTC(2100, 0, 1);

export type ConnectorRejection =
  | 'NO_CREDENTIAL'
  | 'UNKNOWN_DEVICE'
  | 'DEVICE_DISABLED'
  | 'WRONG_PROTOCOL'
  | 'BAD_TOKEN'
  | 'SERIAL_MISMATCH'
  | 'BLOCKED_SOURCE';

export class ConnectorAuthError extends Error {
  readonly rejection: ConnectorRejection;

  constructor(rejection: ConnectorRejection, message: string) {
    super(message);
    this.name = 'ConnectorAuthError';
    this.rejection = rejection;
  }
}

/** A device registered for connector delivery but with no token set. */
export class ConnectorNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorNotConfiguredError';
  }
}

/**
 * Finds the device the connector claims to serve, and proves the claim.
 *
 * Two credentials, and both must line up: a bearer token, which is a secret an
 * administrator generated, and the terminal serial the connector read off the
 * device itself over the LAN. The token alone would authenticate a connector
 * pointed at the wrong terminal - a real mistake in an office with two of them,
 * and one that would silently file one department's punches under another's
 * device. The serial is what catches it.
 *
 * A wrong token and an unknown device deliberately fail alike, so probing
 * serials teaches a caller nothing.
 */
export async function authenticateConnector(input: {
  token: string | null;
  serialNumber: string | undefined;
  sourceIp: string | null;
}): Promise<AttendanceDevice> {
  const token = input.token?.trim();
  if (!token) {
    throw new ConnectorAuthError('NO_CREDENTIAL', 'This connector is not registered.');
  }

  const serial = input.serialNumber?.trim();
  if (!serial) {
    throw new ConnectorAuthError('UNKNOWN_DEVICE', 'This connector is not registered.');
  }

  // Serials are printed on a label and typed by a human at least once, so the
  // comparison is case-insensitive on both sides.
  const device = await prisma.attendanceDevice.findFirst({
    where: { serialNumber: { equals: serial, mode: 'insensitive' } },
  });

  if (!device) throw new ConnectorAuthError('UNKNOWN_DEVICE', 'This connector is not registered.');

  if (device.protocol !== 'ZKTECO_LAN_CONNECTOR') {
    throw new ConnectorAuthError(
      'WRONG_PROTOCOL',
      'This device does not receive records from a connector. Set its protocol to the local connector first.',
    );
  }
  if (!device.isEnabled) {
    throw new ConnectorAuthError('DEVICE_DISABLED', 'This device is disabled.');
  }

  // No token stored is not "no token required". A connector device with no
  // credential is a misconfiguration, and treating it as open would turn a
  // half-finished setup into an unauthenticated ingest endpoint.
  if (!device.pushTokenCipher) {
    throw new ConnectorNotConfiguredError(
      'This device has no connector token. Set one on the Devices page before the connector can send anything.',
    );
  }

  const expected = decryptSecret(device.pushTokenCipher);
  // An unreadable stored token fails closed, so a key-rotation mistake cannot
  // widen the endpoint.
  if (!expected || !safeEqual(token, expected)) {
    throw new ConnectorAuthError('BAD_TOKEN', 'This connector is not registered.');
  }

  if (device.allowedPushCidrs.length > 0) {
    const ip = input.sourceIp ?? '';
    if (!ip || !device.allowedPushCidrs.some((entry) => ipMatches(ip, entry))) {
      throw new ConnectorAuthError('BLOCKED_SOURCE', 'This connector may not post from this network.');
    }
  }

  return device;
}

/**
 * Constant-time comparison over equal-length strings.
 *
 * Length is compared first and leaks, which is acceptable: the tokens are
 * generated at a fixed length, so an attacker learns nothing they did not
 * already know from the generator.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** A record the connector sent that this system cannot place in time. */
interface RejectedRecord {
  deviceUserId: string | null;
  rawTimestamp: string | null;
  reason: string;
  permanent: boolean;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turns the connector's readings into punches, applying the device zone.
 *
 * Exported because this is where a wrong timezone becomes a wrong attendance
 * day, and that deserves to be testable without a socket or a request.
 *
 * The instant is built exactly the way the pull adapter and the ADMS parser
 * build it - seconds added on top of a minute-resolution instant - so the same
 * transaction arriving by any of the three routes lands on the same millisecond
 * and therefore on the same fingerprint.
 */
export function toDevicePunches(
  records: readonly ConnectorPunch[],
  deviceTimeZone: string,
): { punches: DevicePunch[]; rejected: RejectedRecord[] } {
  const punches: DevicePunch[] = [];
  const rejected: RejectedRecord[] = [];

  for (const record of records) {
    const parts = STAMP.exec(record.rawTimestamp);
    if (!parts) {
      rejected.push({
        deviceUserId: record.deviceUserId,
        rawTimestamp: record.rawTimestamp,
        reason: 'The timestamp is not in the expected YYYY-MM-DD HH:mm:ss form.',
        // The connector will send the same digits next time; retrying is futile.
        permanent: true,
      });
      continue;
    }

    const [, year, month, day, hour, minute, second] = parts;

    let punchedAt: Date;
    try {
      punchedAt = new Date(
        instantInZone(`${year}-${month}-${day}`, Number(hour), Number(minute), deviceTimeZone).getTime() +
          (second ? Number(second) : 0) * 1000,
      );
    } catch {
      rejected.push({
        deviceUserId: record.deviceUserId,
        rawTimestamp: record.rawTimestamp,
        reason: `The timestamp could not be placed in the device timezone "${deviceTimeZone}".`,
        // A zone this runtime cannot read is a configuration fault an
        // administrator can fix, so the record is worth sending again.
        permanent: false,
      });
      continue;
    }

    const at = punchedAt.getTime();
    if (Number.isNaN(at) || at < PLAUSIBLE_FROM || at > PLAUSIBLE_TO) {
      rejected.push({
        deviceUserId: record.deviceUserId,
        rawTimestamp: record.rawTimestamp,
        reason: 'The timestamp is outside any plausible range.',
        permanent: true,
      });
      continue;
    }

    punches.push({
      deviceUserId: record.deviceUserId,
      deviceTransactionId: record.deviceTransactionId ?? null,
      rawTimestamp: `${year}-${month}-${day} ${hour}:${minute}:${second ?? '00'}`,
      punchedAt,
      punchState: record.punchState ?? null,
      verifyMode: record.verifyMode ?? null,
    });
  }

  return { punches, rejected };
}

/**
 * The watermark hint given back to a connector.
 *
 * Expressed as a device wall-clock reading rather than an instant, because that
 * is the only form the connector can compare against without knowing the device
 * timezone - and not knowing it is precisely what keeps the zone a single
 * setting held in one place.
 */
export function cursorHintFor(device: AttendanceDevice): string | null {
  if (!device.lastPunchAt) return null;
  return wallClockIn(device.lastPunchAt, device.timeZone);
}

function wallClockIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * How far the terminal clock has drifted from this server's, in minutes.
 *
 * A terminal keeps its own clock and nothing corrects it, so a drifting one is
 * the quiet cause of punches landing on the wrong side of a shift boundary -
 * and the readings themselves look perfectly ordinary. Reported rather than
 * corrected: rewriting a reading here would destroy the evidence that the
 * device needs setting, and the fix belongs at the terminal.
 *
 * Null when the connector sent nothing, or sent something unreadable. Neither
 * is worth failing a batch of real attendance over.
 */
export function driftMinutes(deviceTime: string | null | undefined, timeZone: string): number | null {
  if (!deviceTime) return null;
  const parts = STAMP.exec(deviceTime.trim());
  if (!parts) return null;

  const [, year, month, day, hour, minute, second] = parts;
  try {
    const reading =
      instantInZone(`${year}-${month}-${day}`, Number(hour), Number(minute), timeZone).getTime() +
      (second ? Number(second) : 0) * 1000;
    if (Number.isNaN(reading)) return null;
    return Math.round((reading - Date.now()) / 60000);
  } catch {
    return null;
  }
}

/** Records that the connector called but had nothing to send. */
export async function noteConnectorContact(
  deviceId: string,
  connectorVersion: string | null,
): Promise<void> {
  const now = new Date();
  await prisma.attendanceDevice.update({
    where: { id: deviceId },
    data: {
      lastPushAt: now,
      lastSeenAt: now,
      status: 'ONLINE',
      lastError: null,
      ...(connectorVersion ? { connectorVersion } : {}),
    },
  });
}

export interface ConnectorIngestResult {
  received: number;
  imported: number;
  duplicates: number;
  unmapped: number;
  errors: number;
  recalculatedDays: number;
  syncId: string | null;
  cursorHint: string | null;
}

/**
 * Ingests one batch from a connector.
 *
 * Recorded as a sync run with the PUSH trigger, so connector deliveries appear
 * in the same history as everything else and one screen diagnoses the terminal
 * however its records reached us.
 *
 * The device watermark - `syncCursorAt` - is deliberately not advanced. It
 * belongs to the server-side pull, and moving it from here would let a later
 * direct poll skip records the connector never happened to send.
 */
export async function ingestConnectorBatch(input: {
  device: AttendanceDevice;
  records: readonly ConnectorPunch[];
  connectorVersion: string | null;
}): Promise<ConnectorIngestResult> {
  const { device, records, connectorVersion } = input;

  if (records.length === 0) {
    await noteConnectorContact(device.id, connectorVersion);
    return {
      received: 0,
      imported: 0,
      duplicates: 0,
      unmapped: 0,
      errors: 0,
      recalculatedDays: 0,
      syncId: null,
      cursorHint: cursorHintFor(device),
    };
  }

  const { punches, rejected } = toDevicePunches(records, device.timeZone);

  const sync = await prisma.attendanceDeviceSync.create({
    data: {
      id: randomUUID(),
      companyId: device.companyId,
      deviceId: device.id,
      trigger: 'PUSH',
      status: 'RUNNING',
      // A connector batch carries no window: the connector chose what to send.
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
    punches,
    companyTimeZone: policy.timeZone,
    employeeByDeviceUser,
  });

  const errorDetails = [...tally.errorDetails, ...rejected].slice(0, MAX_ERROR_DETAILS);
  const errors = tally.errors + rejected.length;

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
      fetched: records.length,
      inserted: tally.imported,
      duplicates: tally.duplicates,
      unmapped: tally.unmapped,
      rejected: errors,
      errorDetails: errorDetails.length > 0 ? (errorDetails as Prisma.InputJsonValue) : undefined,
      // Unchanged, for the reason given above the function.
      cursorTo: device.syncCursorAt,
    },
  });

  const advancesLastPunch =
    tally.latestStoredAt !== null &&
    (!device.lastPunchAt || tally.latestStoredAt > device.lastPunchAt);

  const updated = await prisma.attendanceDevice.update({
    where: { id: device.id },
    data: {
      lastPushAt: completedAt,
      lastSeenAt: completedAt,
      lastSyncAt: completedAt,
      status: 'ONLINE',
      lastError: null,
      ...(connectorVersion ? { connectorVersion } : {}),
      ...(advancesLastPunch ? { lastPunchAt: tally.latestStoredAt } : {}),
    },
  });

  logger.info(
    {
      event: 'CONNECTOR_BATCH',
      deviceId: device.id,
      received: records.length,
      imported: tally.imported,
      duplicates: tally.duplicates,
      unmapped: tally.unmapped,
      errors,
    },
    'attendance batch received from local connector',
  );

  return {
    received: records.length,
    imported: tally.imported,
    duplicates: tally.duplicates,
    unmapped: tally.unmapped,
    errors,
    recalculatedDays: recalc.recalculated,
    syncId: sync.id,
    cursorHint: cursorHintFor(updated),
  };
}

/**
 * Stores the enrolment roster the connector read off the terminal.
 *
 * A cache for the mapping screen and nothing more. It never creates a mapping,
 * never creates an employee and never touches a punch: a name appearing on a
 * terminal is not a decision about whose attendance anything is, and the person
 * who makes that decision is an administrator.
 *
 * Users the device no longer holds are removed, because a stale roster is worse
 * than a short one - it invites someone to map a PIN that no longer exists.
 */
export async function storeRoster(input: {
  device: AttendanceDevice;
  users: ConnectorRoster['users'];
}): Promise<{ received: number; stored: number; unmapped: number }> {
  const { device, users } = input;

  // Last entry wins: a terminal that reports one PIN twice is a device quirk,
  // not a reason to fail the whole roster.
  const byPin = new Map(users.map((user) => [user.deviceUserId, user] as const));
  const seenAt = new Date();

  await prisma.$transaction([
    ...[...byPin.values()].map((user) =>
      prisma.attendanceDeviceEnrolledUser.upsert({
        where: {
          deviceId_deviceUserId: { deviceId: device.id, deviceUserId: user.deviceUserId },
        },
        create: {
          companyId: device.companyId,
          deviceId: device.id,
          deviceUserId: user.deviceUserId,
          name: user.name ?? null,
          privilege: user.privilege ?? null,
          cardNumber: user.cardNumber ?? null,
          seenAt,
        },
        update: {
          name: user.name ?? null,
          privilege: user.privilege ?? null,
          cardNumber: user.cardNumber ?? null,
          seenAt,
        },
      }),
    ),
    prisma.attendanceDeviceEnrolledUser.deleteMany({
      where: { deviceId: device.id, deviceUserId: { notIn: [...byPin.keys()] } },
    }),
  ]);

  const mapped = await prisma.attendanceDeviceUserMapping.count({
    where: { deviceId: device.id, isActive: true, deviceUserId: { in: [...byPin.keys()] } },
  });

  logger.info(
    { event: 'CONNECTOR_ROSTER', deviceId: device.id, users: byPin.size, mapped },
    'device enrolment roster received from local connector',
  );

  return { received: users.length, stored: byPin.size, unmapped: byPin.size - mapped };
}
