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

## 1. Two directions, and which one you need

| | Pull (`ZKTECO_TCP`) | Push (`ZKTECO_ADMS`) |
|---|---|---|
| Who opens the connection | the server | the device |
| Server needs a route to the device | **yes** | no |
| Works behind NAT or on mobile data | no | **yes** |
| Scheduled by | `syncIntervalMinutes` on the device | the device's own poll delay |
| Cursor / watermark | yes | not used |
| "Test" and "Sync" buttons | shown | hidden — nothing to connect to |

Both land in the same place: raw punches in `attendance_raw_punches`, paired
into attendance records by the same engine. A day scored from a pushed punch is
indistinguishable from one scored from a polled punch.

**Choose pull** if the terminal has a static LAN address the server can reach.
**Choose push** if it does not.

---

## 2. Registering a device

**Attendance → Devices → Add device.**

| Field | Required | Notes |
|---|---|---|
| Name | yes | Unique per company |
| IP address or hostname | yes | For push devices this is recorded but not dialled |
| Port | yes | ZKTeco defaults to **4370** |
| Protocol | yes | Pull over TCP, or ADMS push |
| Device timezone | yes | The zone the **terminal's own clock** is set to |
| Serial number | pull: filled in by *Test*; **push: required** | The only thing a pushing device sends to identify itself |
| Location | no | |
| Sync every (minutes) | pull only | |
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

## 5. Security

These are the only unauthenticated routes in the system, so it is worth being
explicit.

| Control | Behaviour |
|---|---|
| **Serial number** | Required; must match a registered, enabled, ADMS device. A serial is printed on the case — treat it as an identifier, not a secret |
| **Push token** | Optional but recommended. Stored encrypted (AES-256-GCM), write-only everywhere except the URL shown to an administrator holding `device.manage`. Once set, the untokened path stops working. **Redacted from request logs** |
| **Allowed networks** | Optional IPv4 addresses or CIDR ranges. A push from anywhere else is refused with 403 and nothing is stored |

An unknown serial and a wrong token produce an **identical** `401 Unauthorized`
with no detail, so probing tells an attacker nothing about which half was wrong.

**What these endpoints deliberately cannot do:** read attendance back out, list
devices or employees, create employees, or accept a command for a device to
run. `getrequest` always answers "nothing to do" — remote unlock, enrolment and
log-clearing are exactly the operations that would turn an HRMS bug into a door
that opens.

Device-management APIs are `device.manage` only. Employees can never add a
device, change an IP, trigger a command, download another employee's raw data,
or change a mapping.

---

## 6. Device user mapping

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

---

## 7. Sync history and diagnostics

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

## 8. What is implemented

- Device registry with encrypted comm keys and push tokens
- Pull over the ZKTeco standalone SDK protocol (TCP 4370): framing, session
  handshake, comm-key auth, chunked bulk transfer, packed time format
- ADMS push: handshake, ATTLOG ingest, command poll, command result
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

## 9. Raw device punches

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
