/**
 * The ZKTeco standalone terminal protocol, as pure functions.
 *
 * Deliberately free of sockets. Framing, checksums, the peculiar packed time
 * format and the attendance record layout are all decisions that can be wrong
 * in ways a connection test would never reveal, so they are written here where
 * they can be exercised directly against known byte sequences.
 *
 * Wire shape, all little-endian:
 *
 *   TCP framing   50 50 82 7d | payload length (4)
 *   packet        command (2) | checksum (2) | session (2) | reply (2) | data
 *
 * The device answers a command with CMD_ACK_OK, or announces a bulk transfer
 * with CMD_PREPARE_DATA followed by CMD_DATA chunks.
 */

export const ZK_COMMANDS = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLE_DEVICE: 1002,
  DISABLE_DEVICE: 1003,
  /** Read an option by name, e.g. `~SerialNumber`. */
  OPTIONS_RRQ: 11,
  /** Read attendance transactions. */
  ATTLOG_RRQ: 13,
  /** Read enrolled users. */
  USERTEMP_RRQ: 9,
  GET_TIME: 201,
  /** Comm-key authentication, sent when the device demands one. */
  AUTH: 1102,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_UNAUTH: 2005,
} as const;

/** Present on every TCP packet; how the framing is recognised. */
export const TCP_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const HEADER_BYTES = 8;

export interface ZkPacket {
  command: number;
  sessionId: number;
  replyId: number;
  data: Buffer;
}

/**
 * The device checksum: a ones-complement sum over 16-bit words.
 *
 * Computed with the checksum field itself zeroed, which is why callers build
 * the packet first and patch it afterwards.
 */
export function checksum(buffer: Buffer): number {
  let sum = 0;
  let i = 0;

  for (; i + 1 < buffer.length; i += 2) {
    sum += buffer.readUInt16LE(i);
    if (sum > 0xffff) sum -= 0xffff;
  }
  if (i < buffer.length) {
    sum += buffer[i]!;
    if (sum > 0xffff) sum -= 0xffff;
  }

  return (~sum) & 0xffff;
}

/** Builds a command packet, framed for TCP. */
export function encodePacket(packet: ZkPacket): Buffer {
  const body = Buffer.alloc(HEADER_BYTES + packet.data.length);
  body.writeUInt16LE(packet.command, 0);
  body.writeUInt16LE(0, 2); // checksum, filled in below
  body.writeUInt16LE(packet.sessionId, 4);
  body.writeUInt16LE(packet.replyId, 6);
  packet.data.copy(body, HEADER_BYTES);

  body.writeUInt16LE(checksum(body), 2);

  const framed = Buffer.alloc(8 + body.length);
  TCP_MAGIC.copy(framed, 0);
  framed.writeUInt32LE(body.length, 4);
  body.copy(framed, 8);
  return framed;
}

export interface DecodedFrame {
  packet: ZkPacket;
  /** Bytes consumed, so a caller can carry the remainder forward. */
  consumed: number;
}

/**
 * Reads one framed packet from a buffer.
 *
 * Returns null when the buffer does not yet hold a whole packet, which is the
 * normal case on a stream socket and must not be treated as an error.
 */
export function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 8) return null;
  if (!buffer.subarray(0, 4).equals(TCP_MAGIC)) {
    throw new Error('Not a ZKTeco packet: framing magic missing.');
  }

  const length = buffer.readUInt32LE(4);
  if (buffer.length < 8 + length) return null;
  if (length < HEADER_BYTES) throw new Error('ZKTeco packet is too short to contain a header.');

  const body = buffer.subarray(8, 8 + length);
  return {
    packet: {
      command: body.readUInt16LE(0),
      sessionId: body.readUInt16LE(4),
      replyId: body.readUInt16LE(6),
      data: Buffer.from(body.subarray(HEADER_BYTES)),
    },
    consumed: 8 + length,
  };
}

/**
 * The device packs a timestamp into one 32-bit integer.
 *
 * Note the month and day are zero-based and the "31" is a fixed radix rather
 * than the length of the month, which is why this cannot be replaced with any
 * ordinary date arithmetic.
 */
export function encodeDeviceTime(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): number {
  const { year, month, day, hour, minute, second } = parts;
  return (
    ((((year - 2000) * 12 + (month - 1)) * 31 + (day - 1)) * 24 + hour) * 3600 +
    minute * 60 +
    second
  );
}

export interface DeviceClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function decodeDeviceTime(value: number): DeviceClock {
  let t = value;

  const second = t % 60;
  t = Math.floor(t / 60);
  const minute = t % 60;
  t = Math.floor(t / 60);
  const hour = t % 24;
  t = Math.floor(t / 24);
  const day = (t % 31) + 1;
  t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  t = Math.floor(t / 12);
  const year = t + 2000;

  return { year, month, day, hour, minute, second };
}

/** A transaction exactly as the terminal reports it, before any interpretation. */
export interface ZkAttendanceRecord {
  /** The device's internal enrolment index. */
  uid: number;
  /** The identifier a person is enrolled under - what mapping keys on. */
  deviceUserId: string;
  /** Raw status byte. Meaning is firmware- and configuration-dependent. */
  status: number;
  /** Raw punch byte: 0 in, 1 out, 4/5 overtime on many builds, 255 when unset. */
  punch: number;
  clock: DeviceClock;
}

const RECORD_BYTES = 40;

/**
 * Decodes an attendance payload.
 *
 * The 40-byte layout is what current firmware sends; devices that predate it
 * use 16 bytes. Both appear in the field, so the size is inferred from the
 * payload rather than assumed, and anything else is reported rather than
 * silently mis-parsed.
 */
export function decodeAttendance(payload: Buffer): ZkAttendanceRecord[] {
  if (payload.length === 0) return [];

  if (payload.length % RECORD_BYTES === 0) {
    const records: ZkAttendanceRecord[] = [];
    for (let offset = 0; offset + RECORD_BYTES <= payload.length; offset += RECORD_BYTES) {
      const uid = payload.readUInt16LE(offset);
      const deviceUserId = payload
        .subarray(offset + 2, offset + 26)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim();
      const status = payload.readUInt8(offset + 26);
      const clock = decodeDeviceTime(payload.readUInt32LE(offset + 27));
      const punch = payload.readUInt8(offset + 31);
      records.push({ uid, deviceUserId, status, punch, clock });
    }
    return records;
  }

  if (payload.length % 16 === 0) {
    const records: ZkAttendanceRecord[] = [];
    for (let offset = 0; offset + 16 <= payload.length; offset += 16) {
      const uid = payload.readUInt16LE(offset);
      const status = payload.readUInt8(offset + 2);
      const clock = decodeDeviceTime(payload.readUInt32LE(offset + 3));
      const punch = payload.readUInt8(offset + 7);
      records.push({ uid, deviceUserId: String(uid), status, punch, clock });
    }
    return records;
  }

  throw new Error(
    `Attendance payload of ${payload.length} bytes matches no known record size (40 or 16).`,
  );
}

/** Encodes records in the 40-byte layout. Used by the simulator and by tests. */
export function encodeAttendance(records: readonly ZkAttendanceRecord[]): Buffer {
  const payload = Buffer.alloc(records.length * RECORD_BYTES);

  records.forEach((record, index) => {
    const offset = index * RECORD_BYTES;
    payload.writeUInt16LE(record.uid, offset);
    payload.write(record.deviceUserId.slice(0, 23), offset + 2, 'ascii');
    payload.writeUInt8(record.status, offset + 26);
    payload.writeUInt32LE(encodeDeviceTime(record.clock), offset + 27);
    payload.writeUInt8(record.punch, offset + 31);
  });

  return payload;
}

export interface ZkUser {
  uid: number;
  deviceUserId: string;
  name: string;
  privilege: number;
  cardNumber: string | null;
}

const USER_BYTES = 72;

/** Decodes the user table. 72 bytes per user on current firmware. */
export function decodeUsers(payload: Buffer): ZkUser[] {
  if (payload.length < USER_BYTES) return [];

  const users: ZkUser[] = [];
  for (let offset = 0; offset + USER_BYTES <= payload.length; offset += USER_BYTES) {
    const uid = payload.readUInt16LE(offset);
    const privilege = payload.readUInt8(offset + 2);
    const name = payload
      .subarray(offset + 11, offset + 35)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    const card = payload.readUInt32LE(offset + 35);
    const deviceUserId = payload
      .subarray(offset + 48, offset + 57)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();

    users.push({
      uid,
      deviceUserId: deviceUserId || String(uid),
      name,
      privilege,
      cardNumber: card ? String(card) : null,
    });
  }
  return users;
}

export function encodeUsers(users: readonly ZkUser[]): Buffer {
  const payload = Buffer.alloc(users.length * USER_BYTES);

  users.forEach((user, index) => {
    const offset = index * USER_BYTES;
    payload.writeUInt16LE(user.uid, offset);
    payload.writeUInt8(user.privilege, offset + 2);
    payload.write(user.name.slice(0, 23), offset + 11, 'ascii');
    payload.writeUInt32LE(user.cardNumber ? Number(user.cardNumber) || 0 : 0, offset + 35);
    payload.write(user.deviceUserId.slice(0, 8), offset + 48, 'ascii');
  });

  return payload;
}

/**
 * The comm-key handshake value.
 *
 * The terminal expects the key mixed with the session id, so a captured
 * handshake cannot be replayed against a later session.
 */
export function makeAuthKey(commKey: number, sessionId: number): Buffer {
  const k = commKey ^ sessionId;

  const buffer = Buffer.alloc(4);
  buffer.writeUInt8(k & 0xff, 0);
  buffer.writeUInt8((k >> 8) & 0xff, 1);
  buffer.writeUInt8((k >> 16) & 0xff, 2);
  buffer.writeUInt8(((k >> 24) & 0xff) ^ 0x5a, 3);
  return buffer;
}
