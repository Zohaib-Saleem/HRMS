import { createHash, randomUUID } from 'node:crypto';
import type { AttendanceDevice, Prisma } from '@prisma/client';
import type { ConnectorPunch, ConnectorRoster } from '@hrms/shared';
import { env } from '../../config/env.js';
import { ValidationError } from '../../core/errors.js';
import { prisma } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { decryptSecret } from '../../core/secrets.js';
import { instantInZone } from '../../core/zoned-time.js';
import { ipMatches, resolveAttendancePolicy } from '../time/attendance-policy.js';
import { ingestPunches } from './sync.service.js';
import { recalculateDays } from './attendance-import.service.js';
import { PUNCH_STATES } from '@hrms/zkteco';
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

// ---------------------------------------------------------------------------
// The agent envelope - POST /connector
// ---------------------------------------------------------------------------

/**
 * Field names an agent might use for each thing this server needs.
 *
 * Ordered by confidence, first match wins. This exists because the agent
 * posting to the bare `/connector` path was written against the address the
 * Devices page prints rather than against this repository, so its field names
 * are its own. Guessing is not free - `uid` in ZKTeco firmware is a row index,
 * not a PIN, which is why it sits last behind every name that unambiguously
 * means the enrolled number - so the key that actually matched is reported back
 * to the operator rather than being resolved silently.
 */
/** Mirrors the shared cap; a longer array is truncated rather than refused. */
const AGENT_MAX_RECORDS = 50_000;

const AGENT_ALIASES = {
  // `userPin` first: it is what the K50's agent calls the enrolled number, and
  // it is unambiguous. `deviceUid` is deliberately absent - in ZKTeco firmware
  // that is a row index into the transaction log, reused after the log is
  // cleared, so treating it as a person would eventually file one employee's
  // punches under another.
  deviceUserId: ['userPin', 'deviceUserId', 'userId', 'user_id', 'userSn', 'pin', 'PIN', 'employeeCode', 'badgeNumber', 'uid'],
  // The terminal's own clock face, which is what the device timezone is applied
  // to downstream. `timestampUtc` is the fallback rather than the preference:
  // an absolute instant is only better if it really is absolute, and a field
  // named UTC that in fact holds local time would move every punch by the
  // zone's offset with nothing to show for it.
  rawTimestamp: ['timestamp', 'rawTimestamp', 'punchTime', 'recordTime', 'checkTime', 'time', 'datetime', 'dateTime', 'punchedAt', 'timestampUtc'],
  // `punchCode` before `status`: the code is the raw punch byte, and putting it
  // through the same map the pull adapter uses is what makes a connector punch
  // and a polled one identical rather than merely similar. The K50's agent
  // sends both - `punchCode: 0` alongside `status: 'CHECK_IN'` - and only one
  // of them is a vocabulary the rest of this system already speaks.
  punchState: ['punchCode', 'punchState', 'punchType', 'state', 'inOut', 'status', 'type'],
  verifyMode: ['verifyMode', 'verifyType', 'verifyMethod', 'verify', 'verifyCode'],
  // `deviceUid` is not accepted here either, and for the same reason: a reused
  // row index inside the fingerprint would make two different punches look like
  // one. Left null, the fingerprint is PIN plus instant plus direction, which is
  // exactly what the pull path derives for the same transaction.
  deviceTransactionId: ['deviceTransactionId', 'transactionId', 'recordId', 'logId', 'sn'],
  recordHash: ['recordHash', 'hash', 'checksum'],
} as const;

function pick(record: Record<string, unknown>, names: readonly string[]): { key: string; value: unknown } | null {
  for (const name of names) {
    const value = record[name];
    if (value === undefined || value === null || value === '') continue;
    return { key: name, value };
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

/** An absolute instant, in the forms an agent is likely to send one. */
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Turns whatever the agent called a time into a device wall-clock reading.
 *
 * The distinction that matters: everything downstream treats the string as the
 * terminal's own clock face and applies the device timezone to it. So a reading
 * that arrives already carrying an offset - `...T08:56:12Z`, or `+05:00` - must
 * be converted into that clock face rather than have its suffix trimmed off.
 * Trimming would be silent and would move every punch by the zone's offset,
 * which in Asia/Karachi is five hours: a morning arrival filed as an overnight
 * one, with nothing in the record to say why.
 */
function toWallClock(value: unknown, timeZone: string): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    const instant = new Date(ms);
    return Number.isNaN(instant.getTime()) ? null : wallClockIn(instant, timeZone);
  }

  const text = asText(value);
  if (!text) return null;

  if (/^\d{10}$|^\d{13}$/.test(text)) {
    return toWallClock(Number(text), timeZone);
  }

  if (OFFSET.test(text)) {
    const instant = new Date(text);
    return Number.isNaN(instant.getTime()) ? null : wallClockIn(instant, timeZone);
  }

  // A local reading. Normalised to the one form the decoder accepts, with the
  // separator, any fractional seconds and a slashed date all smoothed out -
  // none of which changes what the terminal recorded.
  const local = text.replace('T', ' ').replace(/\.\d+$/, '').replace(/\//g, '-').trim();
  return STAMP.test(local) ? local : null;
}

/**
 * Names an agent's direction in the vocabulary the HRMS already uses.
 *
 * Three things arrive here and all must come out the same: the raw punch byte,
 * a name this system already uses, and an agent's own spelling of that name.
 * This matters more than it looks - `punchState` is an ingredient of the
 * fingerprint, so two spellings of one direction are two different punches, and
 * the day the spelling changed would quietly double every record around it.
 * Deciding it once, before anything is stored, is the cheap moment.
 *
 * Anything unrecognised is passed through untouched rather than discarded: an
 * unknown direction is still evidence, and inventing `null` for it would be a
 * worse answer than repeating what the agent said.
 */
const STATE_SPELLINGS: Record<string, string> = {
  CHECK_IN: 'IN',
  CHECKIN: 'IN',
  CHECK_OUT: 'OUT',
  CHECKOUT: 'OUT',
  BREAK_START: 'BREAK_OUT',
  BREAK_END: 'BREAK_IN',
  OVERTIME_START: 'OVERTIME_IN',
  OVERTIME_END: 'OVERTIME_OUT',
};

export function normalisePunchState(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;

  if (/^\d+$/.test(text)) {
    const named = PUNCH_STATES[Number(text)];
    return named ?? text;
  }

  const upper = text.toUpperCase().replace(/[\s-]+/g, '_');
  if (Object.values(PUNCH_STATES).includes(upper)) return upper;
  return STATE_SPELLINGS[upper] ?? text;
}

/** A reading that survived translation, plus the agent's own identity for it. */
export interface NormalisedAgentRecord extends ConnectorPunch {
  recordHash: string | null;
}

export interface AgentNormalisation {
  punches: NormalisedAgentRecord[];
  rejected: RejectedRecord[];
  /** Records dropped because an earlier record in the same batch matched. */
  duplicateHashes: number;
  /** Which key each field was actually read from, for the operator's log. */
  resolvedKeys: Record<string, string>;
}

/**
 * Translates the agent's records into the punches the existing pipeline takes.
 *
 * Exported for the same reason `toDevicePunches` is: this is where an unknown
 * dialect becomes attendance, and it must be testable without a socket, a
 * request or a live terminal.
 *
 * `recordHash` is used here only to collapse a repeat inside one batch. It is
 * deliberately not the stored identity: this server has never seen the agent's
 * hash rule, and an identity derived from a stranger's rule would be exactly as
 * reliable as that rule. The durable guarantee stays where it already was - the
 * unique index on (device, fingerprint), over content this server derived
 * itself - so a retried batch is a no-op at the database level whether or not
 * the agent's hash is stable.
 */
export function normaliseAgentRecords(
  records: readonly Record<string, unknown>[],
  deviceTimeZone: string,
): AgentNormalisation {
  const punches: NormalisedAgentRecord[] = [];
  const rejected: RejectedRecord[] = [];
  const resolvedKeys: Record<string, string> = {};
  const seenHashes = new Set<string>();
  let duplicateHashes = 0;

  for (const record of records) {
    const user = pick(record, AGENT_ALIASES.deviceUserId);
    const stamp = pick(record, AGENT_ALIASES.rawTimestamp);
    if (user) resolvedKeys.deviceUserId ??= user.key;
    if (stamp) resolvedKeys.rawTimestamp ??= stamp.key;

    const deviceUserId = user ? asText(user.value) : null;
    if (!deviceUserId) {
      rejected.push({
        deviceUserId: null,
        rawTimestamp: stamp ? asText(stamp.value) : null,
        reason: 'The record carries no field this server recognises as the enrolled PIN.',
        // The agent will send the same field names next time.
        permanent: true,
      });
      continue;
    }

    const rawTimestamp = stamp ? toWallClock(stamp.value, deviceTimeZone) : null;
    if (!rawTimestamp) {
      rejected.push({
        deviceUserId,
        rawTimestamp: stamp ? asText(stamp.value) : null,
        reason: stamp
          ? 'The timestamp is in a form this server cannot read.'
          : 'The record carries no field this server recognises as a timestamp.',
        permanent: true,
      });
      continue;
    }

    const state = pick(record, AGENT_ALIASES.punchState);
    const verify = pick(record, AGENT_ALIASES.verifyMode);
    const txn = pick(record, AGENT_ALIASES.deviceTransactionId);
    const hash = pick(record, AGENT_ALIASES.recordHash);
    if (state) resolvedKeys.punchState ??= state.key;
    if (verify) resolvedKeys.verifyMode ??= verify.key;
    if (txn) resolvedKeys.deviceTransactionId ??= txn.key;
    if (hash) resolvedKeys.recordHash ??= hash.key;

    const recordHash = hash ? asText(hash.value) : null;
    if (recordHash) {
      if (seenHashes.has(recordHash)) {
        duplicateHashes += 1;
        continue;
      }
      seenHashes.add(recordHash);
    }

    punches.push({
      deviceUserId,
      rawTimestamp,
      punchState: state ? normalisePunchState(state.value) : null,
      verifyMode: verify ? asText(verify.value) : null,
      deviceTransactionId: txn ? asText(txn.value) : null,
      recordHash,
    });
  }

  return { punches, rejected, duplicateHashes, resolvedKeys };
}

/**
 * What may be written to the log about a batch.
 *
 * Field names, counts and the *shape* of a timestamp - every digit replaced by
 * `N` - and nothing else. It is enough to tell an operator which dialect
 * arrived and whether this server read it correctly, and it puts no punch time,
 * no PIN and no credential into a log file.
 */
export function describeAgentBatch(records: readonly Record<string, unknown>[]): {
  recordKeys: string[];
  timestampShape: string | null;
} {
  const first = records[0];
  if (!first) return { recordKeys: [], timestampShape: null };

  const stamp = pick(first, AGENT_ALIASES.rawTimestamp);
  const text = stamp ? asText(stamp.value) : null;

  return {
    recordKeys: Object.keys(first).slice(0, 40),
    timestampShape: text ? text.replace(/\d/g, 'N').slice(0, 40) : null,
  };
}

/** The envelope, read from an agent whose exact dialect is not known. */
export interface AgentEnvelope {
  source: string | null;
  deviceSerial: string | null;
  deviceId: string | null;
  batchId: string | null;
  sentAt: string | null;
  connectorVersion: string | null;
  deviceTime: string | null;
  records: Record<string, unknown>[];
  /** Entries in the records array that were not objects at all. */
  malformed: number;
}

const ENVELOPE_ALIASES = {
  source: ['source', 'agent', 'client'],
  deviceSerial: ['deviceSerial', 'serialNumber', 'serial', 'deviceSN', 'sn'],
  deviceId: ['deviceId', 'device', 'terminalId'],
  batchId: ['batchId', 'batch', 'uploadId'],
  sentAt: ['sentAt', 'sent', 'timestamp', 'uploadedAt'],
  connectorVersion: ['connectorVersion', 'version', 'agentVersion'],
  deviceTime: ['deviceTime', 'terminalTime', 'deviceClock'],
  records: ['records', 'punches', 'logs', 'entries', 'attendance', 'data'],
} as const;

/** Long enough for any honest value, short enough that a log line stays a log line. */
function clamp(value: unknown, max: number): string | null {
  const text = asText(value);
  return text === null ? null : text.slice(0, max);
}

/**
 * Reads the agent's envelope without being strict about it.
 *
 * Strictness here would be the wrong tool. A schema that rejects returns 4xx,
 * and a 4xx to an agent holding a month of attendance invites it to conclude
 * the records are unacceptable and drop them - which is the one outcome this
 * whole endpoint exists to avoid. So the envelope is read for what it contains
 * rather than checked against a shape this server guessed at, and the only
 * thing that can fail is a body that is not a JSON object at all.
 *
 * The decisions that matter - is this caller who it claims to be, and are its
 * records wanted yet - are made afterwards by the token and the gate, both of
 * which are strict.
 */
export function readAgentEnvelope(body: unknown): AgentEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError({ body: ['Expected a JSON object.'] });
  }
  const raw = body as Record<string, unknown>;

  const found = pick(raw, ENVELOPE_ALIASES.records);
  const list = Array.isArray(found?.value) ? (found.value as unknown[]) : [];
  const records: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const entry of list.slice(0, AGENT_MAX_RECORDS)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      records.push(entry as Record<string, unknown>);
    } else {
      malformed += 1;
    }
  }

  const read = (names: readonly string[], max: number) => clamp(pick(raw, names)?.value, max);

  return {
    source: read(ENVELOPE_ALIASES.source, 64),
    deviceSerial: read(ENVELOPE_ALIASES.deviceSerial, 64),
    deviceId: read(ENVELOPE_ALIASES.deviceId, 64),
    batchId: read(ENVELOPE_ALIASES.batchId, 128),
    sentAt: read(ENVELOPE_ALIASES.sentAt, 64),
    connectorVersion: read(ENVELOPE_ALIASES.connectorVersion, 32),
    deviceTime: read(ENVELOPE_ALIASES.deviceTime, 64),
    records,
    malformed,
  };
}

/**
 * The top-level shape of a body, for the log.
 *
 * Key names and value types only. It is what turns "the agent sends something
 * this server does not understand" into a specific, fixable statement, and it
 * puts no value into a log file - the credential arrives in a header and is
 * never read here at all.
 */
export function describeAgentEnvelope(body: unknown): Record<string, string> {
  if (typeof body !== 'object' || body === null) return { body: typeof body };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>).slice(0, 40)) {
    out[key] = Array.isArray(value) ? `array[${value.length}]` : value === null ? 'null' : typeof value;
  }
  return out;
}

/**
 * Fields whose *values* may be written to the log, and nothing else.
 *
 * A closed list, because the point of it is what it excludes. These carry small
 * enumerations - a direction, a verification method, a zone name - and seeing
 * them is the only way to know whether this server is reading an agent's `0`
 * as the same direction the agent meant by it. The PIN, the timestamp and the
 * raw record are not on the list and cannot be added by accident.
 */
const VOCABULARY_FIELDS = ['status', 'punchCode', 'verifyMode', 'verifyCode', 'source', 'deviceTimeZone'] as const;

/** Distinct values, only where there are few enough to be an enumeration. */
const VOCABULARY_MAX_DISTINCT = 8;
const VOCABULARY_MAX_LENGTH = 24;

/**
 * The small vocabularies an agent uses, so a code can be read rather than
 * assumed.
 *
 * A field with many distinct values is not an enumeration and is omitted
 * entirely - which is also what keeps an identifier that wandered onto the list
 * from being printed a thousand times.
 */
export function describeAgentVocabulary(
  records: readonly Record<string, unknown>[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of VOCABULARY_FIELDS) {
    const seen = new Set<string>();
    let usable = true;
    for (const record of records) {
      const text = asText(record[field]);
      if (text === null) continue;
      if (text.length > VOCABULARY_MAX_LENGTH) { usable = false; break; }
      seen.add(text);
      if (seen.size > VOCABULARY_MAX_DISTINCT) { usable = false; break; }
    }
    if (usable && seen.size > 0) out[field] = [...seen].sort();
  }
  return out;
}

/**
 * The zone the agent believes the terminal is in, where every record agrees.
 *
 * Reported so a disagreement with the zone configured on the Devices page is
 * visible before it becomes five hours of wrongly dated attendance. Never
 * applied: the HRMS holds the authoritative zone, and a reading is placed in
 * time by configuration an administrator can see and change, not by a string
 * in a payload.
 */
export function agentReportedZone(records: readonly Record<string, unknown>[]): string | null {
  const zones = new Set<string>();
  for (const record of records) {
    const text = asText(record.deviceTimeZone);
    if (text) zones.add(text);
    if (zones.size > 1) return null;
  }
  return zones.size === 1 ? [...zones][0]! : null;
}

/**
 * The PINs in a batch, with how many readings each one accounts for.
 *
 * A PIN is the number typed into a terminal, not a person - the HRMS holds no
 * mapping for any of these yet, which is exactly why somebody needs to see the
 * list before deciding whose attendance they are. It is reported for that
 * decision and for no other reason.
 *
 * Only ever describes the batch in hand. An agent that is being held re-offers
 * the same records on every retry, so this counts the head of its queue and
 * cannot see past it: what is not offered is not here.
 */
export function describeAgentPins(
  records: readonly Record<string, unknown>[],
): { pin: string; punches: number }[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const found = pick(record, AGENT_ALIASES.deviceUserId);
    const pin = found ? asText(found.value) : null;
    if (pin === null) continue;
    counts.set(pin, (counts.get(pin) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pin, punches]) => ({ pin, punches }))
    .sort((a, b) => (b.punches - a.punches) || a.pin.localeCompare(b.pin));
}

/**
 * The span a batch covers, and a fingerprint of which records it holds.
 *
 * The fingerprint is what distinguishes "the agent retried the same 200
 * readings" from "the agent moved on", which is not otherwise visible from
 * outside: a new batch id accompanies every attempt whether or not the contents
 * changed.
 */
export function describeAgentSpan(
  records: readonly Record<string, unknown>[],
  deviceTimeZone: string,
): { from: string | null; to: string | null; digest: string } {
  const stamps: string[] = [];
  const hashes: string[] = [];
  for (const record of records) {
    const stamp = pick(record, AGENT_ALIASES.rawTimestamp);
    const wall = stamp ? toWallClock(stamp.value, deviceTimeZone) : null;
    if (wall) stamps.push(wall);
    const hash = pick(record, AGENT_ALIASES.recordHash);
    const text = hash ? asText(hash.value) : null;
    if (text) hashes.push(text);
  }
  stamps.sort();
  const digest = createHash('sha256').update(hashes.sort().join('|')).digest('hex').slice(0, 12);
  return { from: stamps[0] ?? null, to: stamps[stamps.length - 1] ?? null, digest };
}

/**
 * Whether this server will store what the named terminal sends to `/connector`.
 *
 * An allow-list, and empty by default, so the failure mode of a forgotten
 * setting is that records stay on the agent rather than that a backlog lands
 * unannounced. Releasing a terminal is an explicit act: its serial is added to
 * `CONNECTOR_INGEST_LIVE_SERIALS` and the API is restarted. Nothing else in
 * this file can turn ingest on.
 *
 * The older routes - `/connector/punches` and `/connector/roster` - are not
 * gated. They are the contract this project published and an agent built
 * against them is already trusted; the gate exists for the dialect this server
 * has only just learned to read.
 */
export function connectorIngestIsLive(serialNumber: string | null): boolean {
  const allowed = (env.CONNECTOR_INGEST_LIVE_SERIALS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (allowed.length === 0) return false;
  const serial = serialNumber?.trim().toLowerCase();
  if (!serial) return false;
  return allowed.includes(serial);
}
