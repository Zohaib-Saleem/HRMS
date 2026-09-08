import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the connector is told, and what it refuses to start without.
 *
 * Three things cannot be discovered and must be configured here: where the
 * HRMS is, the credential that proves this connector speaks for a device, and
 * where the terminal is on the local network. Everything else - the timezone,
 * how often to poll, how far back to start - comes from the HRMS at handshake,
 * because those are decisions an administrator makes on the Devices page and
 * should never require a visit to whatever machine this runs on.
 *
 * Read from a JSON file beside the executable, with every field overridable by
 * an environment variable. The file suits an unattended service install; the
 * variables suit a container, and they win, because a container's environment
 * is the thing an operator can actually change.
 */

export interface ConnectorConfig {
  /** Base URL of the HRMS, e.g. `https://hrms.example.com/connector`. */
  serverUrl: string;
  /** The connector token generated on the device's page in the HRMS. */
  token: string;
  /** The terminal on the local network. */
  deviceHost: string;
  devicePort: number;
  /** The terminal's comm key, when it has one set. */
  commKey: string | null;
  /** How long to wait on the terminal before giving up on one read. */
  deviceTimeoutMs: number;
  /** How long to wait on the HRMS before giving up on one request. */
  serverTimeoutMs: number;
  /**
   * Used only until the first handshake succeeds, and whenever the HRMS cannot
   * be reached. The real schedule is the one the HRMS hands out.
   */
  fallbackPollMinutes: number;
  /** How often to re-read the terminal's enrolment list. */
  rosterEveryMinutes: number;
  /** Where the watermark is kept between runs. */
  statePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = {
  devicePort: 4370,
  deviceTimeoutMs: 20000,
  serverTimeoutMs: 30000,
  fallbackPollMinutes: 15,
  rosterEveryMinutes: 360,
  logLevel: 'info' as const,
};

/** Where the connector lives, so its config and state sit beside it. */
function installDirectory(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

function readFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing file is not a failure: everything can come from the
    // environment instead, which is how this runs in a container.
    if (code === 'ENOENT') return {};
    throw new ConfigError(`The configuration file at ${path} could not be read: ${String(error)}`);
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the file does not contain a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // Worth being loud about. A config file with a trailing comma would
    // otherwise look exactly like a connector that was never configured.
    throw new ConfigError(
      `The configuration file at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function text(
  file: Record<string, unknown>,
  key: string,
  envKey: string,
): string | null {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const value = file[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function number(
  file: Record<string, unknown>,
  key: string,
  envKey: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = text(file, key, envKey);
  if (raw === null) {
    const value = file[key];
    if (typeof value === 'number') return clamp(value, min, max, key, fallback);
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${key} must be a number; got "${raw}".`);
  }
  return clamp(parsed, min, max, key, fallback);
}

function clamp(value: number, min: number, max: number, key: string, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}; got ${value}.`);
  }
  return value;
}

/**
 * Normalises the server address.
 *
 * The Devices page shows a URL ending in `/connector`, and somebody will paste
 * the origin alone about half the time. Both are accepted and both end up
 * meaning the same thing, because refusing one of them teaches nobody anything.
 */
function normaliseServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`serverUrl is not a URL: "${raw}".`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`serverUrl must be http or https; got "${url.protocol}".`);
  }

  const path = url.pathname.replace(/\/+$/, '');
  const base = path.endsWith('/connector') ? path : `${path}/connector`;
  return `${url.origin}${base}`;
}

export function loadConfig(): ConnectorConfig {
  const home = installDirectory();
  const path = process.env.HRMS_CONNECTOR_CONFIG ?? join(home, 'connector.config.json');
  const file = readFile(path);

  const serverUrl = text(file, 'serverUrl', 'HRMS_SERVER_URL');
  const token = text(file, 'token', 'HRMS_CONNECTOR_TOKEN');
  const deviceHost = text(file, 'deviceHost', 'HRMS_DEVICE_HOST');

  const missing = [
    serverUrl === null ? 'serverUrl (HRMS_SERVER_URL)' : null,
    token === null ? 'token (HRMS_CONNECTOR_TOKEN)' : null,
    deviceHost === null ? 'deviceHost (HRMS_DEVICE_HOST)' : null,
  ].filter((entry): entry is string => entry !== null);

  if (missing.length > 0) {
    throw new ConfigError(
      `The connector is not configured. Missing: ${missing.join(', ')}.\n` +
        `Expected a JSON file at ${path}, or the environment variables named above.`,
    );
  }

  const level = text(file, 'logLevel', 'HRMS_LOG_LEVEL') ?? DEFAULTS.logLevel;
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') {
    throw new ConfigError(`logLevel must be debug, info, warn or error; got "${level}".`);
  }

  return {
    serverUrl: normaliseServerUrl(serverUrl as string),
    token: token as string,
    deviceHost: deviceHost as string,
    devicePort: number(file, 'devicePort', 'HRMS_DEVICE_PORT', DEFAULTS.devicePort, { min: 1, max: 65535 }),
    commKey: text(file, 'commKey', 'HRMS_DEVICE_COMM_KEY'),
    deviceTimeoutMs: number(file, 'deviceTimeoutMs', 'HRMS_DEVICE_TIMEOUT_MS', DEFAULTS.deviceTimeoutMs, { min: 1000, max: 300000 }),
    serverTimeoutMs: number(file, 'serverTimeoutMs', 'HRMS_SERVER_TIMEOUT_MS', DEFAULTS.serverTimeoutMs, { min: 1000, max: 300000 }),
    fallbackPollMinutes: number(file, 'fallbackPollMinutes', 'HRMS_FALLBACK_POLL_MINUTES', DEFAULTS.fallbackPollMinutes, { min: 1, max: 1440 }),
    rosterEveryMinutes: number(file, 'rosterEveryMinutes', 'HRMS_ROSTER_EVERY_MINUTES', DEFAULTS.rosterEveryMinutes, { min: 5, max: 10080 }),
    statePath: text(file, 'statePath', 'HRMS_STATE_PATH') ?? join(home, 'connector.state.json'),
    logLevel: level,
  };
}

/** For the startup banner: everything except the credential. */
export function describeConfig(config: ConnectorConfig): Record<string, unknown> {
  return {
    serverUrl: config.serverUrl,
    device: `${config.deviceHost}:${config.devicePort}`,
    commKey: config.commKey ? 'set' : 'none',
    statePath: config.statePath,
    fallbackPollMinutes: config.fallbackPollMinutes,
    rosterEveryMinutes: config.rosterEveryMinutes,
  };
}
