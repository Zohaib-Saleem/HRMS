import type { ZkAttendanceRecord } from './protocol.js';

/**
 * Turning decoded device records into readings, with no timezone applied.
 *
 * This is the seam between "what the terminal said" and "what it means", and
 * it is shared for a reason that is easy to underestimate. The same physical
 * transaction can reach the HRMS two ways - polled by the server, or read by a
 * connector on the terminal's LAN and posted - and downstream deduplication
 * fingerprints a punch by these fields. If the two routes named the same
 * punch state differently, or padded the same minute differently, one
 * transaction would become two attendance events under two identities.
 *
 * So there is one formatter, used by both, and it deliberately stops short of
 * the instant. Applying a timezone is the HRMS's job, because the HRMS is
 * where the device timezone is configured and where somebody can correct it.
 */


/** Punch byte meanings that are stable across the firmware we target. */
export const PUNCH_STATES: Record<number, string> = {
  0: 'IN',
  1: 'OUT',
  2: 'BREAK_OUT',
  3: 'BREAK_IN',
  4: 'OVERTIME_IN',
  5: 'OVERTIME_OUT',
};

export const VERIFY_MODES: Record<number, string> = {
  0: 'PASSWORD',
  1: 'FINGERPRINT',
  2: 'CARD',
  15: 'FACE',
};

const two = (n: number) => String(n).padStart(2, '0');

/** One transaction as the terminal reported it, before any interpretation. */
export interface DeviceReading {
  deviceUserId: string;
  /** The device's own reading, verbatim, as `YYYY-MM-DD HH:mm:ss`. */
  rawTimestamp: string;
  /** Direction as the device reported it, or null when it reports none. */
  punchState: string | null;
  verifyMode: string | null;
}

/**
 * Formats decoded records as readings.
 *
 * Order is preserved. Nothing is filtered here: a caller narrowing by a
 * watermark does so on its own terms, and the two callers have different ones
 * - the server holds an instant, the connector a wall-clock string.
 */
export function toReadings(records: readonly ZkAttendanceRecord[]): DeviceReading[] {
  return records.map((record) => {
    const { year, month, day, hour, minute, second } = record.clock;
    return {
      deviceUserId: record.deviceUserId,
      rawTimestamp: `${year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:${two(second)}`,
      punchState: PUNCH_STATES[record.punch] ?? null,
      verifyMode: VERIFY_MODES[record.status] ?? null,
    };
  });
}
