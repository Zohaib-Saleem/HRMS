# HRMS attendance connector

Reads a ZKTeco terminal on the local network and posts what it read to the
HRMS.

It exists for one situation: a terminal on an office LAN the HRMS cannot reach,
whose firmware has no ADMS / Cloud Server option. Such a device cannot be
polled from the server (no route) and cannot push (no feature). Something on
that network has to do the reading, and this is that something.

**If the HRMS can reach the terminal directly, do not use this.** Register the
device as `ZKTeco (this server pulls over TCP)` and you have nothing to install
or maintain. If the firmware supports ADMS, use that instead. The connector is
the last resort, and it is worth being honest about why: it is one more program
on one more machine that somebody has to keep running.

## What it does, and what it deliberately does not

It is a courier. It sends the terminal's own wall-clock readings verbatim — no
instants, no timezone, no working day, no employee. Every interpretation stays
in the HRMS, where an administrator can correct a mis-set timezone from the
Devices page rather than by visiting whatever machine this runs on.

It listens on nothing. Every exchange is an outbound HTTPS request, so
installing it opens no port and needs no inbound firewall rule.

It cannot change anything on the terminal. There is no enrolment, no unlock, no
clock-set and no log-clearing, and the HRMS is given no way to ask for one — a
leaked connector token must not become a door that opens.

## Install

Requires Node 20 or later. The whole program is one file with no dependencies.

```bash
npm run connector:build          # produces apps/connector/dist/hrms-connector.mjs
```

Copy `dist/hrms-connector.mjs` and a `connector.config.json` to the machine, then:

- Linux: `deploy/hrms-connector.service`
- Windows: `deploy/install-windows.md`

## Configure

Three things cannot be discovered and must be given. Everything else the HRMS
tells it at startup.

```json
{
  "serverUrl": "https://hrms.example.com",
  "token": "the connector token from the device page in the HRMS",
  "deviceHost": "192.168.1.201"
}
```

| Setting | Environment variable | Default | |
|---|---|---|---|
| `serverUrl` | `HRMS_SERVER_URL` | — | **Required.** With or without the `/connector` suffix; both work |
| `token` | `HRMS_CONNECTOR_TOKEN` | — | **Required.** Set on the device's page in the HRMS |
| `deviceHost` | `HRMS_DEVICE_HOST` | — | **Required.** The terminal's LAN address |
| `devicePort` | `HRMS_DEVICE_PORT` | `4370` | |
| `commKey` | `HRMS_DEVICE_COMM_KEY` | none | Only if the terminal has one set |
| `deviceTimeoutMs` | `HRMS_DEVICE_TIMEOUT_MS` | `20000` | |
| `serverTimeoutMs` | `HRMS_SERVER_TIMEOUT_MS` | `30000` | |
| `fallbackPollMinutes` | `HRMS_FALLBACK_POLL_MINUTES` | `15` | Used only until the HRMS answers |
| `rosterEveryMinutes` | `HRMS_ROSTER_EVERY_MINUTES` | `360` | How often to re-read the enrolment list |
| `statePath` | `HRMS_STATE_PATH` | beside the program | Where the watermark is kept |
| `logLevel` | `HRMS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Environment variables win over the file, because a container's environment is
the thing an operator can actually change. The config file is optional; a
container can be configured entirely with variables and no file at all.

The **poll interval is not configured here.** It comes from *Sync every
(minutes)* on the device's page in the HRMS, so changing it takes effect on the
connector's next check-in without anyone going to the office.

## How it decides what to send

The connector keeps a watermark: the newest reading the HRMS has acknowledged,
as a device wall-clock string. Each poll it sends everything at or after it.

Two rules matter, and both are deliberate:

- **The watermark advances only after the HRMS acknowledges the batch.** Any
  other order trades a duplicate — which the server absorbs, because it
  fingerprints punches — for a gap, which nothing absorbs and nobody notices
  until payroll is wrong.
- **The comparison is inclusive.** A terminal can record two transactions in
  the same second, and an exclusive comparison would drop the second one
  forever the moment the first was acknowledged. The cost is re-sending the
  boundary second on every poll, which the server counts as one duplicate and
  discards.

Losing the state file is survivable. The connector asks the HRMS for a hint at
startup and the server deduplicates the rest; the file exists so the ordinary
case does not replay a terminal's whole history after every reboot.

## Reading the log

One line per event, with a name worth grepping for.

| Event | Meaning |
|---|---|
| `STARTED` / `STOPPED` | Normal lifecycle. `STOPPED` follows a SIGTERM from the service manager |
| `HANDSHAKE` | Configuration received. Shows the timezone and interval the HRMS handed out |
| `BATCH_SENT` | Records accepted, with the counts the HRMS reported |
| `NOTHING_NEW` | Healthy and quiet — the terminal holds nothing past the watermark |
| `UNMAPPED` | Punches stored but not attributed; somebody must map those PINs |
| `DEVICE_UNREACHABLE` | The terminal did not answer. A local problem: power, cable, address |
| `DEVICE_AUTH` | The terminal refused us. The comm key is wrong or was set on the device |
| `BATCH_FAILED` | The HRMS did not accept the batch. The message says why |
| `CONNECTOR_CLOCK_DRIFT` | *(logged by the HRMS)* The terminal clock is off. Set it at the terminal |

The token is never written to the log, in any event, at any level.

## When something is wrong

| Symptom | Cause |
|---|---|
| Exits immediately with code 78 | Not configured. It names the missing settings |
| `HANDSHAKE_FAILED` 401 | Wrong token, or the terminal's serial is not registered in the HRMS |
| `HANDSHAKE_FAILED` 403 | The device's *allowed networks* list does not include the office's **public** address — not the terminal's LAN address |
| `HANDSHAKE_FAILED` 409 | The device has no connector token set in the HRMS. An administrator must set one |
| `DEVICE_UNREACHABLE` | Terminal off, wrong `deviceHost`, or this machine is not on its network |
| `UNMAPPED` on every poll | The PINs are not mapped. **Device users** in the HRMS shows them by name once a roster has been sent |
| Nothing at all after a reboot | The service is not set to start at boot. See the deploy notes |

A failing poll backs off — doubling, capped at an hour — and keeps trying
forever. The connector never gives up on its own, because the machine it runs
on is one nobody wants to visit.

## Testing it without hardware

```bash
npx tsx scripts/audit-connector-agent.mjs
```

Runs the built bundle against a simulated terminal on a real socket and a stub
HRMS on a real port. No database, no API, nothing installed.

What it cannot prove: that a physical terminal yields these bytes. The
simulator and the connector share a protocol implementation, so a shared
misunderstanding of the firmware would pass here and fail on the wall.
