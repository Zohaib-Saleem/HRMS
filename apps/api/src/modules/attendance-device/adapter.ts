/**
 * What the HRMS needs from an attendance terminal, regardless of who made it.
 *
 * Nothing above this interface knows about ZKTeco. Sync orchestration, employee
 * mapping and the attendance import all talk to these shapes, so adding a
 * second brand later is a new file rather than a change to any of them.
 *
 * The interface is deliberately read-only. Pulling transactions off a terminal
 * is safe and repeatable; pushing enrolments or commands back is not, and the
 * moment an adapter can do it, a bug in the HRMS becomes a bug in the door.
 */

export interface DeviceConnection {
  host: string;
  port: number;
  /** The zone the device clock is set to, used to place its readings in time. */
  timeZone: string;
  /** Decrypted comm key, or null when the device is not protected by one. */
  commKey: string | null;
  timeoutMs: number;
}

export interface DeviceInfo {
  serialNumber: string | null;
  deviceName: string | null;
  firmwareVersion: string | null;
  platform: string | null;
  /** The device's own clock, as it reports it. */
  deviceTime: Date | null;
  userCount: number | null;
  transactionCount: number | null;
}

/** One transaction, still in the device's terms. */
export interface DevicePunch {
  deviceUserId: string;
  /** Only some firmware supplies one; null is normal and handled downstream. */
  deviceTransactionId: string | null;
  /** The device's own reading, preserved verbatim as `YYYY-MM-DD HH:mm:ss`. */
  rawTimestamp: string;
  /** The instant, once the device zone has been applied. */
  punchedAt: Date;
  /** Direction as the device reported it, or null when it reports none. */
  punchState: string | null;
  verifyMode: string | null;
}

export interface DeviceUser {
  deviceUserId: string;
  name: string | null;
  privilege: number | null;
  cardNumber: string | null;
}

export interface ConnectionTestResult {
  reachable: boolean;
  /** Round trip in milliseconds, when the device answered. */
  latencyMs: number | null;
  info: DeviceInfo | null;
  /** Present when the device could not be reached or refused the connection. */
  error: string | null;
}

export interface AttendanceDeviceAdapter {
  readonly protocol: string;
  testConnection(connection: DeviceConnection): Promise<ConnectionTestResult>;
  getDeviceInfo(connection: DeviceConnection): Promise<DeviceInfo>;
  getUsers(connection: DeviceConnection): Promise<DeviceUser[]>;
  /**
   * Transactions at or after `since`.
   *
   * The filter is applied here rather than on the device: the ZKTeco protocol
   * has no server-side date range, so the terminal returns its whole log and
   * the adapter narrows it. That is why the sync cursor exists in the database
   * and not on the device.
   */
  getAttendance(
    connection: DeviceConnection,
    options?: { since?: Date | null },
  ): Promise<DevicePunch[]>;
  getDeviceTime(connection: DeviceConnection): Promise<Date | null>;
}

/** Raised when a device cannot be reached, so callers can tell it apart. */
export class DeviceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceUnreachableError';
  }
}

/** Raised when the device answers but rejects us. */
export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceAuthError';
  }
}
