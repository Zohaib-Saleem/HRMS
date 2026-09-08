/**
 * Audit: the on-site connector.
 *
 * Runs the connector against a simulated terminal on a real socket and a stub
 * HRMS on a real HTTP port. Nothing here touches the database or the API - the
 * server's half of the contract is `audit-connector.mjs`; this is the other
 * half, and it can run on a laptop with nothing installed.
 *
 * Three layers, cheapest first: the watermark rules as pure functions, then the
 * poll cycle driven directly so it can be stepped, then the built bundle
 * launched as a real process, because a program that typechecks and a program
 * that starts are different claims.
 *
 *   npx tsx scripts/audit-connector-agent.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSimulator } from './zkt-simulator.mjs';
import { runCycle, selectPending } from '../apps/connector/src/cycle.ts';
import { ServerClient } from '../apps/connector/src/server-client.ts';
import { loadState } from '../apps/connector/src/state.ts';
import { setLogLevel } from '../apps/connector/src/logger.ts';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} (${JSON.stringify(actual)})`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

const truthy = (label, actual) => check(label, Boolean(actual), true);
const section = (title) => console.log(`\n################ ${title} ################`);

const DEVICE_PORT = 14370;
const SERVER_PORT = 14400;
const SERIAL = 'SIM0123456789';
const TOKEN = 'audit-agent-token';

/** Attendance the simulated terminal holds, deliberately out of order. */
const clockAt = (day, hour, minute, second) => ({
  year: 2026,
  month: 5,
  day,
  hour,
  minute,
  second,
});

const PUNCHES = [
  { uid: 1, deviceUserId: '1007', status: 1, punch: 1, clock: clockAt(11, 18, 2, 9) },
  { uid: 1, deviceUserId: '1007', status: 1, punch: 0, clock: clockAt(11, 8, 55, 30) },
  { uid: 2, deviceUserId: '1008', status: 1, punch: 0, clock: clockAt(11, 9, 1, 12) },
  // Two transactions in the same second, which is what makes an exclusive
  // watermark comparison lose a punch.
  { uid: 2, deviceUserId: '1008', status: 1, punch: 1, clock: clockAt(11, 17, 30, 0) },
  { uid: 1, deviceUserId: '1009', status: 1, punch: 1, clock: clockAt(11, 17, 30, 0) },
];

/** Everything the stub HRMS was asked to do, for asserting on afterwards. */
const received = { handshakes: [], batches: [], rosters: [], auth: [], paths: [] };
let nextBatchStatus = 200;

function stubHrms(port) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      received.auth.push(request.headers.authorization ?? null);
      received.paths.push(url.pathname);

      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(text);
      };

      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(401, { error: { message: 'This connector is not registered.' } });
      }

      if (url.pathname === '/connector/handshake') {
        received.handshakes.push(url.searchParams.get('serialNumber'));
        return send(200, {
          data: {
            deviceId: 'dev_1',
            deviceName: 'Simulated terminal',
            serialNumber: SERIAL,
            timeZone: 'Asia/Karachi',
            pollIntervalMinutes: 1,
            cursorHint: null,
            serverTime: new Date().toISOString(),
          },
        });
      }

      if (url.pathname === '/connector/punches') {
        if (nextBatchStatus !== 200) {
          const status = nextBatchStatus;
          nextBatchStatus = 200;
          return send(status, { error: { message: 'refused for the audit' } });
        }
        received.batches.push(body);
        return send(200, {
          data: {
            received: body.punches.length,
            imported: body.punches.length,
            duplicates: 0,
            unmapped: 0,
            errors: 0,
            recalculatedDays: 0,
            syncId: body.punches.length > 0 ? 'sync_1' : null,
            cursorHint: null,
          },
        });
      }

      if (url.pathname === '/connector/roster') {
        received.rosters.push(body);
        return send(200, {
          data: { received: body.users.length, stored: body.users.length, unmapped: 0 },
        });
      }

      return send(404, { error: { message: 'no such endpoint' } });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

let simulator = null;
let hrms = null;
let home = null;

try {
  setLogLevel('warn');
  home = mkdtempSync(join(tmpdir(), 'hrms-connector-audit-'));

  section('WATERMARK RULES');

  {
    const readings = [
      { deviceUserId: '1', rawTimestamp: '2026-05-11 08:00:00', punchState: 'IN', verifyMode: null },
      { deviceUserId: '2', rawTimestamp: '2026-05-11 17:00:00', punchState: 'OUT', verifyMode: null },
      { deviceUserId: '3', rawTimestamp: '2026-05-11 12:00:00', punchState: null, verifyMode: null },
    ];

    check('with no watermark, everything is pending', selectPending(readings, null).length, 3);
    check(
      'and it comes back in chronological order, whatever the device said',
      selectPending(readings, null).map((r) => r.rawTimestamp),
      ['2026-05-11 08:00:00', '2026-05-11 12:00:00', '2026-05-11 17:00:00'],
    );

    const fromNoon = selectPending(readings, '2026-05-11 12:00:00');
    // Inclusive on purpose: a terminal can record two transactions in the same
    // second, and an exclusive comparison drops the second one forever.
    check('the watermark second is re-sent, not skipped', fromNoon.length, 2);
    check('starting at the watermark itself', fromNoon[0].rawTimestamp, '2026-05-11 12:00:00');

    check('a watermark past everything leaves nothing', selectPending(readings, '2026-05-12 00:00:00').length, 0);
  }

  {
    const bad = [
      { deviceUserId: '', rawTimestamp: '2026-05-11 08:00:00', punchState: null, verifyMode: null },
      { deviceUserId: '1', rawTimestamp: 'not a time', punchState: null, verifyMode: null },
      { deviceUserId: '2', rawTimestamp: '2026-05-11 09:00:00', punchState: null, verifyMode: null },
    ];
    // Screened here so the server never has to refuse a whole batch over one
    // unusable record.
    check('records the server would refuse are dropped locally', selectPending(bad, null).length, 1);
  }

  section('FIXTURES');

  simulator = await startSimulator({ port: DEVICE_PORT, punches: PUNCHES, clock: clockAt(11, 18, 5, 0) });
  hrms = stubHrms(SERVER_PORT);
  await once(hrms, 'listening');
  truthy('a simulated terminal is listening', true);

  const config = {
    serverUrl: `http://127.0.0.1:${SERVER_PORT}/connector`,
    token: TOKEN,
    deviceHost: '127.0.0.1',
    devicePort: DEVICE_PORT,
    commKey: null,
    deviceTimeoutMs: 5000,
    serverTimeoutMs: 5000,
    fallbackPollMinutes: 1,
    rosterEveryMinutes: 360,
    statePath: join(home, 'state.json'),
    logLevel: 'warn',
  };

  const context = {
    config,
    client: new ServerClient(config),
    state: { cursor: null, rosterSentAt: null, deviceSerial: null },
    handshake: null,
    handshakeDue: true,
    rosterDue: true,
  };

  section('FIRST CYCLE');

  {
    const outcome = await runCycle(context);

    truthy('the terminal was reached', outcome.terminalReached);
    truthy('the HRMS was reached', outcome.serverReached);
    check('it handshook with the serial the terminal reported', received.handshakes, [SERIAL]);
    check('the poll interval came from the HRMS', outcome.pollMinutes, 1);
    check('the roster was sent', received.rosters.length, 1);
    check('with the users the terminal holds', received.rosters[0].users.length, 2);

    check('one batch was sent', received.batches.length, 1);
    check('carrying every reading', received.batches[0].punches.length, PUNCHES.length);
    check('in chronological order', received.batches[0].punches[0].rawTimestamp, '2026-05-11 08:55:30');
    check('the last being the newest', received.batches[0].punches[4].rawTimestamp, '2026-05-11 18:02:09');
    check('the PIN is passed through untouched', received.batches[0].punches[0].deviceUserId, '1007');
    // The connector must not interpret. IN/OUT naming is the shared package's,
    // so a connector punch and a polled punch are identical to the server.
    check('the direction is named the way the server names it', received.batches[0].punches[0].punchState, 'IN');
    check('the terminal clock is reported for drift', received.batches[0].deviceTime, '2026-05-11 18:05:00');
    truthy('a connector version is reported', Boolean(received.batches[0].connectorVersion));

    check('the watermark advanced to the newest acknowledged reading', context.state.cursor, '2026-05-11 18:02:09');
    check('and was written to disk', loadState(config.statePath).cursor, '2026-05-11 18:02:09');
    check('and the serial was remembered', loadState(config.statePath).deviceSerial, SERIAL);
  }

  section('SECOND CYCLE');

  {
    received.batches.length = 0;
    context.handshakeDue = false;
    context.rosterDue = false;

    const outcome = await runCycle(context);

    truthy('the cycle succeeded', outcome.terminalReached && outcome.serverReached);
    check('the roster was not re-read', received.rosters.length, 1);
    check('the HRMS was still contacted', received.batches.length, 1);
    // Only the boundary second, which the server deduplicates. This is the
    // cost of an inclusive watermark, and it is one duplicate per poll.
    check('only the watermark second is re-sent', received.batches[0].punches.length, 1);
    check('and it is the boundary reading', received.batches[0].punches[0].rawTimestamp, '2026-05-11 18:02:09');
  }

  section('A NEW PUNCH ARRIVES');

  {
    received.batches.length = 0;
    simulator.addPunches([
      { uid: 1, deviceUserId: '1007', status: 1, punch: 0, clock: clockAt(12, 8, 45, 0) },
    ]);

    await runCycle(context);

    check('the new reading is sent', received.batches[0].punches.length, 2);
    check('and the watermark follows it', context.state.cursor, '2026-05-12 08:45:00');
  }

  section('THE HRMS IS DOWN');

  {
    received.batches.length = 0;
    const before = context.state.cursor;
    nextBatchStatus = 503;

    const outcome = await runCycle(context);

    check('the cycle reports the HRMS as unreached', outcome.serverReached, false);
    // The single rule everything else follows from: no acknowledgement, no
    // advance. A duplicate is absorbed by the server; a gap is not.
    check('the watermark did not move', context.state.cursor, before);
    check('and the saved watermark did not move either', loadState(config.statePath).cursor, before);
  }

  section('THE TERMINAL IS DOWN');

  {
    const before = context.state.cursor;
    await simulator.close();
    simulator = null;

    const outcome = await runCycle(context);

    check('the cycle reports the terminal as unreached', outcome.terminalReached, false);
    check('nothing was sent', outcome.sent, 0);
    check('and the watermark did not move', context.state.cursor, before);

    simulator = await startSimulator({ port: DEVICE_PORT, punches: PUNCHES, clock: clockAt(11, 18, 5, 0) });
  }

  section('A WRONG TOKEN');

  {
    const rejected = { ...config, token: 'not-the-token' };
    const rejectedContext = {
      ...context,
      config: rejected,
      client: new ServerClient(rejected),
      state: { cursor: null, rosterSentAt: null, deviceSerial: null },
      handshake: null,
      handshakeDue: true,
    };

    const outcome = await runCycle(rejectedContext);
    check('nothing is sent with a rejected credential', outcome.sent, 0);
    check('and no watermark is invented', rejectedContext.state.cursor, null);
    // Reported as a failed exchange, not a successful one, so the caller backs
    // off. A connector with a wrong token that kept its normal interval would
    // knock on the door every poll for as long as it was left running.
    check('and the cycle counts as a failure so the caller backs off', outcome.serverReached, false);
  }

  section('THE BUILT BUNDLE STARTS');

  {
    const bundle = 'apps/connector/dist/hrms-connector.mjs';
    if (!existsSync(bundle)) {
      fail += 1;
      console.log(`  FAIL  the bundle exists at ${bundle} - run: npm run connector:build`);
    } else {
      received.batches.length = 0;
      const stateFile = join(home, 'spawned.json');

      // The real artifact, configured the way a service install configures it:
      // environment only, no config file anywhere.
      const child = spawn(process.execPath, [bundle], {
        env: {
          ...process.env,
          HRMS_CONNECTOR_CONFIG: join(home, 'does-not-exist.json'),
          HRMS_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
          HRMS_CONNECTOR_TOKEN: TOKEN,
          HRMS_DEVICE_HOST: '127.0.0.1',
          HRMS_DEVICE_PORT: String(DEVICE_PORT),
          HRMS_STATE_PATH: stateFile,
          HRMS_LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk.toString()));
      child.stderr.on('data', (chunk) => (output += chunk.toString()));

      // Long enough for one cycle - connect, read, handshake, roster, post -
      // and no longer: the poll interval is a minute and this suite is not.
      const finished = await Promise.race([
        new Promise((resolve) => {
          const timer = setInterval(() => {
            if (output.includes('BATCH_SENT')) {
              clearInterval(timer);
              resolve(true);
            }
          }, 100);
          setTimeout(() => {
            clearInterval(timer);
            resolve(false);
          }, 20000);
        }),
        once(child, 'exit').then(() => false),
      ]);

      truthy('the bundle ran a full cycle', finished);
      if (!finished) console.log(`        output was:\n${output}`);

      // A courteous shutdown, which is what a service manager sends.
      child.kill('SIGTERM');
      await once(child, 'exit');

      truthy('it logged a clean stop', output.includes('STOPPED'));
      truthy('the credential never appears in its output', !output.includes(TOKEN));
      check('it posted a batch', received.batches.length >= 1, true);
      // The child was given the bare origin, with no /connector on the end -
      // which is what half the people pasting the address from the Devices
      // page will do. The stub serves nothing else, so a batch arriving here
      // is the proof that it was normalised.
      check(
        'the bare origin was normalised to the connector path',
        received.paths.includes('/connector/punches'),
        true,
      );
      truthy('and it saved a watermark', existsSync(stateFile) && Boolean(JSON.parse(readFileSync(stateFile, 'utf8')).cursor));
    }
  }

  section('CONFIGURATION FAILURES');

  {
    const child = spawn(process.execPath, ['apps/connector/dist/hrms-connector.mjs'], {
      env: {
        PATH: process.env.PATH,
        HRMS_CONNECTOR_CONFIG: join(home, 'does-not-exist.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    const [code] = await once(child, 'exit');

    // The one failure worth exiting on: no address and no credential means it
    // can never do anything, and a service restarting in a loop hides why.
    check('an unconfigured connector exits rather than looping', code, 78);
    truthy('and names every missing setting', output.includes('serverUrl') && output.includes('token') && output.includes('deviceHost'));
  }
} catch (error) {
  fail += 1;
  console.error('\nSUITE ABORTED:', error);
} finally {
  if (simulator) await simulator.close();
  if (hrms) await new Promise((resolve) => hrms.close(resolve));
  if (home) rmSync(home, { recursive: true, force: true });
}

console.log(`\n################ SUMMARY ################`);
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
