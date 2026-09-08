import {
  toReadings,
  withSession,
  type DeviceReading,
  type TerminalAddress,
  type ZkUser,
} from '@hrms/zkteco';
import { log } from './logger.js';

/**
 * One visit to the terminal.
 *
 * Everything the connector needs in a cycle is read in a single session, on
 * purpose. Opening a session disables the terminal while it is held, so a
 * connector that opened four - one for the serial, one for the clock, one for
 * attendance, one for the roster - would take the device out of service four
 * times as often, and a person standing at it would find it dead for no reason
 * they could see.
 */

export interface TerminalRead {
  /** As the device reports it. The connector's identity claim to the HRMS. */
  serialNumber: string | null;
  /** The terminal's own clock as a wall-clock string, for drift reporting. */
  deviceTime: string | null;
  readings: DeviceReading[];
  /** Only present when the roster was due this cycle. */
  users: ZkUser[] | null;
}

const two = (n: number) => String(n).padStart(2, '0');

export async function readTerminal(
  address: TerminalAddress,
  options: { includeRoster: boolean },
): Promise<TerminalRead> {
  return withSession(address, async (session) => {
    const serialNumber = await session.readOption('~SerialNumber');

    // A clock reading is a diagnostic. Failing the cycle - and therefore the
    // attendance - because a terminal declined to give one would be absurd.
    let deviceTime: string | null = null;
    try {
      const clock = await session.readTime();
      deviceTime = clock
        ? `${clock.year}-${two(clock.month)}-${two(clock.day)} ${two(clock.hour)}:${two(clock.minute)}:${two(clock.second)}`
        : null;
    } catch (error) {
      log.debug('DEVICE_TIME_UNREAD', 'the terminal clock could not be read', { error: String(error) });
    }

    const readings = toReadings(await session.readAttendance());
    const users = options.includeRoster ? await session.readUsers() : null;

    return { serialNumber, deviceTime, readings, users };
  });
}
