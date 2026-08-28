import { instantInZone } from '../../core/zoned-time.js';
import type { DevicePunch } from './adapter.js';

/**
 * The ADMS (iclock) push format.
 *
 * ADMS inverts the pull protocol: the terminal opens an outbound HTTP
 * connection to us and posts what it has recorded, which is the only way a
 * device behind NAT or on a mobile link can be integrated at all.
 *
 * The wire format is plain text, tab separated, one record per line:
 *
 *   PIN \t YYYY-MM-DD HH:mm:ss \t status \t verify \t workcode \t reserved...
 *
 * Real firmware varies. Some models send spaces where the specification says
 * tabs, some send \r\n, some append trailing empty fields, and some send fewer
 * than five. Everything after the timestamp is therefore optional, and the
 * parser tolerates either separator rather than rejecting a whole batch over
 * whitespace.
 *
 * Nothing here touches the database or the network, so the format can be
 * tested against captured device output on its own.
 */

/** A line that could not be read, kept so a partial batch can be diagnosed. */
export interface AdmsLineError {
  line: number;
  raw: string;
  reason: string;
}

export interface AdmsParseResult {
  punches: DevicePunch[];
  errors: AdmsLineError[];
  /** Lines that were blank, which are normal and not counted as records. */
  skipped: number;
}

/** `1007\t2026-08-28 08:56:12\t0\t1\t0` and its many real-world variations. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Truncated before storage: a device field is not a place for prose. */
const MAX_FIELD = 64;

/** Device transactions predating this are a decode failure, not a reading. */
const PLAUSIBLE_FROM = Date.UTC(2000, 0, 1);
const PLAUSIBLE_TO = Date.UTC(2100, 0, 1);

function splitFields(line: string): string[] {
  // Tab is the documented separator. Falling back to whitespace costs nothing
  // here because no field in this format legitimately contains a space except
  // the timestamp, which is rejoined below.
  const byTab = line.split('\t');
  if (byTab.length >= 2) return byTab.map((field) => field.trim());

  const parts = line.trim().split(/\s+/);
  if (parts.length >= 3) {
    // `PIN date time status...` - rejoin the date and time into one field.
    return [parts[0] ?? '', `${parts[1]} ${parts[2]}`, ...parts.slice(3)];
  }
  return parts;
}

function optionalField(fields: string[], index: number): string | null {
  const value = fields[index]?.trim();
  if (!value) return null;
  return value.slice(0, MAX_FIELD);
}

/**
 * Turns one ATTLOG body into punches.
 *
 * A bad line is an error against that line only. A terminal that has been
 * offline for a week posts its whole backlog in one request, and one corrupt
 * record in the middle of it must not cost the other six days.
 */
export function parseAttlog(body: string, deviceTimeZone: string): AdmsParseResult {
  const punches: DevicePunch[] = [];
  const errors: AdmsLineError[] = [];
  let skipped = 0;

  const lines = body.split(/\r\n|\r|\n/);

  lines.forEach((raw, index) => {
    if (!raw.trim()) {
      skipped += 1;
      return;
    }
    // Trailing whitespace only. Trimming the whole line would swallow a leading
    // empty field, turning a record with no user ID into one whose timestamp
    // looks wrong - a misleading diagnosis of a real device fault.
    const line = raw.replace(/\s+$/, '');

    const fail = (reason: string) => {
      errors.push({ line: index + 1, raw: raw.slice(0, 200), reason });
    };

    const fields = splitFields(line);
    const deviceUserId = fields[0]?.trim();
    if (!deviceUserId) {
      fail('The record has no device user ID.');
      return;
    }
    if (deviceUserId.length > MAX_FIELD) {
      fail('The device user ID is longer than this system stores.');
      return;
    }

    const stamp = fields[1]?.trim();
    if (!stamp) {
      fail('The record has no timestamp.');
      return;
    }

    const parts = TIMESTAMP.exec(stamp);
    if (!parts) {
      fail('The timestamp is not in the expected YYYY-MM-DD HH:mm:ss form.');
      return;
    }

    const [, year, month, day, hour, minute, second] = parts;
    let punchedAt: Date;
    try {
      // The device sends wall-clock time with no offset. Its configured zone is
      // the only thing that turns those digits into an instant, which is why a
      // device with the wrong zone silently shifts every record it sends.
      //
      // Built exactly the way the pull adapter builds it, seconds added on top
      // of a minute-resolution instant, so a punch that arrives by push and the
      // same punch pulled later land on the same millisecond and deduplicate.
      punchedAt = new Date(
        instantInZone(`${year}-${month}-${day}`, Number(hour), Number(minute), deviceTimeZone).getTime() +
          (second ? Number(second) : 0) * 1000,
      );
    } catch {
      fail('The timestamp could not be placed in the device timezone.');
      return;
    }

    const at = punchedAt.getTime();
    if (Number.isNaN(at) || at < PLAUSIBLE_FROM || at > PLAUSIBLE_TO) {
      fail('The timestamp is outside any plausible range.');
      return;
    }

    punches.push({
      deviceUserId: deviceUserId.slice(0, MAX_FIELD),
      // ADMS carries no transaction ID. Deduplication therefore rests entirely
      // on the fingerprint, which is why the same batch can be posted twice.
      deviceTransactionId: null,
      rawTimestamp: `${year}-${month}-${day} ${hour}:${minute}:${second ?? '00'}`,
      punchedAt,
      punchState: optionalField(fields, 2),
      verifyMode: optionalField(fields, 3),
    });
  });

  return { punches, errors, skipped };
}

/**
 * The handshake a terminal expects before it will post anything.
 *
 * The device asks for its configuration on boot and obeys what comes back.
 * Only the keys that affect attendance are set; nothing here enrols users,
 * opens doors or changes device security, because a push endpoint that can do
 * those things is a far larger thing to leave unauthenticated on a network.
 */
export function buildHandshake(input: {
  serialNumber: string;
  /** How often the device should ask for pending commands, in seconds. */
  pollIntervalSeconds: number;
  timeZoneOffsetHours: number;
}): string {
  return [
    `GET OPTION FROM: ${input.serialNumber}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=None',
    'ATTPHOTOStamp=None',
    `ErrorDelay=${Math.max(30, input.pollIntervalSeconds)}`,
    `Delay=${input.pollIntervalSeconds}`,
    `TransTimes=00:00;14:00`,
    'TransInterval=1',
    'TransFlag=1000000000',
    `TimeZone=${input.timeZoneOffsetHours}`,
    'Realtime=1',
    'Encrypt=0',
  ].join('\n');
}
