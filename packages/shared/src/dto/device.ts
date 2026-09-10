import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/** Attendance terminals: configuration, sync history, raw punches, mapping. */

export const DEVICE_PROTOCOLS = ['ZKTECO_TCP', 'ZKTECO_ADMS', 'ZKTECO_LAN_CONNECTOR'] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];

export const DEVICE_PROTOCOL_LABELS: Record<DeviceProtocol, string> = {
  ZKTECO_TCP: 'ZKTeco (this server pulls over TCP)',
  ZKTECO_ADMS: 'ZKTeco ADMS (device pushes)',
  ZKTECO_LAN_CONNECTOR: 'ZKTeco via local connector (connector pulls on the LAN)',
};

export const DEVICE_PROTOCOL_HINTS: Record<DeviceProtocol, string> = {
  ZKTECO_TCP: 'Only works when this server can open a socket to the device address.',
  ZKTECO_ADMS: 'Only works on firmware that has a Cloud Server / ADMS setting.',
  ZKTECO_LAN_CONNECTOR:
    'For a terminal on an office LAN this server cannot reach, with no ADMS option. A small service on that LAN polls the terminal and posts what it read over HTTPS.',
};

/**
 * Whether this server ever opens a connection to the device.
 *
 * False for both of the inbound protocols, and for the same reason in both
 * cases: nothing here can reach the terminal, so a connection test, a manual
 * sync and a polling interval are all meaningless settings. The records arrive
 * on their own or not at all.
 */
export function isPushProtocol(protocol: DeviceProtocol): boolean {
  return protocol === 'ZKTECO_ADMS' || protocol === 'ZKTECO_LAN_CONNECTOR';
}

/** True when records arrive from a connector rather than from the device itself. */
export function isConnectorProtocol(protocol: DeviceProtocol): boolean {
  return protocol === 'ZKTECO_LAN_CONNECTOR';
}

export const DEVICE_STATUSES = ['UNKNOWN', 'ONLINE', 'OFFLINE', 'ERROR'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  UNKNOWN: 'Never synced',
  ONLINE: 'Connected',
  OFFLINE: 'Unreachable',
  ERROR: 'Error',
};

export const PUNCH_PAIRINGS = ['FIRST_IN_LAST_OUT', 'DEVICE_STATE'] as const;
export type PunchPairing = (typeof PUNCH_PAIRINGS)[number];

export const PUNCH_PAIRING_LABELS: Record<PunchPairing, string> = {
  FIRST_IN_LAST_OUT: 'First punch in, last punch out',
  DEVICE_STATE: 'Use the direction the device reports',
};

export const SYNC_STATUSES = ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  RUNNING: 'Running',
  SUCCESS: 'Success',
  PARTIAL: 'Partial',
  FAILED: 'Failed',
};

/** A hostname or IP. Kept permissive: LAN names vary more than RFCs suggest. */
const HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,252}[a-zA-Z0-9])?$/;

export const deviceInputSchema = z.object({
  name: z.string().trim().min(2, 'Give the device a name.').max(120),
  protocol: z.enum(DEVICE_PROTOCOLS).default('ZKTECO_TCP'),
  host: z
    .string()
    .trim()
    .min(1, 'Enter the device IP address or hostname.')
    .max(255)
    .regex(HOSTNAME, 'Enter a valid IP address or hostname.'),
  port: z.coerce.number().int().min(1).max(65535).default(4370),
  serialNumber: z.string().trim().max(64).optional().nullable(),
  /**
   * The zone the device clock is set to. Punches arrive with no offset, so an
   * incorrect value here silently shifts every imported time.
   */
  timeZone: z.string().trim().min(1, 'Choose the device timezone.').max(64),
  locationId: z.string().trim().max(64).optional().nullable(),
  isEnabled: z.boolean().default(true),
  syncIntervalMinutes: z.coerce
    .number()
    .int()
    .min(1, 'Sync at least once a minute.')
    .max(1440, 'Sync at least once a day.')
    .default(15),
  punchPairing: z.enum(PUNCH_PAIRINGS).default('FIRST_IN_LAST_OUT'),
  /**
   * Write-only. Send a value to set it, omit it to leave it alone, send null to
   * clear it. It is never returned by any endpoint.
   */
  commKey: z.string().trim().max(64).optional().nullable(),
  /**
   * Write-only, same rules as the comm key.
   *
   * A pushing device identifies itself with a serial number printed on its own
   * case, which is not a secret. This token goes in the server path the device
   * is configured with, so the endpoint needs more than a guessable label.
   */
  pushToken: z
    .union([
      z.string().trim().min(8, 'Use at least 8 characters, or leave it blank.').max(64),
      // Blank is how the form says "leave the stored token alone", and it is
      // what an untouched field submits. A minimum length that rejects it makes
      // the whole device unsaveable.
      z.literal(''),
      z.null(),
    ])
    .optional(),
  /**
   * Addresses the device may push from. Empty means anywhere, which is what a
   * terminal needs on the day it is plugged in and nobody knows its address.
   */
  allowedPushCidrs: z
    .array(z.string().trim().min(1).max(64))
    .max(20, 'Twenty entries is plenty.')
    .default([]),
});

export type DeviceInput = z.infer<typeof deviceInputSchema>;

export interface DeviceRecord {
  id: string;
  name: string;
  protocol: DeviceProtocol;
  host: string;
  port: number;
  serialNumber: string | null;
  timeZone: string;
  locationId: string | null;
  locationName: string | null;
  isEnabled: boolean;
  syncIntervalMinutes: number;
  punchPairing: PunchPairing;
  status: DeviceStatus;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastPunchAt: string | null;
  lastError: string | null;
  syncCursorAt: string | null;
  /** Whether a sync is running right now. */
  isSyncing: boolean;
  /** Whether a comm key is stored. The key itself is never sent. */
  hasCommKey: boolean;
  /** Whether a push token is stored. The token itself is never sent. */
  hasPushToken: boolean;
  allowedPushCidrs: string[];
  /** Last time the device posted anything, whether or not it carried records. */
  lastPushAt: string | null;
  /**
   * Where this device should be pointed, ready to type into its configuration
   * screen. Includes the token when one is set, because there is nowhere else
   * an administrator could get it back from.
   */
  pushUrl: string | null;
  /**
   * The base URL a local connector should be configured with, for a device on
   * the connector protocol. Never carries the token: unlike a terminal, the
   * connector can hold a secret in a config file, so there is no reason to put
   * one in a URL that gets pasted into chat windows.
   */
  connectorUrl: string | null;
  /** Version the connector last reported, so a stale one is visible. */
  connectorVersion: string | null;
  mappedUsers: number;
  createdAt: string;
}

export interface DeviceTestResult {
  reachable: boolean;
  latencyMs: number | null;
  serialNumber: string | null;
  deviceName: string | null;
  firmwareVersion: string | null;
  platform: string | null;
  userCount: number | null;
  transactionCount: number | null;
  error: string | null;
}

/** One failed transaction, kept so a partial sync can be diagnosed. */
export interface SyncErrorDetail {
  deviceUserId?: string | null;
  rawTimestamp?: string | null;
  reason: string;
  /** True when the record can never be read, so retrying would not help. */
  permanent: boolean;
}

export interface DeviceSyncRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  trigger: string;
  recordsFetched: number;
  recordsImported: number;
  duplicatesIgnored: number;
  unmappedRecords: number;
  errors: number;
  /** Connection attempts this run took, including the successful one. */
  attempts: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  error: string | null;
  errorDetails: SyncErrorDetail[];
}

/**
 * Where a punch is in the pipeline.
 *
 *   UNMAPPED   no employee yet; attribute it by fixing the mapping
 *   PENDING    attributed, not yet folded into an attendance record
 *   PROCESSED  folded into an attendance record
 */
export const PUNCH_PROCESSING_STATUSES = ['UNMAPPED', 'PENDING', 'PROCESSED'] as const;
export type PunchProcessingStatus = (typeof PUNCH_PROCESSING_STATUSES)[number];

export const PUNCH_PROCESSING_STATUS_LABELS: Record<PunchProcessingStatus, string> = {
  UNMAPPED: 'Unmapped',
  PENDING: 'Awaiting processing',
  PROCESSED: 'Processed',
};

export interface RawPunchRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceSerial: string | null;
  deviceUserId: string;
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  rawTimestamp: string;
  deviceTimeZone: string;
  punchedAt: string;
  localDayKey: string;
  punchState: string | null;
  verifyMode: string | null;
  /** How the punch reached the server: the trigger of the sync that stored it. */
  source: string | null;
  importedAt: string;
  processedAt: string | null;
  processingStatus: PunchProcessingStatus;
}

export const punchQuerySchema = paginationQuerySchema.extend({
  deviceId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
  /** `true` restricts to punches with no employee mapping. */
  unmappedOnly: z.enum(['true', 'false']).optional(),
  processing: z.enum(PUNCH_PROCESSING_STATUSES).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  /** One local day, YYYY-MM-DD, in the company zone. */
  day: z.string().trim().max(10).optional(),
});

/** A user held on the device, with its mapping if one exists. */
export interface DeviceUserRecord {
  deviceUserId: string;
  name: string | null;
  privilege: number | null;
  cardNumber: string | null;
  employeeId: string | null;
  employeeName: string | null;
  /** True when the mapped employee is no longer active. */
  employeeInactive: boolean;
  mappingId: string | null;
}

const mappingDate = z.preprocess(
  (v) => (v === '' ? null : v),
  z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date.')
    .nullable(),
);

/**
 * Attributing a device user (PunchCode / PIN) to an employee.
 *
 * `effectiveFrom` is what makes a correction safe. Left blank, the mapping
 * covers everything the PIN ever recorded. Given a date, punches before it
 * stay exactly where they were and only later ones move - which is the right
 * answer when a PIN passes from a leaver to a new joiner.
 *
 * `closeConflicting` is the explicit consent to end another employee's
 * open-ended mapping of the same PIN the day before this one starts. Without
 * it the conflict is refused and named, so nothing is taken over by accident.
 */
export const deviceMappingSchema = z.object({
  deviceUserId: z.string().trim().min(1, 'Enter the device user ID.').max(64),
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  deviceUserName: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().default(true),
  effectiveFrom: mappingDate.optional(),
  effectiveTo: mappingDate.optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  closeConflicting: z.boolean().default(false),
});

export type DeviceMappingInput = z.infer<typeof deviceMappingSchema>;

/** The same, addressed by device rather than nested under one. */
export const deviceMappingCreateSchema = deviceMappingSchema.extend({
  deviceId: z.string().trim().min(1, 'Choose a device.').max(64),
});

export type DeviceMappingCreateInput = z.infer<typeof deviceMappingCreateSchema>;

/** Editing an existing mapping. The PIN and the employee never change here: that is a new mapping. */
export const deviceMappingUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  effectiveFrom: mappingDate.optional(),
  effectiveTo: mappingDate.optional(),
  deviceUserName: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export type DeviceMappingUpdateInput = z.infer<typeof deviceMappingUpdateSchema>;

export const deviceMappingQuerySchema = z.object({
  employeeId: z.string().trim().max(64).optional(),
  deviceId: z.string().trim().max(64).optional(),
  deviceUserId: z.string().trim().max(64).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

export interface DeviceMappingRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceSerial: string | null;
  deviceUserId: string;
  deviceUserName: string | null;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notes: string | null;
  /** True when the mapping attributes punches today. */
  isCurrent: boolean;
  /** Punches this mapping's (device, PIN) recorded that are attributed to this employee. */
  punchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceMappingSetResult {
  id: string;
  /** Punches re-attributed to the employee, from the effective date onward. */
  reattributedPunches: number;
  /** Distinct employee-days those punches touch. Not recalculated here. */
  affectedDays: number;
  /** The other employee's mapping that was closed, if consent was given. */
  closedMappingId: string | null;
}

/**
 * One change to a PunchCode mapping, as the history panel shows it.
 *
 * Read from the audit log rather than a second table: mapping changes already
 * go through `recordAudit`, and a private copy would be one more thing that
 * can disagree with the trail everybody else reads.
 */
export interface DeviceMappingHistoryEntry {
  id: string;
  action: string;
  summary: string | null;
  actorName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export const deviceMappingHistoryQuerySchema = z.object({
  deviceId: z.string().trim().max(64).optional(),
  deviceUserId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface DeviceSyncOutcome {
  syncId: string;
  deviceId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  recordsFetched: number;
  recordsImported: number;
  /** A repeated transaction is ignored and counted, never an error. */
  duplicatesIgnored: number;
  unmappedRecords: number;
  errors: number;
  recalculatedDays: number;
  attempts: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  error: string | null;
}

/** Reprocessing after a mapping is added, so a fixed punch is not stranded. */
export const reprocessSchema = z.object({
  deviceId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
});

export interface ReprocessResult {
  punchesConsidered: number;
  daysRecalculated: number;
  daysSkipped: number;
  daysFailed: number;
}

// --------------------------------------------------------------- LAN connector

/**
 * What a local connector posts.
 *
 * The connector is a courier, not an interpreter. It sends the terminal's own
 * wall-clock reading verbatim and nothing derived from it - no instant, no day,
 * no timezone. The device zone is configuration held by the HRMS, so correcting
 * a mis-set zone is an edit on the Devices page rather than a visit to whatever
 * machine the connector runs on.
 */
export const connectorPunchSchema = z.object({
  /** The PIN as enrolled on the terminal. */
  deviceUserId: z.string().trim().min(1).max(64),
  /** The device reading exactly as it came off the wire: `YYYY-MM-DD HH:mm:ss`. */
  rawTimestamp: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/, 'Expected YYYY-MM-DD HH:mm:ss.'),
  /** Direction as the device reported it, already named by the adapter. */
  punchState: z.string().trim().max(64).nullish(),
  verifyMode: z.string().trim().max(64).nullish(),
  /** Only some firmware supplies one. */
  deviceTransactionId: z.string().trim().max(64).nullish(),
});

export type ConnectorPunch = z.infer<typeof connectorPunchSchema>;

/**
 * One upload.
 *
 * Bounded at a thousand records because a connector catching up after a long
 * outage must be made to send several batches rather than one enormous request:
 * a batch that is too big to finish is a batch that is retried forever.
 */
export const connectorBatchSchema = z.object({
  serialNumber: z.string().trim().min(1).max(64),
  connectorVersion: z.string().trim().max(32).nullish(),
  /** The connector's own idea of the terminal clock, for drift reporting. */
  deviceTime: z.string().trim().max(64).nullish(),
  punches: z.array(connectorPunchSchema).max(1000, 'Send at most 1000 punches per batch.'),
});

export type ConnectorBatch = z.infer<typeof connectorBatchSchema>;

/** The enrolment roster, so PINs can be mapped to people without a site visit. */
export const connectorRosterSchema = z.object({
  serialNumber: z.string().trim().min(1).max(64),
  connectorVersion: z.string().trim().max(32).nullish(),
  users: z
    .array(
      z.object({
        deviceUserId: z.string().trim().min(1).max(64),
        name: z.string().trim().max(120).nullish(),
        privilege: z.coerce.number().int().min(0).max(255).nullish(),
        cardNumber: z.string().trim().max(64).nullish(),
      }),
    )
    .max(20000, 'That is more users than any terminal holds.'),
});

export type ConnectorRoster = z.infer<typeof connectorRosterSchema>;

/**
 * What the connector learns at startup.
 *
 * Everything here is configuration the HRMS already owns. The connector holds
 * only what it cannot be told - the terminal address and its own credential -
 * so a change of polling interval or timezone does not mean editing a file on a
 * machine in another building.
 */
export interface ConnectorHandshake {
  deviceId: string;
  deviceName: string;
  serialNumber: string | null;
  /** The zone the HRMS will use to read the timestamps sent. */
  timeZone: string;
  /** How often the connector should poll the terminal. */
  pollIntervalMinutes: number;
  /**
   * The instant the HRMS has already accounted for, as a device wall-clock
   * reading in the device zone, or null when it has none.
   *
   * A hint, never an instruction. The connector keeps its own watermark; this
   * exists so a connector reinstalled on a fresh machine does not replay years
   * of history to a server that would only deduplicate it.
   */
  cursorHint: string | null;
  serverTime: string;
}

export interface ConnectorBatchResult {
  received: number;
  imported: number;
  duplicates: number;
  unmapped: number;
  errors: number;
  recalculatedDays: number;
  syncId: string | null;
  /** The watermark hint after this batch, in the same form as the handshake. */
  cursorHint: string | null;
}

export interface ConnectorRosterResult {
  received: number;
  stored: number;
  unmapped: number;
}

// ---------------------------------------------------------------------------
// The agent envelope - POST /connector
// ---------------------------------------------------------------------------

/**
 * What a field agent posts to the bare `/connector` path.
 *
 * A second shape for the same conversation, and deliberately so. The Devices
 * page advertises `<origin>/connector` as the connector's address, and an agent
 * written against that string reads it as the endpoint rather than as a prefix.
 * Both readings are reasonable; only one of them had a route. Rather than ask a
 * machine in another building to be reconfigured, the server learns the second
 * dialect and translates it into the first.
 *
 * Everything downstream is the existing path - `toDevicePunches`, then
 * `ingestConnectorBatch`. This schema's whole job is to get an unfamiliar
 * envelope as far as `ConnectorPunch` without inventing anything.
 */

/**
 * One reading, accepted loosely on purpose.
 *
 * An agent this project did not write chooses its own field names, so the
 * record is taken as an open object and the names are resolved afterwards in
 * `normaliseAgentRecords`, where a miss can be counted and reported instead of
 * failing a batch of real attendance at the schema boundary. Unknown keys are
 * kept rather than stripped: they are what tells an operator which dialect
 * arrived.
 */
export const connectorAgentRecordSchema = z.record(z.unknown());

export type ConnectorAgentRecord = z.infer<typeof connectorAgentRecordSchema>;

/**
 * Bounded well above one terminal's backlog.
 *
 * The batching policy belongs to the agent, and this server cannot change the
 * agent's mind about it. The cap exists so an unbounded array cannot be used to
 * exhaust memory, not to express a preference about batch size.
 */
export const CONNECTOR_AGENT_MAX_RECORDS = 50_000;

export const connectorAgentBatchSchema = z.object({
  /** Free-form label the agent gives itself. Recorded, never trusted. */
  source: z.string().trim().max(64).nullish(),
  /**
   * The terminal serial. `serialNumber` is accepted as an alias so the two
   * dialects cannot disagree about the one field that is also a credential.
   */
  deviceSerial: z.string().trim().min(1).max(64).nullish(),
  serialNumber: z.string().trim().min(1).max(64).nullish(),
  /**
   * Whatever identifier the agent holds for the device.
   *
   * Never used to select the device: the serial does that, and it is the half
   * of the credential the agent read off the terminal itself. Kept only so a
   * mismatch can be logged.
   */
  deviceId: z.string().trim().max(64).nullish(),
  /** The agent's identifier for this upload, used to make a retry legible. */
  batchId: z.string().trim().max(128).nullish(),
  sentAt: z.string().trim().max(64).nullish(),
  connectorVersion: z.string().trim().max(32).nullish(),
  /** The agent's idea of the terminal clock, where it sends one. */
  deviceTime: z.string().trim().max(64).nullish(),
  records: z
    .array(connectorAgentRecordSchema)
    .max(CONNECTOR_AGENT_MAX_RECORDS, 'That is more records than any terminal holds.'),
});

export type ConnectorAgentBatch = z.infer<typeof connectorAgentBatchSchema>;

/**
 * The answer to an agent whose records this server is not yet accepting.
 *
 * Sent with 503, which is the only honest status: the endpoint exists, the
 * caller is who it says it is, and the records are good - the server is simply
 * not taking them yet. A 200 would be the dangerous reply, because an agent
 * that reads success advances its cursor and discards what it holds.
 */
export interface ConnectorAgentHeldResult {
  accepted: false;
  held: true;
  batchId: string | null;
  /** How many records were read and understood, none of which were stored. */
  received: number;
  readable: number;
  unreadable: number;
  retryAfterSeconds: number;
  message: string;
}

export interface ConnectorAgentBatchResult extends ConnectorBatchResult {
  accepted: true;
  held: false;
  batchId: string | null;
}
