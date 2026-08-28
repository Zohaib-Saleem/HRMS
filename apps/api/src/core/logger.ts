/**
 * A logger that background work can reach.
 *
 * Fastify owns the real logger and hands it to request handlers, but the device
 * sync also runs from a timer where there is no request. Rather than
 * instantiating a second pino - which would log with different settings to a
 * different stream - the application registers Fastify's own logger here at
 * boot, and everything else writes through this.
 *
 * Until that happens, calls fall through to the console, so a module imported
 * by a script or a migration still logs rather than throwing.
 */

export interface Logger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
  debug(details: Record<string, unknown>, message: string): void;
}

const fallback: Logger = {
  /* eslint-disable no-console */
  info: (details, message) => console.log(message, details),
  warn: (details, message) => console.warn(message, details),
  error: (details, message) => console.error(message, details),
  // Debug is per-record and would be thousands of lines on a large sync, so it
  // is dropped unless a real logger with a level is installed.
  debug: () => undefined,
  /* eslint-enable no-console */
};

let current: Logger = fallback;

/** Called once at boot with the application's own logger. */
export function useLogger(next: Logger): void {
  current = next;
}

export const logger: Logger = {
  info: (details, message) => current.info(details, message),
  warn: (details, message) => current.warn(details, message),
  error: (details, message) => current.error(details, message),
  debug: (details, message) => current.debug(details, message),
};
