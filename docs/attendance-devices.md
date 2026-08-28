# Attendance terminals

The HRMS talks to biometric terminals in two directions, and which one applies
is a property of the device, not a setting you can flip later without also
reconfiguring the hardware.

| | Pull (`ZKTECO_TCP`) | Push (`ZKTECO_ADMS`) |
|---|---|---|
| Who opens the connection | the server | the device |
| Needs a route to the device | yes | no |
| Works behind NAT / on mobile data | no | yes |
| Scheduled by | `syncIntervalMinutes` | the device's own poll delay |
| Cursor / watermark | yes | not used |
| "Test" and "Sync" buttons | yes | hidden — there is nothing to connect to |

Both directions end up in exactly the same place: raw punches in
`attendance_raw_punches`, paired into `attendance_records` by the same policy
engine. A day scored from a pushed punch is indistinguishable from one scored
from a polled punch, which is deliberate — there is one attendance pipeline,
not two.

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

## Testing without hardware

```bash
npx dotenv -e .env -- npx tsx scripts/audit-adms.mjs
```

Drives the real HTTP endpoints exactly as a terminal would and checks the
database afterwards. For the pull direction, `scripts/zkt-simulator.mjs` speaks
the standalone SDK protocol over a real socket.

Neither proves the format matches a physical device: the test encoder and the
application decoder share an author, so a shared misunderstanding of the
firmware would pass here and fail on the wall.
