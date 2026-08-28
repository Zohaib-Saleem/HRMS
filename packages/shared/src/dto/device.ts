import { z } from 'zod';
import { paginationQuerySchema } from './common.js';

/** Attendance terminals: configuration, sync history, raw punches, mapping. */

export const DEVICE_PROTOCOLS = ['ZKTECO_TCP', 'ZKTECO_ADMS'] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];

export const DEVICE_PROTOCOL_LABELS: Record<DeviceProtocol, string> = {
  ZKTECO_TCP: 'ZKTeco (pull over TCP)',
  ZKTECO_ADMS: 'ZKTeco ADMS (device pushes)',
};

/** A pushing device is never polled, so half the settings do not apply to it. */
export function isPushProtocol(protocol: DeviceProtocol): boolean {
  return protocol === 'ZKTECO_ADMS';
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

export interface RawPunchRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceUserId: string;
  employeeId: string | null;
  employeeName: string | null;
  rawTimestamp: string;
  deviceTimeZone: string;
  punchedAt: string;
  localDayKey: string;
  punchState: string | null;
  verifyMode: string | null;
  importedAt: string;
  processedAt: string | null;
}

export const punchQuerySchema = paginationQuerySchema.extend({
  deviceId: z.string().trim().max(64).optional(),
  employeeId: z.string().trim().max(64).optional(),
  /** `true` restricts to punches with no employee mapping. */
  unmappedOnly: z.enum(['true', 'false']).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
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

export const deviceMappingSchema = z.object({
  deviceUserId: z.string().trim().min(1, 'Enter the device user ID.').max(64),
  employeeId: z.string().trim().min(1, 'Choose an employee.').max(64),
  deviceUserName: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().default(true),
});

export type DeviceMappingInput = z.infer<typeof deviceMappingSchema>;

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
