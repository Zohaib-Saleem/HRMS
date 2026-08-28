import { Socket } from 'node:net';
import { instantInZone } from '../../core/zoned-time.js';
import {
  DeviceAuthError,
  DeviceUnreachableError,
  type AttendanceDeviceAdapter,
  type ConnectionTestResult,
  type DeviceConnection,
  type DeviceInfo,
  type DevicePunch,
  type DeviceUser,
} from './adapter.js';
import {
  ZK_COMMANDS,
  decodeAttendance,
  decodeFrame,
  decodeUsers,
  encodePacket,
  makeAuthKey,
  type ZkAttendanceRecord,
} from './zkteco.protocol.js';

/**
 * ZKTeco standalone terminals over TCP.
 *
 * A session is: connect, authenticate if the device demands it, quiesce the
 * device, read, then always re-enable and exit. The re-enable matters - a
 * terminal left disabled because a sync threw is a terminal nobody can clock in
 * on, which is a far worse failure than a missed sync.
 *
 * Everything here is about moving bytes. No attendance rule is applied and no
 * employee is resolved; that happens further up, so this file can be wrong
 * about a person only by being wrong about a byte.
 */

/** Punch byte meanings that are stable across the firmware we target. */
const PUNCH_STATES: Record<number, string> = {
  0: 'IN',
  1: 'OUT',
  2: 'BREAK_OUT',
  3: 'BREAK_IN',
  4: 'OVERTIME_IN',
  5: 'OVERTIME_OUT',
};

const VERIFY_MODES: Record<number, string> = {
  0: 'PASSWORD',
  1: 'FINGERPRINT',
  2: 'CARD',
  15: 'FACE',
};

const two = (n: number) => String(n).padStart(2, '0');

class ZkSession {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private sessionId = 0;
  private replyId = 0;
  private waiter: ((packet: ReturnType<typeof decodeFrame>) => void) | null = null;
  /**
   * One socket, one conversation.
   *
   * The protocol is strictly request then response with no correlation id, so
   * two commands in flight at once cannot be told apart - the second reply
   * would be handed to whichever caller happened to be waiting. Every command
   * queues behind the last, which is why callers may fan out freely without
   * knowing this.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DeviceConnection) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Keep the chain alive after a rejection so one failed command does not
    // wedge every command after it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async open(): Promise<void> {
    await this.connect();

    const reply = await this.send(ZK_COMMANDS.CONNECT, Buffer.alloc(0), { sessionId: 0 });
    this.sessionId = reply.sessionId;

    if (reply.command === ZK_COMMANDS.ACK_UNAUTH) {
      if (!this.connection.commKey) {
        throw new DeviceAuthError(
          'The device requires a comm key and none is configured for it.',
        );
      }
      const key = Number(this.connection.commKey);
      if (!Number.isFinite(key)) {
        throw new DeviceAuthError('The comm key must be the numeric key set on the device.');
      }
      const auth = await this.send(ZK_COMMANDS.AUTH, makeAuthKey(key, this.sessionId));
      if (auth.command !== ZK_COMMANDS.ACK_OK) {
        throw new DeviceAuthError('The device rejected the comm key.');
      }
    } else if (reply.command !== ZK_COMMANDS.ACK_OK) {
      throw new DeviceUnreachableError(
        `The device answered with an unexpected code (${reply.command}).`,
      );
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.setTimeout(this.connection.timeoutMs);

      const fail = (message: string) => {
        socket.destroy();
        reject(new DeviceUnreachableError(message));
      };

      socket.once('error', (error: NodeJS.ErrnoException) => {
        const reason =
          error.code === 'ECONNREFUSED'
            ? 'the device refused the connection'
            : error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH'
              ? 'the device is not reachable on the network'
              : error.code === 'ETIMEDOUT'
                ? 'the device did not answer in time'
                : error.message;
        fail(`Could not reach ${this.connection.host}:${this.connection.port} - ${reason}.`);
      });
      socket.once('timeout', () =>
        fail(`${this.connection.host}:${this.connection.port} did not answer in time.`),
      );

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });

      socket.connect(this.connection.port, this.connection.host, () => {
        socket.setTimeout(this.connection.timeoutMs);
        resolve();
      });
    });
  }

  private drain(): void {
    while (this.waiter) {
      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(this.buffer);
      } catch {
        // Unparseable bytes are not recoverable on a stream; drop what we have
        // rather than looping on the same rubbish forever.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (!frame) return;

      this.buffer = this.buffer.subarray(frame.consumed);
      const waiter = this.waiter;
      this.waiter = null;
      waiter(frame);
    }
  }

  private send(
    command: number,
    data: Buffer,
    options?: { sessionId?: number },
  ): Promise<{ command: number; sessionId: number; data: Buffer }> {
    return this.serialize(() => this.sendNow(command, data, options));
  }

  private sendNow(
    command: number,
    data: Buffer,
    options?: { sessionId?: number },
  ): Promise<{ command: number; sessionId: number; data: Buffer }> {
    const socket = this.socket;
    if (!socket) throw new DeviceUnreachableError('The connection is not open.');

    this.replyId = (this.replyId + 1) & 0xffff;
    const packet = encodePacket({
      command,
      sessionId: options?.sessionId ?? this.sessionId,
      replyId: this.replyId,
      data,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new DeviceUnreachableError('The device stopped responding mid-conversation.'));
      }, this.connection.timeoutMs);

      this.waiter = (frame) => {
        clearTimeout(timer);
        if (!frame) {
          reject(new DeviceUnreachableError('The device closed the connection.'));
          return;
        }
        resolve({
          command: frame.packet.command,
          sessionId: frame.packet.sessionId,
          data: frame.packet.data,
        });
      };

      socket.write(packet, (error) => {
        if (error) {
          clearTimeout(timer);
          this.waiter = null;
          reject(new DeviceUnreachableError(`Could not write to the device: ${error.message}`));
        }
      });

      // Bytes may already be buffered from a previous read.
      this.drain();
    });
  }

  /**
   * Issues a command that may answer with a bulk transfer.
   *
   * Small results come back inline as ACK_DATA. Larger ones are announced with
   * PREPARE_DATA carrying the total size, then streamed as DATA packets until
   * that many bytes have arrived.
   */
  private readBulk(command: number): Promise<Buffer> {
    return this.serialize(() => this.readBulkNow(command));
  }

  private async readBulkNow(command: number): Promise<Buffer> {
    const first = await this.sendNow(command, Buffer.alloc(0));

    if (first.command === ZK_COMMANDS.ACK_DATA || first.command === ZK_COMMANDS.ACK_OK) {
      return first.data;
    }

    if (first.command !== ZK_COMMANDS.PREPARE_DATA) {
      throw new DeviceUnreachableError(
        `The device refused to send data (code ${first.command}).`,
      );
    }

    const expected = first.data.length >= 4 ? first.data.readUInt32LE(0) : 0;
    const chunks: Buffer[] = [];
    let received = 0;

    while (received < expected) {
      const next = await this.awaitPacket();
      if (next.command === ZK_COMMANDS.ACK_OK) break;
      if (next.command !== ZK_COMMANDS.DATA) break;
      chunks.push(next.data);
      received += next.data.length;
    }

    return Buffer.concat(chunks);
  }

  /** Waits for a packet the device sends unprompted, mid-transfer. */
  private awaitPacket(): Promise<{ command: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new DeviceUnreachableError('The device stopped part-way through a transfer.'));
      }, this.connection.timeoutMs);

      this.waiter = (frame) => {
        clearTimeout(timer);
        if (!frame) {
          reject(new DeviceUnreachableError('The device closed the connection mid-transfer.'));
          return;
        }
        resolve({ command: frame.packet.command, data: frame.packet.data });
      };
      this.drain();
    });
  }

  async readOption(name: string): Promise<string | null> {
    const reply = await this.send(ZK_COMMANDS.OPTIONS_RRQ, Buffer.from(`${name}\0`, 'ascii'));
    if (reply.command !== ZK_COMMANDS.ACK_OK) return null;
    const text = reply.data.toString('ascii').replace(/\0.*$/, '').trim();
    const equals = text.indexOf('=');
    return equals === -1 ? text || null : text.slice(equals + 1).trim() || null;
  }

  async readAttendance(): Promise<ZkAttendanceRecord[]> {
    return decodeAttendance(await this.readBulk(ZK_COMMANDS.ATTLOG_RRQ));
  }

  async readUsers(): Promise<ReturnType<typeof decodeUsers>> {
    return decodeUsers(await this.readBulk(ZK_COMMANDS.USERTEMP_RRQ));
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.send(enabled ? ZK_COMMANDS.ENABLE_DEVICE : ZK_COMMANDS.DISABLE_DEVICE, Buffer.alloc(0));
  }

  async close(): Promise<void> {
    try {
      if (this.socket && !this.socket.destroyed) {
        await this.send(ZK_COMMANDS.EXIT, Buffer.alloc(0)).catch(() => undefined);
      }
    } finally {
      this.socket?.destroy();
      this.socket = null;
    }
  }
}

/** Runs a block against an open session, always closing and re-enabling. */
async function withSession<T>(
  connection: DeviceConnection,
  run: (session: ZkSession) => Promise<T>,
): Promise<T> {
  const session = new ZkSession(connection);
  await session.open();

  let quiesced = false;
  try {
    // Stops the terminal writing to its log while we read it.
    await session.setEnabled(false);
    quiesced = true;
    return await run(session);
  } finally {
    // The terminal must never be left disabled because we failed.
    if (quiesced) await session.setEnabled(true).catch(() => undefined);
    await session.close();
  }
}

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

  for (const record of records) {
    const { year, month, day, hour, minute, second } = record.clock;
    const rawTimestamp = `${year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:${two(second)}`;

    // The device reports wall-clock time with no offset. Its own zone is the
    // only thing that turns that reading into a point on the timeline.
    const punchedAt = new Date(
      instantInZone(`${year}-${two(month)}-${two(day)}`, hour, minute, deviceTimeZone).getTime() +
        second * 1000,
    );

    // Filtering here, because the protocol offers no server-side date range.
    if (since && punchedAt < since) continue;

    punches.push({
      deviceUserId: record.deviceUserId,
      deviceTransactionId: null,
      rawTimestamp,
      punchedAt,
      punchState: PUNCH_STATES[record.punch] ?? null,
      verifyMode: VERIFY_MODES[record.status] ?? null,
    });
  }

  return punches;
}
