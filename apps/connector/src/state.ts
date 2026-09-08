import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './logger.js';

/**
 * The watermark, kept on disk between runs.
 *
 * A device wall-clock string, `YYYY-MM-DD HH:mm:ss`, and never an instant.
 * That is the only form the connector can compare against without knowing the
 * device timezone - and not knowing it is exactly what keeps the timezone one
 * setting, held in the HRMS, that an administrator can correct without
 * touching this machine. The format sorts correctly as a string, which is why
 * the comparisons below are string comparisons and not date arithmetic.
 *
 * Losing this file is survivable, not a disaster: the connector asks the HRMS
 * for a hint at startup and the server deduplicates anything it has already
 * seen. It exists so that the ordinary case does not re-send a terminal's
 * entire history every time the machine reboots.
 */

export interface ConnectorState {
  /** The newest reading successfully accepted by the HRMS, or null. */
  cursor: string | null;
  /** When a roster was last sent, so it is not re-read every poll. */
  rosterSentAt: string | null;
  deviceSerial: string | null;
}

const EMPTY: ConnectorState = { cursor: null, rosterSentAt: null, deviceSerial: null };

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function isCursor(value: unknown): value is string {
  return typeof value === 'string' && STAMP.test(value);
}

export function loadState(path: string): ConnectorState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
    // Unreadable state is treated as absent rather than fatal. Refusing to
    // start would mean a permissions mistake stops attendance arriving, and
    // the server can rebuild the watermark from its own records.
    log.warn('STATE_UNREADABLE', 'the saved watermark could not be read; starting without one', {
      path,
      error: String(error),
    });
    return { ...EMPTY };
  }

  try {
    const parsed = JSON.parse(text) as Partial<ConnectorState>;
    return {
      cursor: isCursor(parsed.cursor) ? parsed.cursor : null,
      rosterSentAt: typeof parsed.rosterSentAt === 'string' ? parsed.rosterSentAt : null,
      deviceSerial: typeof parsed.deviceSerial === 'string' ? parsed.deviceSerial : null,
    };
  } catch {
    log.warn('STATE_CORRUPT', 'the saved watermark was not valid JSON; starting without one', { path });
    return { ...EMPTY };
  }
}

/**
 * Writes the state, atomically.
 *
 * Write-then-rename, because the alternative is a half-written file after a
 * power cut on an office PC - and a truncated watermark that parses as a
 * *later* time than the truth would silently skip a day of attendance. A
 * corrupt file is recoverable; a plausible wrong one is not.
 */
export function saveState(path: string, state: ConnectorState): void {
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    // Not fatal. The connector keeps its watermark in memory and carries on;
    // only a restart would replay, and the server deduplicates that.
    log.error('STATE_UNWRITABLE', 'the watermark could not be saved', { path, error: String(error) });
  }
}
