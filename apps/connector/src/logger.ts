/**
 * Logging, for a program nobody is watching.
 *
 * The connector runs unattended on a machine in an office. When something goes
 * wrong the only evidence is this output, read later by somebody who was not
 * there, so every line carries a timestamp and an event name that can be
 * grepped for. One line per event, never a stack trace where a sentence would
 * do.
 *
 * Deliberately dependency-free: a logging library is one more thing to install
 * on a machine whose owner did not sign up to maintain a Node application.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/**
 * Anything that might carry the token is dropped before it is written.
 *
 * The connector's whole security value is that the credential stays in a file
 * on one machine. A log line is the easiest way for it to end up in a support
 * email instead.
 */
const SECRET_KEYS = /token|secret|password|authorization|commkey/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : value;
  }
  return out;
}

function write(level: LogLevel, event: string, message: string, fields: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;

  const parts = Object.entries(scrub(fields))
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${format(value)}`);

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event} ${message}${
    parts.length > 0 ? ` (${parts.join(' ')})` : ''
  }`;

  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function format(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  if (value instanceof Error) return JSON.stringify(value.message);
  return JSON.stringify(value) ?? String(value);
}

export const log = {
  debug: (event: string, message: string, fields: Record<string, unknown> = {}) =>
    write('debug', event, message, fields),
  info: (event: string, message: string, fields: Record<string, unknown> = {}) =>
    write('info', event, message, fields),
  warn: (event: string, message: string, fields: Record<string, unknown> = {}) =>
    write('warn', event, message, fields),
  error: (event: string, message: string, fields: Record<string, unknown> = {}) =>
    write('error', event, message, fields),
};
