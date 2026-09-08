import { ConfigError, describeConfig, loadConfig, type ConnectorConfig } from './config.js';
import { VERSION, runCycle, type CycleContext } from './cycle.js';
import { log, setLogLevel } from './logger.js';
import { ServerClient } from './server-client.js';
import { loadState } from './state.js';

/**
 * The HRMS LAN connector.
 *
 * A terminal on an office network that the HRMS cannot reach, on firmware with
 * no ADMS option, can be integrated in exactly one way: something on that
 * network reads it and posts what it read. This is that something.
 *
 * It is a courier and nothing else. It sends the terminal's own wall-clock
 * readings verbatim - no instants, no timezone, no working day, no employee -
 * so every interpretation stays in the HRMS where an administrator can correct
 * it. Being wrong here can only ever mean being wrong about a byte.
 *
 * It listens on nothing. Every exchange is an outbound HTTPS request, so
 * installing it exposes no port and opens no hole in the office firewall.
 */

/** Waiting longer than this between polls would look like a dead connector. */
const MAX_BACKOFF_MINUTES = 60;

/** How often to re-ask the HRMS for its configuration. */
const HANDSHAKE_EVERY_MINUTES = 30;

function minutes(value: number): number {
  return Math.round(value * 60_000);
}

/**
 * How long to wait before the next poll.
 *
 * A healthy cycle uses the interval the HRMS handed out. A failure doubles the
 * wait, capped, and the two failures are counted separately: a terminal that
 * is switched off overnight and an internet link that is down are different
 * problems, and backing off one because of the other would either hammer a
 * device nobody is using or lose an hour of catching up once the link returns.
 */
function nextDelay(options: {
  pollMinutes: number;
  consecutiveFailures: number;
}): number {
  const { pollMinutes, consecutiveFailures } = options;
  if (consecutiveFailures === 0) return minutes(pollMinutes);

  const backoff = pollMinutes * 2 ** Math.min(consecutiveFailures, 6);
  return minutes(Math.min(backoff, MAX_BACKOFF_MINUTES));
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

async function run(config: ConnectorConfig, stopping: AbortSignal): Promise<void> {
  const context: CycleContext = {
    config,
    client: new ServerClient(config),
    state: loadState(config.statePath),
    handshake: null,
    handshakeDue: true,
    rosterDue: true,
  };

  log.info('STARTED', 'connector started', { version: VERSION, ...describeConfig(config) });
  if (context.state.cursor) {
    log.info('RESUMED', 'resuming from the saved watermark', { cursor: context.state.cursor });
  }

  let failures = 0;
  let lastHandshakeAt = 0;
  let lastRosterAt = context.state.rosterSentAt ? Date.parse(context.state.rosterSentAt) : 0;
  let pollMinutes = config.fallbackPollMinutes;

  while (!stopping.aborted) {
    const now = Date.now();
    context.handshakeDue = context.handshake === null || now - lastHandshakeAt >= minutes(HANDSHAKE_EVERY_MINUTES);
    context.rosterDue =
      !Number.isFinite(lastRosterAt) || lastRosterAt === 0 || now - lastRosterAt >= minutes(config.rosterEveryMinutes);

    let outcome;
    try {
      outcome = await runCycle(context);
    } catch (error) {
      // A cycle throwing is a bug in this program. It must not end the process:
      // an office PC that has to be visited to restart a service is exactly the
      // situation the connector exists to avoid.
      log.error('CYCLE_FAILED', 'the poll cycle failed unexpectedly', { error: String(error) });
      outcome = {
        pollMinutes: null,
        terminalReached: false,
        serverReached: false,
        handshook: false,
        sent: 0,
        duplicates: 0,
        unmapped: 0,
      };
    }

    if (outcome.handshook) lastHandshakeAt = Date.now();
    if (context.rosterDue && context.state.rosterSentAt) {
      lastRosterAt = Date.parse(context.state.rosterSentAt);
    }
    if (outcome.pollMinutes !== null) pollMinutes = outcome.pollMinutes;

    if (outcome.terminalReached && outcome.serverReached) {
      failures = 0;
    } else {
      failures += 1;
    }

    const delay = nextDelay({ pollMinutes, consecutiveFailures: failures });
    log.debug('SLEEPING', 'waiting for the next poll', {
      minutes: Math.round(delay / 60_000),
      failures,
    });
    await sleep(delay, stopping);
  }

  log.info('STOPPED', 'connector stopped', { cursor: context.state.cursor });
}

async function main(): Promise<void> {
  let config: ConnectorConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // The one failure worth exiting on. Everything else is retried forever,
      // but a connector with no address and no credential can never do
      // anything, and a service that restarts in a loop hides the reason.
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  setLogLevel(config.logLevel);

  const stopping = new AbortController();
  let stopped = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopped) {
        // A second one means somebody is not being asked twice.
        process.exit(130);
      }
      stopped = true;
      log.info('STOPPING', 'finishing the current poll, then exiting', { signal });
      stopping.abort();
    });
  }

  await run(config, stopping.signal);
}

main().catch((error: unknown) => {
  log.error('FATAL', 'the connector stopped unexpectedly', { error: String(error) });
  process.exit(1);
});
