# Device guide — ZKTeco integration

> ## The physical K50 has never been connected
>
> Both integrations are implemented and tested against a simulator that speaks
> the real ZKTeco protocol over a real TCP socket, and against synthetic ADMS
> posts over real HTTP. That is evidence the implementation is internally
> consistent and network-correct.
>
> It is **not** evidence that it matches your hardware. The test encoder and the
> application decoder share an author, so a shared misunderstanding of the
> firmware would pass every test and fail on the wall.
>
> **No claim of physical-device verification is made anywhere in this system.**
> The first connection to a real K50 is still ahead of you, and the
> [pending work](#what-is-still-pending) section says what to expect.

---

## 1. Three routes, and which one you need

| | Pull (`ZKTECO_TCP`) | Push (`ZKTECO_ADMS`) | Connector (`ZKTECO_LAN_CONNECTOR`) |
|---|---|---|---|
| Who opens the connection to the terminal | the server | nobody — it dials out | a connector on the terminal's LAN |
| Server needs a route to the device | **yes** | no | no |
| Works behind NAT or on mobile data | no | **yes** | **yes** |
| Needs ADMS-capable firmware | no | **yes** | no |
| Needs software installed on site | no | no | **yes** |
| Scheduled by | `syncIntervalMinutes` on the device | the device's own poll delay | `syncIntervalMinutes`, sent to the connector |
| Cursor / watermark | yes | not used | the connector keeps its own |
| "Test" and "Sync" buttons | shown | hidden — nothing to connect to | hidden — same reason |

All three land in the same place: raw punches in `attendance_raw_punches`,
paired into attendance records by the same engine. A day scored from a pushed
punch is indistinguishable from one scored from a polled punch.

Choose by elimination:

1. **Pull** if the terminal has a static LAN address this server can reach.
2. **Push** if it does not, but the firmware has a *Cloud Server* / *ADMS*
   setting.
3. **Connector** if neither — an office LAN the server cannot reach, on firmware
   with no ADMS option. Something has to be installed on that network, which is
   why it is the last resort rather than the default.

---

## 2. Registering a device

**Attendance → Devices → Add device.**

| Field | Required | Notes |
|---|---|---|
| Name | yes | Unique per company |
| IP address or hostname | yes | For push and connector devices this is recorded but never dialled from here |
| Port | yes | ZKTeco defaults to **4370** |
| Protocol | yes | Pull over TCP, ADMS push, or local connector |
| Device timezone | yes | The zone the **terminal's own clock** is set to |
| Serial number | pull: filled in by *Test*; **push and connector: required** | How an inbound caller identifies which device it is |
| Location | no | |
| Sync every (minutes) | pull and connector | Ignored for push; for a connector it is the schedule handed out at handshake |
| In/out detection | yes | First-in-last-out, or the direction the device reports |
| Comm key | no | Only if the terminal has one. Stored encrypted, never shown again |

> **Device timezone is not decoration.** Punches arrive as bare wall-clock
> readings. This setting is the only thing that turns those digits into an
> instant. Get it wrong and every imported time is silently shifted.

---

## 3. Pull synchronisation

1. Give the terminal a static LAN address.
2. Register it with protocol *ZKTeco (pull over TCP)*.
3. Press **Test connection** — this opens a real socket and reads the device's
   serial, name, firmware, platform, user count and transaction count. The
   serial is filled in for you.
4. Map device users to employees (below).
5. Sync happens automatically on the device's interval; **Sync** forces one.

### How the sync decides what to fetch

The ZKTeco protocol has **no server-side date filter** — the terminal returns
its whole log and the server narrows it. That is why the watermark lives in the
database rather than on the device.

- From the stored cursor, **less a 24-hour overlap**, so a back-dated punch
  written after the last sync is not stranded.
- On a first run, a bounded **30-day look-back** rather than the whole log.
- The cursor only advances past records that were **actually stored**. A failed
  import is retried on the next run rather than skipped.

### Reliability

Built before any hardware existed, because a terminal being unreachable is an
ordinary Tuesday:

- Bounded retry: **3 attempts**, backing off 500ms then 2000ms.
- Per-device lock, so a scheduled sync and a button press cannot run at once. A
  lock older than 15 minutes is treated as stale.
- Per-record isolation: one malformed transaction costs its own import and
  nothing else.
- Permanent failures (a record that can never be read) are distinguished from
  retryable ones, and only retryable failures hold the watermark back.
- A device that vanishes mid-transfer fails the run without advancing anything.
- Pushing devices are **excluded from the poll scheduler** — polling one would
  fail every interval and record a healthy terminal as broken.

---

## 4. ADMS push synchronisation

The terminal is told where the server is and posts on its own schedule.

### Server preparation

```
DEVICE_PUSH_ORIGIN=http://192.168.1.50:4000
API_HOST=0.0.0.0
```

`DEVICE_PUSH_ORIGIN` is the address terminals can reach — the machine's LAN
address, not `127.0.0.1`. Without it the endpoints still work; the devices
screen simply cannot show you the URL.

> **`API_HOST` defaults to `127.0.0.1`, which refuses connections from the
> network.** A terminal pointed at the LAN address gets connection refused
> however correct everything else is. This exposes the whole API on the LAN, so
> do it on a network you control and put a reverse proxy in front of it in
> production.

### Device setup

1. Register the device with protocol *ZKTeco ADMS (device pushes)*. **The
   serial number is required.**
2. Optionally set a push token and an allowed-networks list.
3. Copy the server address the form shows.
4. On the terminal, under *Comm → Cloud Server / ADMS* (wording varies by
   firmware), enter that address and port.
5. The device requests its configuration, then starts posting. First contact
   appears immediately in **Last contact**; batches appear in **Sync history**
   with a `PUSH` trigger.

### The endpoints

Mounted at the server root, not under `/api/v1`, because most firmware cannot
express a path prefix:

```
GET  /iclock/cdata?SN=<serial>&options=all     configuration handshake
POST /iclock/cdata?SN=<serial>&table=ATTLOG    attendance records
GET  /iclock/getrequest?SN=<serial>            pending commands — always none
POST /iclock/devicecmd?SN=<serial>             command results
```

Each also exists as `/iclock/<token>/...` for firmware whose server URL can
carry a path.

### The record format

Tab-separated, one record per line:

```
PIN <TAB> YYYY-MM-DD HH:mm:ss <TAB> status <TAB> verify <TAB> workcode
```

Everything after the timestamp is optional. Firmware that sends spaces instead
of tabs, `\r\n` line endings, or fewer fields than the specification promises is
handled. A line that cannot be read fails **on its own** — a terminal offline
for a week posts its whole backlog in one request, and one corrupt record must
not cost the other six days.

---

## 5. Connector synchronisation

For a terminal on an office LAN this server cannot reach, whose firmware has no
ADMS option. A small service — the connector — runs on a machine on that LAN. It
polls the terminal exactly the way pull synchronisation would, then posts what
it read over ordinary outbound HTTPS. Nothing on the office network is exposed.

The connector is a courier. It sends the terminal's raw wall-clock readings and
nothing derived from them, so the timezone, the pairing rule and the working day
are all still decided here. A mis-set device timezone is fixed on the Devices
page, not on a machine in another building.

### Server preparation

`DEVICE_PUSH_ORIGIN` must be set, as for ADMS, and for a connector reaching the
server across the internet it should be the public HTTPS address rather than a
LAN one. Without it the endpoints still work; the Devices screen simply cannot
show you the address to configure.

### Device setup

1. **Attendance → Devices → Add device**, protocol **ZKTeco via local
   connector**.
2. Fill in the terminal's LAN address and port, its **serial number**, and the
   timezone its own clock is set to.
3. Set a **connector token**. This one is not optional — see below.
4. Optionally set **allowed networks**. This restricts the address the
   *connector* posts from, which is the office's public address, not the
   terminal's LAN address. Getting these two confused blocks a correctly
   configured connector.
5. Save, reopen the device, and copy the **server address for the connector**.
6. Install the connector on a machine on that LAN and configure it with three
   things: that address, the token, and the terminal's LAN address. Everything
   else it asks the server for. It is a single file with no dependencies —
   `apps/connector/README.md` covers the settings, the service install for
   Linux and Windows, and what every log line means.

### What the connector is told, and what it keeps

At handshake the server hands over the device timezone, the poll interval from
**Sync every (minutes)**, and a hint at the latest reading already accounted
for. Changing the interval on the Devices page therefore changes the
connector's schedule at its next check-in — no visit required.

The hint is a hint. The connector keeps its own watermark; the server's exists
so that a connector reinstalled on a fresh machine does not replay years of
history the server would only deduplicate anyway.

A connector batch deliberately does **not** move the device's own pull cursor.
That watermark belongs to server-side polling, and advancing it here would let a
later direct poll skip records the connector never happened to send.

### Device users without a site visit

The connector reports the terminal's enrolment roster, so **Device users** shows
`1007 — AHMED` rather than a bare number. That list is a cache and nothing more:
it never creates a mapping, never creates an employee, and a name appearing or
disappearing on a terminal never changes whose attendance a punch became. Until
the connector has sent one, the screen says so rather than showing an empty list
you might mistake for "nobody is enrolled".

### Clock drift

A connector may report the terminal's clock alongside a batch. A gap of five
minutes or more against the server clock is logged as `CONNECTOR_CLOCK_DRIFT`.
Nothing is corrected automatically: a punch is evidence of when somebody was at
a door, and quietly shifting it would hide the very fact that explains why shift
boundaries are being missed. Set the terminal's clock.

### Why the token is mandatory here

A serial number is printed on the device case, so it identifies a device without
proving anything about the caller. For ADMS a token is optional because some
firmware genuinely cannot carry one. A connector is software that can hold a
secret in a config file, so there is no such excuse — and a connector device
with no token stored would be an unauthenticated ingest endpoint. It therefore
refuses every request with `409` and a message saying exactly that, until a
token is set.

---

## 6. Security

The ADMS and connector routes carry no session — the caller is a terminal or a
service, not a signed-in person — so they are the only routes in the system
whose entire security boundary is what they check themselves. Worth being
explicit about.

| Control | ADMS push | Local connector |
|---|---|---|
| **Serial number** | Required; must match a registered, enabled device on that protocol. Printed on the case — an identifier, not a secret | Same, and checked *alongside* the token: it is what catches a connector pointed at the wrong terminal in an office with two of them |
| **Token** | Optional but recommended. Carried as a path segment, because that is the only place the firmware can put one. Once set, the untokened path stops working | **Mandatory.** Carried as `Authorization: Bearer`. A device with none refuses everything with `409` rather than accepting anonymous records |
| **Allowed networks** | Optional IPv4 addresses or CIDR ranges; anything else is refused with 403 and nothing is stored | Same, but matched against the office's **public** address, not the terminal's LAN address |

Both tokens are stored encrypted (AES-256-GCM) and are write-only: no endpoint
returns one except the device URL shown to an administrator holding
`device.manage`, who is the person who has to configure the hardware with it.
Both are redacted from request logs — the ADMS one out of the URL path, the
connector one out of the `Authorization` header.

An unknown serial and a wrong token produce an **identical** `401 Unauthorized`
with no detail, so probing tells an attacker nothing about which half was wrong.

**What these endpoints deliberately cannot do:** read attendance back out, list
devices or employees, create employees, or accept a command for a device to
run. `getrequest` always answers "nothing to do", and the connector is given no
command channel at all — remote unlock, enrolment and log-clearing are exactly
the operations that would turn an HRMS bug into a door that opens.

Device-management APIs are `device.manage` only. Employees can never add a
device, change an IP, trigger a command, download another employee's raw data,
or change a mapping.

---

## 7. Device user mapping

A terminal knows people by a numeric ID it calls a PIN. The HRMS knows them by
employee record. **Device users → Map** connects the two.

- **Attendance → Devices → Device users** lists what the terminal holds (pull
  devices) plus everything already mapped.
- For a push device the terminal cannot be queried, so the list shows mappings
  only. Unknown IDs surface as unmapped punches.

**An unmapped punch is stored, counted and reported — never discarded.** Once
the mapping is added, **Reprocess** turns the stored punches into attendance.

> No employee is ever created automatically from an unknown device user. That
> would let anyone who can enrol a finger create a person in the HRMS.

A mapping can also be created from the other end: **People → Add employee →
Attendance → Punch code** writes through this same service, so a new joiner's
PIN is recorded while the record is being made rather than on a second visit
here. It offers no effective date and refuses a PIN somebody else holds —
handing a code over is a dated decision and stays on this screen. Both routes
need `device.manage`.

---

## 8. Sync history and diagnostics

**Attendance → Devices → Sync history** shows one row per run:

| Column | Meaning |
|---|---|
| Started | When the run began |
| Result | Success, Partial, Failed, Running |
| Fetched | Records the device offered |
| New | Records stored |
| Dup | Already-known records, ignored |
| Unmapped | Stored, but belonging to nobody yet |
| Failed | Records that could not be read |
| Trigger | Scheduled, Manual, Startup, or **Push** |

A partial run keeps up to 20 per-record failures with a reason and a
permanent/retryable flag.

### Duplicate protection

Every punch gets a SHA-256 fingerprint over the device, the user ID and the
reading. A unique index on `(deviceId, fingerprint)` makes a repeat a
**counted duplicate, never an error**. Re-syncing the same window, or a device
resending a batch it did not get an acknowledgement for, is harmless.

### Failed sync

The device is marked `ERROR` with the reason on the record. The cursor does not
move. The next scheduled tick retries. One terminal being down never stops the
loop for the others.

---

## 9. What is implemented

- Device registry with encrypted comm keys and push tokens
- Pull over the ZKTeco standalone SDK protocol (TCP 4370): framing, session
  handshake, comm-key auth, chunked bulk transfer, packed time format
- ADMS push: handshake, ATTLOG ingest, command poll, command result
- LAN connector ingest: handshake, punch batches, enrolment roster cache, and
  clock-drift reporting, authenticated by bearer token plus serial number
- The on-site connector itself (`apps/connector`): a single-file agent that
  polls a terminal over the LAN and posts what it read, with a watermark that
  advances only on acknowledgement
- Device user listing and mapping; reprocessing after a mapping is added
- Cursor watermark with overlap, bounded retry, per-device locking
- Idempotent import with fingerprint deduplication
- Sync history with per-record diagnostics
- Raw punch browser (read-only)
- Timezone-correct conversion from device wall clock to instant

## What is still pending

**The physical K50 has not been connected.** When it is, expect to verify:

1. **The serial number matches** what the device reports versus what is printed
   on the case.
2. **The comm key**, if the terminal has one set.
3. **The packed time format.** The encoder was hand-computed against the
   protocol specification. A one-field misunderstanding would shift every
   reading by a constant amount — obvious once you look, invisible until you do.
4. **The user-ID format.** Some firmware pads PINs; some does not.
5. **The ADMS handshake keys.** A terminal that gets a shape it does not expect
   logs a parse error and, on some models, stops pushing entirely.
6. **Punch direction reporting**, which decides whether `DEVICE_STATE` pairing
   is usable or whether first-in-last-out is the only workable mode.

None of these can be settled without the hardware.

---

## 10. Raw device punches

**Attendance → Device punches.** Read-only, `device.read`.

| Field | Meaning |
|---|---|
| Device | Which terminal sent it |
| Device user ID | The PIN the terminal knows |
| Employee | The mapped person, or blank |
| Raw timestamp | **Exactly what the device said**, as text |
| Device timezone | The zone used to interpret it |
| Punched at | The resulting instant, in UTC |
| Local day key | The company-local working day it was assigned to |
| Punch state / verify mode | As reported, when reported |
| Processed at | When it was folded into an attendance record |

### Why raw punches must not be edited

They are the **evidence**. The attendance record is an interpretation of them;
the payslip is an interpretation of that. Editing a punch would break the chain
between what a terminal actually recorded and what somebody was paid, and there
would be no way to tell afterwards which figures had been derived and which had
been typed.

There is deliberately **no edit or delete endpoint** for a raw punch. To change
what a day means, correct the *attendance record* — that is what the correction
workflow and `source: ADMIN` are for. The punch stays underneath, unchanged.

Raw punches are also never deleted for being old.
