# Attendance terminals

The HRMS talks to biometric terminals in three ways, and which one applies is a
property of the device and its network, not a setting you can flip later without
also reconfiguring something on site.

| | Pull (`ZKTECO_TCP`) | Push (`ZKTECO_ADMS`) | Connector (`ZKTECO_LAN_CONNECTOR`) |
|---|---|---|---|
| Who opens the connection to the terminal | the server | nobody — it dials out | a connector on the terminal's LAN |
| Needs a route from the server to the device | yes | no | no |
| Works behind NAT / on mobile data | no | yes | yes |
| Needs ADMS-capable firmware | no | yes | no |
| Needs something installed on site | no | no | yes |
| Scheduled by | `syncIntervalMinutes` | the device's own poll delay | `syncIntervalMinutes`, sent to the connector |
| Cursor / watermark | yes | not used | the connector keeps its own |
| "Test" and "Sync" buttons | yes | hidden — there is nothing to connect to | hidden — same reason |

Pick by elimination. Pull if this server can open a socket to the terminal.
Otherwise push, if the firmware has a Cloud Server / ADMS setting. The connector
is for what is left: a terminal on an office LAN this server cannot reach, on
firmware with no ADMS option at all.

All three end up in exactly the same place: raw punches in
`attendance_raw_punches`, paired into `attendance_records` by the same policy
engine. A day scored from a pushed punch is indistinguishable from one scored
from a polled punch, which is deliberate — there is one attendance pipeline,
not three. It is also load-bearing: the same transaction arriving by two routes
must land on the same fingerprint, or it would be counted twice under two
identities.

## Pull setup (ZKTECO_TCP)

1. Give the device a static address on the LAN.
2. Add it in **Attendance → Devices** with its IP, port (4370 by default) and
   the timezone the terminal's own clock is set to.
3. Press **Test connection**. The serial number is filled in from the device.
4. Map device user IDs to employees under **Device users**.

## Push setup (ZKTECO_ADMS)

An ADMS terminal is told where the server is and posts to it on its own
schedule. Nothing needs to be able to reach the device.

1. Set `DEVICE_PUSH_ORIGIN` in the server environment to an address the
   terminal can actually reach — the machine's LAN address, not `127.0.0.1`:

   ```
   DEVICE_PUSH_ORIGIN=http://192.168.1.50:4000
   ```

   Without it the endpoints still work; the devices screen simply cannot show
   you the URL to type in.

   **The API must also be listening on that address.** `API_HOST` defaults to
   `127.0.0.1`, which accepts nothing from the network, so a terminal pointed at
   the LAN address gets connection refused however correct the rest of the
   configuration is. Set:

   ```
   API_HOST=0.0.0.0
   ```

   This exposes the whole API on the LAN, not just `/iclock`, so do it on a
   network you control and put a reverse proxy in front of it in production.

2. Add the device in **Attendance → Devices** with protocol
   *ZKTeco ADMS (device pushes)*. The **serial number is required** — it is the
   only thing the device sends to identify itself, so a device whose serial is
   not registered is refused.

3. Optionally set a **push token** and **allowed networks** (see below), then
   copy the server address the form shows.

4. On the terminal, under *Comm → Cloud Server / ADMS* (wording varies by
   firmware), set the server address and port to the values from step 3 and
   enable the domain/URL option if the token path is used.

5. The device requests its configuration, then starts posting. Its first
   contact appears immediately in the **Last contact** column; batches appear
   in **Sync history** with a `PUSH` trigger.

6. Map device user IDs to employees. Punches from an unmapped user are stored
   and counted as unmapped rather than discarded — once the mapping is added,
   **Reprocess** turns them into attendance.

### Endpoints

Mounted at the server root, not under `/api/v1`, because most firmware cannot
express a path prefix:

```
GET  /iclock/cdata?SN=<serial>&options=all     configuration handshake
POST /iclock/cdata?SN=<serial>&table=ATTLOG    attendance records
GET  /iclock/getrequest?SN=<serial>            pending commands (always none)
POST /iclock/devicecmd?SN=<serial>             command results
```

Each also exists as `/iclock/<token>/...` for firmware that lets the server URL
carry a path.

### Security model

These are the only unauthenticated routes in the system, so it is worth being
explicit about what protects them.

- **Serial number.** Required, and must match a registered, enabled device
  whose protocol is ADMS. A serial is printed on the device's case, so treat it
  as an identifier, not a secret.
- **Push token.** Optional but recommended. Stored encrypted, write-only
  everywhere except the URL shown to an administrator holding `device.manage`.
  Once set, the untokened path stops working for that device. The token is
  redacted from request logs.
- **Allowed networks.** Optional IPv4 addresses or CIDR ranges. When set, a
  push from any other source is refused with 403 and nothing is stored.

An unknown serial and a wrong token produce an identical `401 Unauthorized`
with no detail, so probing tells an attacker nothing about which half was
wrong.

What these endpoints deliberately cannot do: read attendance back out, list
devices or employees, create employees, or accept a command for a device to
run. `getrequest` always answers "nothing to do" — remote unlock, enrolment and
log-clearing are exactly the operations that would turn an HRMS bug into a door
that opens.

### Record format

Tab-separated, one record per line:

```
PIN <TAB> YYYY-MM-DD HH:mm:ss <TAB> status <TAB> verify <TAB> workcode
```

Everything after the timestamp is optional. Firmware that sends spaces instead
of tabs, `\r\n` line endings, or fewer fields than the specification promises
is handled. A line that cannot be read fails on its own: a terminal that has
been offline for a week posts its whole backlog in one request, and one corrupt
record must not cost the other six days. Unreadable lines are counted, kept in
the sync history with a reason, and marked permanent — resending will not make
them readable.

### Timezones

The device sends wall-clock readings with no offset. The device's configured
timezone is the only thing that turns those digits into an instant, so a wrong
timezone silently shifts every record it sends. The *company* timezone, not the
device's, decides which working day a punch belongs to — a terminal in another
zone still contributes to the working day the company is having.

## Connector setup (ZKTECO_LAN_CONNECTOR)

For a terminal that can neither be reached from here nor be made to push: a
small service runs on a machine on the terminal's own LAN, polls it exactly the
way the pull adapter would, and posts what it read over ordinary outbound
HTTPS. Nothing on the office network needs to be exposed to the internet.

The connector is a courier and nothing more. It sends the terminal's own
wall-clock readings verbatim — no instants, no timezone, no working day — so
every interpretation stays here, and a mis-set device timezone is fixed on the
Devices page rather than on a machine in another building.

1. Set `DEVICE_PUSH_ORIGIN` as for ADMS above. It is the address the connector
   posts to, so for a connector across the internet it is the server's public
   HTTPS address rather than a LAN one.
2. Add the device in **Attendance → Devices** with protocol **ZKTeco via local
   connector**. Fill in the terminal's LAN address and port for the record, its
   serial number, and the timezone its clock is set to.
3. Set a **connector token**. Unlike ADMS this is not optional: a connector
   device with no token stored refuses every request with `409`, because
   treating a missing credential as "no credential required" would turn a
   half-finished setup into an open ingest endpoint.
4. Optionally set **allowed networks** to the office's public address. Note this
   is the address the *connector* posts from, not the terminal's LAN address.
5. Install the connector — `apps/connector`, built with `npm run
   connector:build` into a single file with no runtime dependencies — on a
   machine on that LAN, and give it three things: the server address shown on
   the device form, the token, and the terminal's address. Everything else —
   timezone, poll interval, how far back to start — it gets from the handshake.
   See `apps/connector/README.md` for the settings and the service install.
6. Map device user IDs to employees under **Device users**. The connector sends
   the terminal's enrolment roster, so the PINs arrive with the names typed into
   the terminal beside them rather than as bare numbers.

### Endpoints

All three take `Authorization: Bearer <connector token>` and speak JSON.

```
GET  /connector/handshake?serialNumber=<serial>   configuration
POST /connector/punches                           a batch of readings
POST /connector/roster                            the enrolment list
```

`handshake` answers with the device timezone, the poll interval to use, and a
`cursorHint` — the latest reading the server has already accounted for, as a
device wall-clock string. It is a hint, never an instruction: the connector
keeps its own watermark, and this exists so a connector reinstalled on a fresh
machine does not replay years of history the server would only deduplicate.

`punches` takes at most 1000 records per batch. A connector catching up after a
long outage must send several batches rather than one enormous request — a batch
too big to finish is a batch that is retried forever. Each record is a PIN, a
`YYYY-MM-DD HH:mm:ss` reading, and optionally the direction, verify mode and the
device's transaction id. The response reports what happened to the batch,
including duplicates and unmapped PINs, and carries the new `cursorHint`.

`roster` replaces the stored enrolment list wholesale, including deleting users
the terminal no longer holds — a stale roster is worse than a short one, because
it invites somebody to map a PIN that no longer exists. The roster is a cache
for the mapping screen and nothing else: it never creates a mapping, never
creates an employee, and never changes whose attendance a punch became.

### Security model

- **Two credentials, both checked.** The bearer token proves the caller is a
  connector this company set up; the serial number, read off the terminal over
  the LAN, proves it is pointed at the terminal it claims. The token alone would
  authenticate a connector aimed at the wrong terminal — a real mistake in an
  office with two of them, and one that would file one department's punches
  under another's device.
- **No token stored means refuse.** `409` with a message saying so, because the
  person reading the connector's log is the administrator who has not finished
  the setup.
- **Allowed networks** work exactly as they do for ADMS, against the address the
  connector posts from.
- An unknown serial and a wrong token both produce a bare `401`, so probing
  serials teaches a caller nothing.

As with ADMS, there is no endpoint here that reads attendance back out, lists
devices, or hands the connector something to do on the terminal. A connector
reports what it read; that is the whole relationship.

### Clock drift

The batch may carry `deviceTime`, the connector's reading of the terminal clock.
It is compared with the server clock and logged as `CONNECTOR_CLOCK_DRIFT` when
they differ by five minutes or more. It is never used to correct a reading: a
punch is evidence of when somebody was at a door, and silently shifting it would
hide the one fact that explains why a shift boundary is being missed.

### What is not advanced

A connector batch deliberately does not move `syncCursorAt`. That watermark
belongs to the server-side pull, and moving it from here would let a later
direct poll skip records the connector never happened to send.

## Testing without hardware

```bash
npx dotenv -e .env -- npx tsx scripts/audit-adms.mjs
npx dotenv -e .env -- npx tsx scripts/audit-connector.mjs
npx tsx scripts/audit-connector-agent.mjs
```

The first two drive the real HTTP endpoints exactly as a terminal or a
connector would, and check the database afterwards. The third is the other side
of the same contract: it runs the built connector against
`scripts/zkt-simulator.mjs`, which speaks the standalone SDK protocol over a
real socket, and a stub HRMS, so it needs neither a database nor the API.

None of them proves the format matches a physical device: the test encoder and
the application decoder share an author, so a shared misunderstanding of the
firmware would pass here and fail on the wall.
