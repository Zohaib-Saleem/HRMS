import { instantInZone } from '../../core/zoned-time.js';
import {
  toReadings,
  withSession,
  type AttendanceDeviceAdapter,
  type ConnectionTestResult,
  type DeviceConnection,
  type DeviceInfo,
  type DevicePunch,
  type DeviceUser,
  type ZkAttendanceRecord,
} from '@hrms/zkteco';

/**
 * ZKTeco standalone terminals over TCP, as the HRMS uses them.
 *
 * The protocol itself - framing, sessions, the packed time format, the record
 * layouts - lives in `@hrms/zkteco`, because the on-site connector speaks the
 * same protocol and a second copy of that decoder would eventually disagree
 * with this one about a byte.
 *
 * What remains here is the only part that is the HRMS's business: applying the
 * device timezone. A terminal reports wall-clock readings with no offset, and
 * the zone this server holds is the one thing that turns those digits into a
 * point on the timeline.
 */

export class ZkTecoAdapter implements AttendanceDeviceAdapter {
  readonly protocol = 'ZKTECO_TCP';

  async testConnection(connection: DeviceConnection): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const info = await this.getDeviceInfo(connection);
      return { reachable: true, latencyMs: Date.now() - startedAt, info, error: null };
    } catch (error) {
      return {
        reachable: false,
        latencyMs: null,
        info: null,
        error: error instanceof Error ? error.message : 'The device could not be reached.',
      };
    }
  }

  async getDeviceInfo(connection: DeviceConnection): Promise<DeviceInfo> {
    return withSession(connection, async (session) => {
      const [serialNumber, deviceName, firmwareVersion, platform, users, transactions] =
        await Promise.all([
          session.readOption('~SerialNumber'),
          session.readOption('~DeviceName'),
          session.readOption('~ZKFPVersion'),
          session.readOption('~Platform'),
          session.readOption('UserCount'),
          session.readOption('AttLogCount'),
        ]);

      return {
        serialNumber,
        deviceName,
        firmwareVersion,
        platform,
        deviceTime: null,
        userCount: users ? Number(users) || null : null,
        transactionCount: transactions ? Number(transactions) || null : null,
      };
    });
  }

  async getDeviceTime(connection: DeviceConnection): Promise<Date | null> {
    return withSession(connection, async (session) => {
      const raw = await session.readOption('~Time');
      return raw ? new Date(raw) : null;
    });
  }

  async getUsers(connection: DeviceConnection): Promise<DeviceUser[]> {
    return withSession(connection, async (session) => {
      const users = await session.readUsers();
      return users.map((user) => ({
        deviceUserId: user.deviceUserId,
        name: user.name || null,
        privilege: user.privilege,
        cardNumber: user.cardNumber,
      }));
    });
  }

  async getAttendance(
    connection: DeviceConnection,
    options?: { since?: Date | null },
  ): Promise<DevicePunch[]> {
    const records = await withSession(connection, (session) => session.readAttendance());
    return toPunches(records, connection.timeZone, options?.since ?? null);
  }
}

/**
 * Turns device records into punches, applying the device zone.
 *
 * Exported because this is where a wrong timezone becomes a wrong attendance
 * day, and that deserves to be testable without a socket.
 */
export function toPunches(
  records: readonly ZkAttendanceRecord[],
  deviceTimeZone: string,
  since: Date | null,
): DevicePunch[] {
  const punches: DevicePunch[] = [];

  // The reading itself - the PIN, the verbatim timestamp, the punch state - is
  // formatted by the shared package, so a punch polled from here and the same
  // punch relayed by a connector are identical in every field the duplicate
  // fingerprint looks at.
  for (const reading of toReadings(records)) {
    const [date, time] = reading.rawTimestamp.split(' ') as [string, string];
    const [hour, minute, second] = time.split(':').map(Number) as [number, number, number];

    // The device reports wall-clock time with no offset. Its own zone is the
    // only thing that turns that reading into a point on the timeline.
    const punchedAt = new Date(
      instantInZone(date, hour, minute, deviceTimeZone).getTime() + second * 1000,
    );

    // Filtering here, because the protocol offers no server-side date range.
    if (since && punchedAt < since) continue;

    punches.push({
      deviceUserId: reading.deviceUserId,
      deviceTransactionId: null,
      rawTimestamp: reading.rawTimestamp,
      punchedAt,
      punchState: reading.punchState,
      verifyMode: reading.verifyMode,
    });
  }

  return punches;
}
