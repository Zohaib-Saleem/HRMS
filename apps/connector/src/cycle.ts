import type { ConnectorHandshake, ConnectorPunch } from '@hrms/shared';
import type { DeviceReading, TerminalAddress, ZkUser } from '@hrms/zkteco';
import { DeviceAuthError, DeviceUnreachableError } from '@hrms/zkteco';
import type { ConnectorConfig } from './config.js';
import { log } from './logger.js';
import { ServerError, type ServerClient } from './server-client.js';
import { isCursor, saveState, type ConnectorState } from './state.js';
import { readTerminal } from './terminal.js';

/**
 * One poll: read the terminal, tell the HRMS, advance the watermark.
 *
 * The ordering rule that everything else follows from: the watermark advances
 * only after the HRMS has acknowledged the batch that contains that reading.
 * Any other order trades a duplicate - which the server absorbs, because it
 * fingerprints punches - for a gap, which nothing absorbs and nobody notices
 * until payroll is wrong.
 */

/** The server refuses more than this in one request. */
const MAX_BATCH = 1000;

/** PIN and timestamp bounds the server's own schema enforces. */
const MAX_PIN_LENGTH = 64;

export interface CycleOutcome {
  /** What the HRMS says the poll interval should be, when it said anything. */
  pollMinutes: number | null;
  /** Whether the terminal answered, for the backoff the caller applies. */
  terminalReached: boolean;
  /**
   * Whether the exchange with the HRMS actually succeeded.
   *
   * False for a rejected credential as much as for an unreachable server. The
   * two feel different but they call for the same response - stop asking so
   * often - and a connector with a wrong token that never backed off would
   * knock on the door every poll interval for as long as it was left running.
   */
  serverReached: boolean;
  /** Whether a fresh handshake landed, so the caller can time the next one. */
  handshook: boolean;
  sent: number;
  duplicates: number;
  unmapped: number;
}

export interface CycleContext {
  config: ConnectorConfig;
  client: ServerClient;
  state: ConnectorState;
  /** Null until the first handshake succeeds. */
  handshake: ConnectorHandshake | null;
  /** Set when the handshake should be repeated this cycle. */
  handshakeDue: boolean;
  rosterDue: boolean;
}

export async function runCycle(context: CycleContext): Promise<CycleOutcome> {
  const { config, client, state } = context;
  const outcome: CycleOutcome = {
    pollMinutes: null,
    terminalReached: false,
    serverReached: false,
    handshook: false,
    sent: 0,
    duplicates: 0,
    unmapped: 0,
  };

  const address: TerminalAddress = {
    host: config.deviceHost,
    port: config.devicePort,
    commKey: config.commKey,
    timeoutMs: config.deviceTimeoutMs,
  };

  let read;
  try {
    read = await readTerminal(address, { includeRoster: context.rosterDue });
    outcome.terminalReached = true;
  } catch (error) {
    // The terminal is on the same LAN as this machine, so a failure here is a
    // local problem - unplugged, powered off, a changed address - and saying
    // which kind saves somebody a drive.
    if (error instanceof DeviceAuthError) {
      log.error('DEVICE_AUTH', 'the terminal refused this connector; check the comm key', {
        device: `${config.deviceHost}:${config.devicePort}`,
      });
    } else if (error instanceof DeviceUnreachableError) {
      log.warn('DEVICE_UNREACHABLE', 'the terminal could not be reached', {
        device: `${config.deviceHost}:${config.devicePort}`,
        error: error.message,
      });
    } else {
      log.error('DEVICE_READ_FAILED', 'the terminal could not be read', { error: String(error) });
    }
    return outcome;
  }

  const serialNumber = read.serialNumber ?? state.deviceSerial;
  if (!serialNumber) {
    // Without a serial there is nothing to authenticate against. Refusing to
    // guess is the point: a connector that invented one could file this
    // office's attendance under another office's device.
    log.error('NO_SERIAL', 'the terminal did not report a serial number, so nothing can be sent', {});
    return outcome;
  }
  if (serialNumber !== state.deviceSerial) {
    if (state.deviceSerial) {
      // Somebody swapped the hardware, or pointed this connector elsewhere.
      // The watermark belonged to the old terminal and means nothing here.
      log.warn('DEVICE_CHANGED', 'this address now answers with a different serial; the watermark was reset', {
        was: state.deviceSerial,
        now: serialNumber,
      });
      state.cursor = null;
    }
    state.deviceSerial = serialNumber;
    saveState(config.statePath, state);
  }

  if (context.handshakeDue || context.handshake === null) {
    try {
      const handshake = await client.handshake(serialNumber);
      context.handshake = handshake;
      outcome.handshook = true;
      outcome.serverReached = true;
      outcome.pollMinutes = handshake.pollIntervalMinutes;

      log.info('HANDSHAKE', 'configuration received from the HRMS', {
        device: handshake.deviceName,
        timeZone: handshake.timeZone,
        pollMinutes: handshake.pollIntervalMinutes,
        cursorHint: handshake.cursorHint,
      });

      // A hint, never an instruction. It is adopted only when this connector
      // has no watermark of its own, which is the case it exists for: a fresh
      // install that would otherwise replay years of history the server would
      // only deduplicate.
      if (state.cursor === null && isCursor(handshake.cursorHint)) {
        state.cursor = handshake.cursorHint;
        saveState(config.statePath, state);
        log.info('CURSOR_ADOPTED', 'starting from the point the HRMS has already accounted for', {
          cursor: state.cursor,
        });
      }
    } catch (error) {
      reportServerError('HANDSHAKE_FAILED', error);

      // A failed *refresh* is not a reason to sit on a terminal's punches. The
      // configuration already in hand is a few minutes old at worst, and the
      // records are the thing that matters; the next cycle will try again.
      if (context.handshake === null) return outcome;
      log.warn('HANDSHAKE_STALE', 'carrying on with the configuration from the last successful check-in', {});
    }
  }

  if (read.users) {
    const sentRoster = await sendRoster(context, serialNumber, read.users);
    outcome.serverReached = outcome.serverReached || sentRoster;
  }

  const pending = selectPending(read.readings, state.cursor);
  if (pending.length === 0) {
    log.debug('NOTHING_NEW', 'the terminal holds nothing newer than the watermark', {
      cursor: state.cursor,
      onDevice: read.readings.length,
    });
    // Still worth one call: it tells the HRMS the connector and the terminal
    // are both alive, which is the difference between "quiet" and "broken" on
    // the Devices page.
    const contacted = await sendBatch(context, serialNumber, [], read.deviceTime, outcome);
    outcome.serverReached = outcome.serverReached || contacted;
    return outcome;
  }

  log.info('PENDING', 'readings newer than the watermark', {
    count: pending.length,
    from: pending[0]?.rawTimestamp,
    to: pending[pending.length - 1]?.rawTimestamp,
    cursor: state.cursor,
  });

  for (let start = 0; start < pending.length; start += MAX_BATCH) {
    const slice = pending.slice(start, start + MAX_BATCH);
    // Only the first batch carries the clock reading: it describes the
    // terminal, not the batch, and repeating it would just be noise.
    const accepted = await sendBatch(
      context,
      serialNumber,
      slice,
      start === 0 ? read.deviceTime : null,
      outcome,
    );
    if (!accepted) return outcome;

    outcome.serverReached = true;

    // Advance only now, and only to the end of what was acknowledged.
    const last = slice[slice.length - 1];
    if (last) {
      state.cursor = last.rawTimestamp;
      saveState(config.statePath, state);
    }
  }

  return outcome;
}

/**
 * The readings worth sending.
 *
 * At or after the watermark, not strictly after it. A terminal can record two
 * transactions in the same second, and a strict comparison would drop the
 * second one forever the moment the first was acknowledged. Re-sending the
 * boundary second costs one duplicate per poll, which the server recognises
 * and discards; the alternative costs a punch, silently.
 */
export function selectPending(readings: readonly DeviceReading[], cursor: string | null): DeviceReading[] {
  const usable = readings.filter((reading) => {
    if (!reading.deviceUserId || reading.deviceUserId.length > MAX_PIN_LENGTH) {
      log.warn('READING_SKIPPED', 'a record had no usable device user ID', {
        rawTimestamp: reading.rawTimestamp,
      });
      return false;
    }
    if (!isCursor(reading.rawTimestamp)) {
      log.warn('READING_SKIPPED', 'a record had a timestamp this connector could not read', {
        deviceUserId: reading.deviceUserId,
        rawTimestamp: reading.rawTimestamp,
      });
      return false;
    }
    return cursor === null || reading.rawTimestamp >= cursor;
  });

  // The device returns its log in its own order, which is usually but not
  // always chronological. Sorting here is what makes the watermark meaningful:
  // it is only safe to advance to the last item of a batch if that item is the
  // latest one in it.
  return usable.sort((a, b) => a.rawTimestamp.localeCompare(b.rawTimestamp));
}

async function sendBatch(
  context: CycleContext,
  serialNumber: string,
  readings: readonly DeviceReading[],
  deviceTime: string | null,
  outcome: CycleOutcome,
): Promise<boolean> {
  const punches: ConnectorPunch[] = readings.map((reading) => ({
    deviceUserId: reading.deviceUserId,
    rawTimestamp: reading.rawTimestamp,
    punchState: reading.punchState,
    verifyMode: reading.verifyMode,
    deviceTransactionId: null,
  }));

  try {
    const result = await context.client.sendPunches({
      serialNumber,
      connectorVersion: VERSION,
      deviceTime,
      punches,
    });

    outcome.sent += result.imported;
    outcome.duplicates += result.duplicates;
    outcome.unmapped += result.unmapped;

    if (punches.length > 0) {
      log.info('BATCH_SENT', 'the HRMS accepted a batch', {
        received: result.received,
        imported: result.imported,
        duplicates: result.duplicates,
        unmapped: result.unmapped,
        errors: result.errors,
      });
    }
    if (result.unmapped > 0) {
      // Not an error. The punches are stored and will be attributed the moment
      // somebody maps the PIN, which is a decision only a person can make.
      log.warn('UNMAPPED', 'some PINs are not mapped to an employee in the HRMS yet', {
        count: result.unmapped,
      });
    }
    return true;
  } catch (error) {
    reportServerError('BATCH_FAILED', error);

    // A refused payload is this connector's bug, and the same bytes will be
    // refused forever. Skipping past them is the lesser evil: holding the
    // watermark would block every later punch behind records that can never
    // be accepted. Logged loudly enough to be found afterwards.
    if (error instanceof ServerError && error.failure === 'INVALID' && readings.length > 0) {
      log.error('BATCH_REJECTED', 'the HRMS refused this batch as invalid; skipping past it', {
        count: readings.length,
        from: readings[0]?.rawTimestamp,
        to: readings[readings.length - 1]?.rawTimestamp,
      });
      return true;
    }
    return false;
  }
}

async function sendRoster(
  context: CycleContext,
  serialNumber: string,
  users: readonly ZkUser[],
): Promise<boolean> {
  try {
    const result = await context.client.sendRoster({
      serialNumber,
      connectorVersion: VERSION,
      users: users.map((user) => ({
        deviceUserId: user.deviceUserId,
        name: user.name || null,
        privilege: user.privilege,
        cardNumber: user.cardNumber,
      })),
    });

    context.state.rosterSentAt = new Date().toISOString();
    saveState(context.config.statePath, context.state);

    log.info('ROSTER_SENT', 'the terminal enrolment list was sent', {
      received: result.received,
      stored: result.stored,
      unmapped: result.unmapped,
    });
    return true;
  } catch (error) {
    // A roster is a convenience for the mapping screen. Failing to send one
    // must never stop attendance, so this is reported and stepped over.
    reportServerError('ROSTER_FAILED', error);
    return false;
  }
}

function reportServerError(event: string, error: unknown): void {
  if (!(error instanceof ServerError)) {
    log.error(event, 'an unexpected failure talking to the HRMS', { error: String(error) });
    return;
  }

  switch (error.failure) {
    case 'REJECTED':
      log.error(event, 'the HRMS rejected this connector; check the token and that the device serial is registered', {
        status: error.status,
      });
      break;
    case 'NOT_CONFIGURED':
      log.error(event, 'this device has no connector token set in the HRMS; an administrator must set one', {
        status: error.status,
        detail: error.message,
      });
      break;
    case 'INVALID':
      log.error(event, 'the HRMS refused the payload', { status: error.status, detail: error.message });
      break;
    case 'THROTTLED':
      log.warn(event, 'the HRMS is rate limiting this connector', { status: error.status });
      break;
    default:
      log.warn(event, error.message, { status: error.status });
  }
}

/** Reported to the HRMS so a stale connector is visible without a site visit. */
export const VERSION = '1.0.0';
