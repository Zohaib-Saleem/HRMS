/**
 * A ZKTeco terminal simulator.
 *
 * Speaks the real wire protocol over a real socket, so the adapter is exercised
 * end to end - framing, session handshake, comm-key auth, chunked bulk transfer
 * and the packed time format - without hardware.
 *
 * What it cannot prove: that the protocol matches the physical device. Encoder
 * and decoder here share an author, so a shared misunderstanding would pass.
 * Treat this as evidence the implementation is internally consistent and
 * network-correct, not as a substitute for the real terminal.
 *
 * Standalone:  npx tsx scripts/zkt-simulator.mjs --port 4370
 * In a test:   import { startSimulator } from './zkt-simulator.mjs'
 */
import { createServer } from 'node:net';
import {
  ZK_COMMANDS,
  decodeFrame,
  encodeAttendance,
  encodePacket,
  encodeUsers,
  makeAuthKey,
} from '../apps/api/src/modules/attendance-device/zkteco.protocol.ts';

const DEFAULT_USERS = [
  { uid: 1, deviceUserId: '1007', name: 'Ahmed Raza', privilege: 0, cardNumber: null },
  { uid: 2, deviceUserId: '1008', name: 'Sana Iqbal', privilege: 0, cardNumber: null },
];

/**
 * @param {object} options
 * @param {number} options.port
 * @param {Array} [options.punches]   attendance records to serve
 * @param {Array} [options.users]     enrolled users
 * @param {number|null} [options.commKey]  when set, the device demands auth
 * @param {number} [options.chunkSize] force chunked transfer to exercise it
 * @param {boolean} [options.refuse]  answer nothing, to simulate a dead device
 * @param {'ok'|'silent'|'garbage'|'reset'|'truncate'|'dropMidTransfer'} [options.fault]
 *        how the terminal misbehaves once the attendance log is requested
 * @param {number} [options.resetAfterPackets] destroy the socket after N packets
 */
export function startSimulator(options) {
  const {
    port,
    punches = [],
    users = DEFAULT_USERS,
    commKey = null,
    chunkSize = 1024,
    refuse = false,
    fault = 'ok',
    resetAfterPackets = 0,
  } = options;

  const state = { connections: 0, disabled: false, punches: [...punches] };

  const server = createServer((socket) => {
    state.connections += 1;
    let packetsSeen = 0;
    let buffer = Buffer.alloc(0);
    let sessionId = 0;
    let authed = commKey === null;

    const reply = (command, data = Buffer.alloc(0)) =>
      socket.write(encodePacket({ command, sessionId, replyId: 0, data }));

    const sendBulk = (payload) => {
      if (payload.length <= chunkSize) {
        reply(ZK_COMMANDS.ACK_DATA, payload);
        return;
      }
      const size = Buffer.alloc(4);
      size.writeUInt32LE(payload.length, 0);
      reply(ZK_COMMANDS.PREPARE_DATA, size);
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        reply(ZK_COMMANDS.DATA, payload.subarray(offset, offset + chunkSize));
      }
    };

    const option = (name) => {
      const table = {
        '~SerialNumber': 'SIM0123456789',
        '~DeviceName': 'ZKTeco Simulator',
        '~ZKFPVersion': '10',
        '~Platform': 'ZMM220_TFT',
        UserCount: String(users.length),
        AttLogCount: String(state.punches.length),
        '~Time': new Date().toISOString(),
      };
      return table[name] ?? '';
    };

    socket.on('data', (chunk) => {
      if (refuse) return;
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        let frame;
        try {
          frame = decodeFrame(buffer);
        } catch {
          socket.destroy();
          return;
        }
        if (!frame) return;
        buffer = buffer.subarray(frame.consumed);

        const { command, data } = frame.packet;
        packetsSeen += 1;
        if (resetAfterPackets > 0 && packetsSeen > resetAfterPackets) {
          socket.destroy();
          return;
        }

        if (command === ZK_COMMANDS.CONNECT) {
          sessionId = 0x1234;
          reply(commKey === null ? ZK_COMMANDS.ACK_OK : ZK_COMMANDS.ACK_UNAUTH);
          continue;
        }

        if (command === ZK_COMMANDS.AUTH) {
          const expected = makeAuthKey(commKey ?? 0, sessionId);
          authed = data.subarray(0, 4).equals(expected);
          reply(authed ? ZK_COMMANDS.ACK_OK : ZK_COMMANDS.ACK_UNAUTH);
          continue;
        }

        if (!authed) {
          reply(ZK_COMMANDS.ACK_UNAUTH);
          continue;
        }

        switch (command) {
          case ZK_COMMANDS.DISABLE_DEVICE:
            state.disabled = true;
            reply(ZK_COMMANDS.ACK_OK);
            break;
          case ZK_COMMANDS.ENABLE_DEVICE:
            state.disabled = false;
            reply(ZK_COMMANDS.ACK_OK);
            break;
          case ZK_COMMANDS.OPTIONS_RRQ: {
            const name = data.toString('ascii').replace(/\0.*$/, '').trim();
            reply(ZK_COMMANDS.ACK_OK, Buffer.from(`${name}=${option(name)}\0`, 'ascii'));
            break;
          }
          case ZK_COMMANDS.ATTLOG_RRQ: {
            const payload = encodeAttendance(state.punches);

            if (fault === 'silent') break; // accept, then say nothing at all
            if (fault === 'reset') { socket.destroy(); return; }
            if (fault === 'garbage') {
              // Bytes that carry no valid framing magic.
              socket.write(Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xee, 0xdd, 0xcc]));
              break;
            }
            if (fault === 'truncate' || fault === 'dropMidTransfer') {
              // Announce the full size, then send only part of it.
              const size = Buffer.alloc(4);
              size.writeUInt32LE(payload.length, 0);
              reply(ZK_COMMANDS.PREPARE_DATA, size);
              const half = Math.max(40, Math.floor(payload.length / 2));
              reply(ZK_COMMANDS.DATA, payload.subarray(0, half));
              // dropMidTransfer also loses the socket, as a reboot would.
              if (fault === 'dropMidTransfer') socket.destroy();
              break;
            }

            sendBulk(payload);
            break;
          }
          case ZK_COMMANDS.USERTEMP_RRQ:
            sendBulk(encodeUsers(users));
            break;
          case ZK_COMMANDS.EXIT:
            reply(ZK_COMMANDS.ACK_OK);
            socket.end();
            break;
          default:
            reply(ZK_COMMANDS.ACK_ERROR);
        }
      }
    });

    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        state,
        /** Add punches mid-run, to simulate people arriving between syncs. */
        addPunches: (extra) => state.punches.push(...extra),
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Builds a record in the shape the encoder expects. */
export function punch(deviceUserId, isoLocal, punchByte = 0, statusByte = 1) {
  const [date, time] = isoLocal.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  return {
    uid: Number(deviceUserId) % 65535,
    deviceUserId,
    status: statusByte,
    punch: punchByte,
    clock: { year, month, day, hour, minute, second: second ?? 0 },
  };
}

const isMain = process.argv[1]?.endsWith('zkt-simulator.mjs');
if (isMain) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg === -1 ? 4370 : Number(process.argv[portArg + 1]);
  const today = new Date().toISOString().slice(0, 10);
  const server = await startSimulator({
    port,
    punches: [punch('1007', `${today} 08:56:12`, 0), punch('1007', `${today} 18:14:03`, 1)],
  });
  console.log(`ZKTeco simulator listening on 127.0.0.1:${server.port}`);
}
