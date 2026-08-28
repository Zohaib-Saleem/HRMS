/**
 * Byte-level checks for the ZKTeco codec.
 *
 * The device is not installed yet, so these are the strongest evidence
 * available that the wire format is implemented correctly. Where possible the
 * expectation is a value computed by hand from the documented layout rather
 * than one produced by this codebase, so a shared misunderstanding between the
 * encoder and the decoder cannot pass unnoticed.
 *
 *   npx tsx scripts/verify-zkt-protocol.mjs
 */
import {
  ZK_COMMANDS,
  TCP_MAGIC,
  checksum,
  decodeAttendance,
  decodeDeviceTime,
  decodeFrame,
  decodeUsers,
  encodeAttendance,
  encodeDeviceTime,
  encodePacket,
  encodeUsers,
  makeAuthKey,
} from '../apps/api/src/modules/attendance-device/zkteco.protocol.ts';

let pass = 0;
let fail = 0;
const check = (label, expected, actual) => {
  const e = String(expected);
  const a = String(actual);
  if (e === a) {
    console.log(`  PASS  ${label} (${a})`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label} - expected ${e}, got ${a}`);
    fail += 1;
  }
};

console.log('################ A. PACKED DEVICE TIME (hand-computed) ################');
// 2026-08-28 08:56:12, worked through the documented radix by hand:
//   days = ((2026-2000)*12 + (8-1))*31 + (28-1) = (319*31)+27 = 9916
//   9916*86400 + 8*3600 + 56*60 + 12 = 856774572
check(
  'encodes 2026-08-28 08:56:12 to 856774572',
  856774572,
  encodeDeviceTime({ year: 2026, month: 8, day: 28, hour: 8, minute: 56, second: 12 }),
);
const back = decodeDeviceTime(856774572);
check(
  'and decodes it back',
  '2026-8-28 8:56:12',
  `${back.year}-${back.month}-${back.day} ${back.hour}:${back.minute}:${back.second}`,
);
// A second independent vector: the epoch of this encoding.
check(
  '2000-01-01 00:00:00 is zero',
  0,
  encodeDeviceTime({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }),
);
const mid = decodeDeviceTime(
  encodeDeviceTime({ year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59 }),
);
check(
  'survives the end of a year',
  '2026-12-31 23:59:59',
  `${mid.year}-${mid.month}-${mid.day} ${mid.hour}:${mid.minute}:${mid.second}`,
);
// Midnight is the case that breaks naive implementations.
const midnight = decodeDeviceTime(
  encodeDeviceTime({ year: 2026, month: 8, day: 28, hour: 0, minute: 0, second: 0 }),
);
check('midnight round-trips', '2026-8-28 0:0:0', `${midnight.year}-${midnight.month}-${midnight.day} ${midnight.hour}:${midnight.minute}:${midnight.second}`);

console.log();
console.log('################ B. CHECKSUM ################');
// Ones-complement of a 16-bit sum: two words of 0x0000 sum to 0, complement 0xffff.
check('all-zero words checksum to 0xffff', 65535, checksum(Buffer.from([0, 0, 0, 0])));
check('is order-independent for whole words', checksum(Buffer.from([1, 0, 2, 0])), checksum(Buffer.from([2, 0, 1, 0])));
check('changes when a byte changes', true, checksum(Buffer.from([1, 0])) !== checksum(Buffer.from([2, 0])));
check('handles an odd trailing byte', true, Number.isInteger(checksum(Buffer.from([1, 0, 3]))));

console.log();
console.log('################ C. FRAMING ################');
const framed = encodePacket({
  command: ZK_COMMANDS.CONNECT,
  sessionId: 0,
  replyId: 0,
  data: Buffer.alloc(0),
});
check('starts with the framing magic', true, framed.subarray(0, 4).equals(TCP_MAGIC));
check('declares a payload of 8 bytes for an empty command', 8, framed.readUInt32LE(4));
check('total frame is 16 bytes', 16, framed.length);

const decoded = decodeFrame(framed);
check('round-trips the command', ZK_COMMANDS.CONNECT, decoded.packet.command);
check('reports bytes consumed', 16, decoded.consumed);

// A stream socket delivers packets split and glued; both must be handled.
check('a partial frame yields null rather than throwing', null, decodeFrame(framed.subarray(0, 10)));
const glued = Buffer.concat([framed, framed]);
const first = decodeFrame(glued);
const second = decodeFrame(glued.subarray(first.consumed));
check('two glued frames both decode', true, first !== null && second !== null);
check('the checksum the device will verify is present', true, framed.readUInt16LE(8 + 2) !== 0);

let threw = false;
try {
  decodeFrame(Buffer.from([1, 2, 3, 4, 0, 0, 0, 0]));
} catch {
  threw = true;
}
check('rubbish framing is rejected', true, threw);

console.log();
console.log('################ D. ATTENDANCE RECORDS ################');
const records = [
  { uid: 1, deviceUserId: '1007', status: 0, punch: 0, clock: { year: 2026, month: 8, day: 28, hour: 8, minute: 56, second: 12 } },
  { uid: 2, deviceUserId: '1008', status: 1, punch: 1, clock: { year: 2026, month: 8, day: 28, hour: 18, minute: 14, second: 3 } },
];
const encoded = encodeAttendance(records);
check('40 bytes per record', 80, encoded.length);
const parsed = decodeAttendance(encoded);
check('both records decode', 2, parsed.length);
check('device user id survives', '1007', parsed[0].deviceUserId);
check('punch direction survives', 1, parsed[1].punch);
check('the timestamp survives', '2026-8-28 8:56:12', `${parsed[0].clock.year}-${parsed[0].clock.month}-${parsed[0].clock.day} ${parsed[0].clock.hour}:${parsed[0].clock.minute}:${parsed[0].clock.second}`);
check('an empty payload is not an error', 0, decodeAttendance(Buffer.alloc(0)).length);

let badSize = false;
try {
  decodeAttendance(Buffer.alloc(37));
} catch {
  badSize = true;
}
check('an unrecognised record size is reported, not guessed', true, badSize);

console.log();
console.log('################ E. USER TABLE ################');
const users = [
  { uid: 1, deviceUserId: '1007', name: 'Ahmed Raza', privilege: 0, cardNumber: null },
  { uid: 2, deviceUserId: '1008', name: 'Sana Iqbal', privilege: 14, cardNumber: '4242' },
];
const parsedUsers = decodeUsers(encodeUsers(users));
check('both users decode', 2, parsedUsers.length);
check('name survives', 'Ahmed Raza', parsedUsers[0].name);
check('device user id survives', '1008', parsedUsers[1].deviceUserId);
check('privilege survives', 14, parsedUsers[1].privilege);
check('card number survives', '4242', parsedUsers[1].cardNumber);

console.log();
console.log('################ F. COMM-KEY HANDSHAKE ################');
const a = makeAuthKey(1234, 42);
const b = makeAuthKey(1234, 43);
check('the auth blob is 4 bytes', 4, a.length);
check('it is bound to the session, so it cannot be replayed', false, a.equals(b));
check('the same key and session are deterministic', true, a.equals(makeAuthKey(1234, 42)));

console.log();
console.log('################ SUMMARY ################');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
