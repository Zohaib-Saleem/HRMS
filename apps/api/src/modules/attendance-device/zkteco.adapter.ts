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

/**
 * One conversation with a terminal.
 *
 * The reliability rules this class exists to enforce:
 *
 *   - A socket failure at any point resolves the request that was waiting for
 *     it. Node throws an uncaught exception for an `error` event with no
 *     listener, so handlers stay attached for the whole life of the socket
 *     rather than only during connect - a terminal rebooting mid-read would
 *     otherwise take the API process down with it.
 *   - Unreadable bytes fail immediately and say so, instead of leaving the
 *     caller to discover it as a timeout ten seconds later.
 *   - A bulk transfer that stops early is an error, not a short answer. A
 *     truncated attendance log silently treated as complete is how a day of
 *     punches goes missing.
 */
class ZkSession {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private sessionId = 0;
  private replyId = 0;

  /** Set once the socket is unusable; every later call fails with this. */
  private dead: Error | null = null;
  /** True once we are shutting down on purpose, so close is not an error. */
  private closing = false;

  private pending: {
    resolve: (packet: { command: number; sessionId: number; data: Buffer }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  /**
   * One socket, one conversation.
   *
   * The protocol is strictly request then response with no correlation id, so
   * two commands in flight at once cannot be told apart. Every command queues
   * behind the last, which is why callers may fan out freely.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DeviceConnection) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Keep the chain alive after a rejection so one failed command does not
    // wedge every command behind it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Fails whatever is waiting, and marks the session unusable. */
  private failSession(error: Error): void {
    this.dead ??= error;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private describe(error: NodeJS.ErrnoException): DeviceUnreachableError {
    const where = `${this.connection.host}:${this.connection.port}`;
    const reason =
      error.code === 'ECONNREFUSED'
        ? 'the device refused the connection'
        : error.code === 'ECONNRESET'
          ? 'the device reset the connection'
          : error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH'
            ? 'the device is not reachable on the network'
            : error.code === 'ETIMEDOUT'
              ? 'the device did not answer in time'
              : error.code === 'EPIPE'
                ? 'the connection closed while writing'
                : (error.message ?? 'the connection failed');
    return new DeviceUnreachableError(`Could not reach ${where} - ${reason}.`);
  }

  async open(): Promise<void> {
    await this.connect();

    const reply = await this.send(ZK_COMMANDS.CONNECT, Buffer.alloc(0), { sessionId: 0 });
    this.sessionId = reply.sessionId;

    if (reply.command === ZK_COMMANDS.ACK_UNAUTH) {
      if (!this.connection.commKey) {
        throw new DeviceAuthError('The device requires a comm key and none is configured for it.');
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

      let settled = false;
      const settleConnect = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      // Attached for the life of the socket, not just for connect. An error
      // with no listener is an uncaught exception, and a terminal that reboots
      // mid-sync must not be able to stop the server.
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const failure = this.describe(error);
        this.failSession(failure);
        socket.destroy();
        settleConnect(failure);
      });

      socket.on('timeout', () => {
        const failure = new DeviceUnreachableError(
          `${this.connection.host}:${this.connection.port} stopped responding.`,
        );
        this.failSession(failure);
        socket.destroy();
        settleConnect(failure);
      });

      socket.on('close', () => {
        if (this.closing) return;
        const failure = new DeviceUnreachableError(
          'The device closed the connection unexpectedly.',
        );
        this.failSession(failure);
        settleConnect(failure);
      });

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });

      socket.connect(this.connection.port, this.connection.host, () => settleConnect());
    });
  }

  /**
   * Hands complete packets to whoever is waiting.
   *
   * Bytes that cannot be framed are fatal for the connection: a stream has no
   * way to resynchronise, so continuing would mean guessing where the next
   * packet starts.
   */
  private drain(): void {
    while (this.pending) {
      let frame: ReturnType<typeof decodeFrame>;
      try {
        frame = decodeFrame(this.buffer);
      } catch {
        this.buffer = Buffer.alloc(0);
        const failure = new DeviceUnreachableError(
          'The device sent data this protocol could not read; the connection was dropped.',
        );
        this.failSession(failure);
        this.socket?.destroy();
        return;
      }
      if (!frame) return;

      this.buffer = this.buffer.subarray(frame.consumed);
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve({
        command: frame.packet.command,
        sessionId: frame.packet.sessionId,
        data: frame.packet.data,
      });
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
    if (this.dead) return Promise.reject(this.dead);

    const socket = this.socket;
    if (!socket) return Promise.reject(new DeviceUnreachableError('The connection is not open.'));

    this.replyId = (this.replyId + 1) & 0xffff;
    const packet = encodePacket({
      command,
      sessionId: options?.sessionId ?? this.sessionId,
      replyId: this.replyId,
      data,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new DeviceUnreachableError('The device stopped responding mid-conversation.'));
      }, this.connection.timeoutMs);

      this.pending = { resolve, reject, timer };

      socket.write(packet, (error) => {
        if (error) this.failSession(new DeviceUnreachableError(`Could not write to the device: ${error.message}`));
      });

      // Bytes may already be buffered from an earlier read.
      this.drain();
    });
  }

  /** Waits for a packet the device sends unprompted, mid-transfer. */
  private awaitPacket(): Promise<{ command: number; data: Buffer }> {
    if (this.dead) return Promise.reject(this.dead);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new DeviceUnreachableError('The device stopped part-way through a transfer.'));
      }, this.connection.timeoutMs);

      this.pending = { resolve, reject, timer };
      this.drain();
    });
  }

  private readBulk(command: number): Promise<Buffer> {
    return this.serialize(() => this.readBulkNow(command));
  }

  /**
   * Issues a command that may answer with a bulk transfer.
   *
   * Small results arrive inline as ACK_DATA. Larger ones are announced with
   * PREPARE_DATA carrying the total size, then streamed as DATA packets.
   *
   * A transfer that ends before that many bytes have arrived is reported
   * rather than returned. Half an attendance log looks exactly like a complete
   * one to everything downstream, and would be recorded as a successful sync
   * of fewer records - quietly losing the rest.
   */
  private async readBulkNow(command: number): Promise<Buffer> {
    const first = await this.sendNow(command, Buffer.alloc(0));

    if (first.command === ZK_COMMANDS.ACK_DATA || first.command === ZK_COMMANDS.ACK_OK) {
      return first.data;
    }

    if (first.command !== ZK_COMMANDS.PREPARE_DATA) {
      throw new DeviceUnreachableError(`The device refused to send data (code ${first.command}).`);
    }

    const expected = first.data.length >= 4 ? first.data.readUInt32LE(0) : 0;
    const chunks: Buffer[] = [];
    let received = 0;

    while (received < expected) {
      const next = await this.awaitPacket();
      if (next.command === ZK_COMMANDS.ACK_OK) break;
      if (next.command !== ZK_COMMANDS.DATA) {
        throw new DeviceUnreachableError(
          `The device interrupted the transfer with code ${next.command} after ${received} of ${expected} bytes.`,
        );
      }
      chunks.push(next.data);
      received += next.data.length;
    }

    if (received < expected) {
      throw new DeviceUnreachableError(
        `The device sent ${received} of ${expected} bytes and stopped; the transfer is incomplete.`,
      );
    }

    return Buffer.concat(chunks);
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
    await this.send(
      enabled ? ZK_COMMANDS.ENABLE_DEVICE : ZK_COMMANDS.DISABLE_DEVICE,
      Buffer.alloc(0),
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      if (this.socket && !this.socket.destroyed && !this.dead) {
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
    // The terminal must never be left disabled because we failed. If the
    // socket is already gone this is a no-op that must not mask the real
    // error, hence the swallow.
    if (quiesced) await session.setEnabled(true).catch(() => undefined);
    await session.close().catch(() => undefined);
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
