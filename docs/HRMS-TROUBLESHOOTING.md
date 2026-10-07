# Troubleshooting

Symptoms, causes, and what to actually do. Each entry says which of these it is:
a configuration problem, a data problem, or a known limitation.

---

## Access

### An employee cannot sign in

**First, do they have an account at all?** Recording an employee does not give
them a login. Check **Settings → Users**; if they are not listed, create one
with **Invite user**.

| Cause | Check | Fix |
|---|---|---|
| Wrong password | — | Password reset from the sign-in screen |
| **Reset email never arrived** | Is `MAIL_PROVIDER=smtp`? On `console` nothing is delivered at all | **Settings → Users → the account → Set password**, and hand it over directly. Needs *Set passwords* — Super Admin by default |
| Reset link expired | Valid 60 minutes | Request a new one |
| Account still *Invited* | An invitation was sent but never accepted, so no password was ever set | Setting a password for them activates the account in the same step |
| Rate limited | 10 sign-in attempts per 5 minutes per IP | Wait five minutes |
| Account locked after failed attempts | — | Setting a password clears the lockout |
| **Account suspended** | Settings → Users shows the status | **Restore** it first. A suspended account is refused a password and a reset link alike |
| Session expired mid-work | 8-hour default | Sign in again |

### They sign in and land on "Choose your own password"

Working as intended. The password they used was issued by somebody else — by an
administrator, or by the bulk account script — and the system requires them to
replace it before anything else opens. They need the password they were given
*and* a new one of their own.

If they no longer have the temporary password, issue another with **Set
password**; there is no way to retrieve the old one and no need to.

### A user can see something they should not

Check both halves. A **permission** says what kind of thing; a **data scope**
says whose. **Settings → Roles and permissions** shows the grants. If a user
holds several roles, **the widest scope wins** — that is usually the surprise.

---

## People

### An employee is missing from a list

| Cause | Fix |
|---|---|
| Outside your data scope | A manager sees only their reporting line. Ask for a wider scope, or fix the reporting line |
| Not assigned to the manager | Set `managerId` on their record |
| Terminated | Terminated employees are excluded from most lists |
| Search or filter still applied | Reset the filters |

### Wrong department, designation or manager

**People → open the employee → Edit.** All three are edited there and the change
is audited.

Changing the department does **not** rewrite history — past attendance, leave
and payroll keep the department they were recorded under.

Changing the **manager** changes who approves *future* requests. Requests
already pending keep the approver they were routed to.

### Restricted fields are blank

National ID, passport, visa and bank account require
`employee.sensitive.read`. They are not hidden in the interface — they are
absent from the response. Only Super Admin and HR Admin hold it by default.

---

## Attendance

### Attendance is missing for a day

Work down this list in order:

1. **Is it a weekend or holiday?** Then there is nothing to record.
2. **Is the employee on approved leave?** The day derives as `ON_LEAVE`.
3. **Did the device sync?** *Devices → Sync history*. A failed run leaves the
   cursor where it was and retries on the next tick.
4. **Is the device user mapped?** *Devices → Device users*. An unmapped punch is
   stored and counted but belongs to nobody. Add the mapping, then
   **Reprocess**.
5. **Is the punch there at all?** *Device punches*, filtered to that device and
   date. If the raw punch is absent, the terminal never sent it.
6. **Has the absence job run?** It runs at boot and every 24 hours after, for
   the previous day only. `POST /attendance/mark-absences` triggers it.

### A day shows "checked in, never out"

The status stays **Present** and worked minutes are blank. This is deliberate —
the system will not guess how long somebody worked.

Fix: the employee raises an attendance correction with the real times; the
manager approves. The record is rewritten with `source: ADMIN` and no future
device sync will overwrite it.

In payroll this day raises an `INVALID_ATTENDANCE` warning.

### Late minutes look wrong

| Cause | Check |
|---|---|
| No shift assigned | Lateness is `null` without one. *Shifts → Assignments* |
| Grace misunderstood | Grace is a **threshold, not a discount**. With 10 minutes of grace, arriving 11 minutes late records **11**, not 1 |
| Wrong shift in force | The assignment effective on that date, not today's |
| Wrong company timezone | See below |
| Policy override | *Settings → Policy overrides* — a department, team or employee policy may apply. The employee's attendance detail shows which policy was in force |

Past days are **not** rescored when a shift or policy changes.

### Early leave is always blank on a night shift

**Known limitation, by design.** Early leave is not evaluated for overnight
shifts (where the end time is at or before the start). The shift end falls on
the next calendar day and guessing which one would produce a confidently wrong
number, so it returns nothing. Lateness and worked minutes still work.

### Overtime looks wrong

| Cause | Check |
|---|---|
| Disabled | `overtimeEnabled` in the policy |
| Capped | `overtimeDailyCapMinutes`, default 240. A forgotten check-out cannot book 14 hours |
| Threshold | Overtime starts after `overtimeAfterMinutes`, default 480 |
| Double counting expected | Overtime is a **portion of** worked minutes, not added to them. A 9-hour day is 540 worked, of which 60 are overtime — never 600 |
| Recorded but not paid | The timesheet covering it is not approved. See below |

### Overtime is recorded but not paid

With `requireApprovedOvertime` on (the default), only overtime on a date covered
by an **APPROVED** timesheet is paid. The rest is counted, reported as an
`UNAPPROVED_OVERTIME` warning, and not paid.

Fix: approve the timesheet, then recalculate the payroll run — if it is not yet
finalized. If it is finalized, raise a **payroll adjustment**.

### Everything is off by several hours

The company timezone is wrong. **Settings → Company → Timezone.**

This is the setting that decides which working day an instant belongs to. On a
Karachi company left at UTC, every derived day is five hours out in both
directions — an 08:56 arrival looks like a four-hour early start and a 02:00
punch lands on the previous day.

Changing it does not rescore existing records.

### Approved leave is not showing on attendance

| Cause | Check |
|---|---|
| Not actually approved | Still pending shows nothing |
| Weekend or holiday | Both outrank leave in precedence, deliberately — booking leave across a public holiday should not report the holiday as leave |
| Dates do not cover the day | Leave is inclusive of start and end |
| The day was given back | Attendance was recorded on it, so it is scored on that attendance — see the next entry |

### Approved leave was cancelled, or a day came back to the balance

*Data, working as designed.* When attendance is recorded on a day of approved
leave, that day is given back. A request with every day given back shows
**Cancelled · Automatic** (or **Super Admin**, when one cancelled it by hand)
with the reason under the badge. The employee did not withdraw it.

To see exactly why, open **Settings → Audit log** and filter for
`leave.request.auto_reverse` or `leave.request.conflict_cancel`. Each row holds
the check-in and check-out, the attendance record, the device punch ids, and
the balance before and after.

| Symptom | Cause |
|---|---|
| A half day of leave was not given back | It is given back only when the day is closed and scores **Present**. An open day, or one scored Half day, keeps the leave |
| An old conflict was never given back | The automatic daily pass covers only today − 2 to today + 1. A Super Admin uses **Cancel leave** on the request |
| The punch was wrong (someone else's thumb, a test punch) | Correct the attendance. The reversal stays; it is a ledger row, not a derived figure. If the leave should stand, re-apply it as a new request or an adjustment |

---

## Devices

### The device is not syncing

**Pull devices** — *Devices → Sync history* shows the failure reason.

| Cause | Fix |
|---|---|
| Wrong IP or port | Default is 4370. **Test connection** proves it |
| Not reachable from the server | Ping it from the server, not from your laptop |
| Comm key wrong | If the terminal has one set, it must match. Re-enter it |
| Device disabled | A disabled device is never contacted |
| Sync already running | A per-device lock; a lock older than 15 minutes is treated as stale |
| Device is ADMS or connector | Neither is polled from here — the Test and Sync buttons are hidden for both |

**Push devices** — nothing appears in **Last contact**.

| Cause | Fix |
|---|---|
| `API_HOST` is `127.0.0.1` | The API refuses connections from the network. Set `API_HOST=0.0.0.0` |
| `DEVICE_PUSH_ORIGIN` unset | The devices screen cannot show the URL. The endpoints still work |
| Serial not registered, or mismatched | The serial is the only thing the device sends. It must match exactly, though case is ignored |
| Protocol set to pull | A pull device is refused on the push endpoint |
| Device disabled | Refused |
| Token set but not in the device URL | Once a token is set, the untokened path returns 401 |
| Source outside the allow-list | Returns 403. Check the allow-list, or clear it |

Server logs record every rejection with an event of `PUSH_REJECTED` and the
reason — the push token is redacted.

**Connector devices** — nothing appears in **Last contact**. Read the
connector's own log first; it names its problem in plain words and its events
are listed in `apps/connector/README.md`.

| Cause | Where it shows | Fix |
|---|---|---|
| Connector not running | Nothing in its log since the last reboot | It is not set to start at boot. See the deploy notes beside it |
| Connector exited with code 78 | Its first and only log line | Not configured. The message names every missing setting |
| `HANDSHAKE_FAILED` 401 | Connector log | Wrong token, or the terminal's serial is not registered here |
| `HANDSHAKE_FAILED` 409 | Connector log | The device has no connector token set. Set one on its page |
| `HANDSHAKE_FAILED` 403 | Connector log | The allow-list does not include the office's **public** address. It is not the terminal's LAN address |
| `DEVICE_UNREACHABLE` | Connector log | The terminal is off, or `deviceHost` is wrong, or that machine is not on the terminal's network |
| Protocol set to pull | Connector log, 401 | A pull device is refused on the connector endpoints |
| Terminal reachable, nothing new | `NOTHING_NEW` every poll | Healthy. The terminal genuinely holds nothing past the watermark |

Server logs record connector rejections as `CONNECTOR_REJECTED`, with the
bearer token redacted, and a terminal whose clock has drifted five minutes or
more from the server's as `CONNECTOR_CLOCK_DRIFT`. Drift is reported and never
corrected: a punch is evidence of when somebody was at a door, and shifting it
would hide the reason shift boundaries are being missed. Set the clock at the
terminal.

### ZKTeco connection failure, first ever attempt

The physical K50 has **never been connected**. The integration is verified
against a protocol simulator only. On a first real connection expect to check:
the serial number the device reports, the comm key, the packed time format, the
user-ID format, the ADMS handshake keys, and whether the device reports punch
direction. See the [device guide](HRMS-DEVICE-GUIDE.md#what-is-still-pending).

### A device user is not mapped

*Devices → Device users* lists what the terminal holds plus everything mapped.
Map the PIN to an employee, then **Reprocess** to turn the stored punches into
attendance.

For a connector device the list is whatever the connector last reported, since
nothing here can read that terminal. If it is empty the screen says so rather
than showing a bare list — the connector sends a roster when it starts up and
every few hours after that.

No employee is ever created automatically from an unknown device user — that
would let anyone who can enrol a finger create a person in the HRMS.

### Duplicate punches

Handled automatically. Every punch has a fingerprint over the device, user ID
and reading, with a unique index. A repeat is a **counted duplicate, not an
error**. Re-syncing a window or a device resending a batch is harmless.

If you genuinely see two attendance records for one person and day, that is not
duplicate punches — attendance is unique per employee per day.

---

## Payroll

### Payroll will not approve or finalize

The run has a **blocking** exception. They are listed above the employee table.

| Exception | Fix |
|---|---|
| `MISSING_SALARY` | Add an effective-dated salary covering the period |
| `OVERLAPPING_SALARY` | Two records claim the same day, or the salary type changes mid-period. Close one, or split the period |
| `NON_POSITIVE_NET` | Deductions meet or exceed pay. Decide deliberately, then adjust |

Resolve, **recalculate**, then approve.

### An employee is missing from the run

- They have a **blocking** exception, so no line was produced.
- Their payroll profile is marked inactive.
- They were terminated before the period, or hired after it.

### The figures look wrong

Open the employee's row — the drawer shows the whole calculation: the attendance
the engine recorded, the rate it was priced at, every earning and deduction, and
the rounding at the end. Or use **Reports → Attendance vs payroll**, which puts
the attendance beside what it cost.

Common causes:

| Symptom | Cause |
|---|---|
| Basic is not the round salary | A salary change mid-period prorates across segments. The line shows how many segments |
| Absence deduction larger than expected | Check the **basis**. A fixed 30 and calendar days give different daily rates from the same salary |
| No absence deduction at all | Daily and hourly staff never get one — they were never credited for the day. Or the switch is off |
| Whole month deducted | The employee has **no attendance at all** for the period, so every working day scored as absence. Raises an `INVALID_ATTENDANCE` warning |
| Overtime not paid | Timesheet not approved |
| Allowance missing | The assignment's effective dates do not cover the period, or the component is inactive |

### Payroll was finalized with a mistake

**It cannot be edited. That is deliberate**, and every route enforces it with a
409.

Raise a **payroll adjustment** (Payroll → Adjustments): the employee, whether it
is a payment or a recovery, the amount, and a reason. It is applied in the
**next** run for that employee and appears there as an itemised line. The
original stays visible.

Never edit a finalized run in the database. The payslip and the record would
disagree, and the payslip is the one somebody was actually paid from.

### A payslip is missing

- The run is not **finalized**. Payslips are issued at finalization.
- The employee had a blocking exception, so had no line.
- Payslips are issued but not **published** — publishing releases them.

### An employee says they cannot open their payslip

They can only open their own. Requesting another employee's by changing the id
returns 403 with no figures in the response — that is working correctly.

If they cannot see their *own*: check they hold `payslip.read` (every employee
does by default) and that their login is linked to their employee record. An
account with no employee record behind it has nothing to scope to and sees
nothing.

---

## Approvals

### "No approver could be determined for this request"

The employee has **no manager, no secondary manager, and their department has
no head**. Set at least one. This is the most common blocker on a fresh
installation.

### A request cannot be approved

| Cause | Explanation |
|---|---|
| You are not the assigned approver | `approval.act` covers requests assigned to you. An administrator with `approval.manage` can override |
| You decided the previous step | Separation of duties: one person cannot decide two steps of the same chain |
| It is your own request | Never permitted |
| It is already terminal | Approved, rejected and cancelled are immutable |

---

## API and integration

### API requests fail

| Status | Meaning |
|---|---|
| 401 | No session, or it expired. Sign in again |
| 403 | Authenticated but not permitted — a permission or a data scope |
| 404 | Wrong path, or a record outside your company |
| 409 | A conflict: duplicate check-in, a finalized run, a sync already running |
| 422 | Validation. The response names the fields |
| 429 | Rate limited |
| 500 | A server error. The response deliberately carries no stack trace; look in the server log |

### The web application cannot reach the API

- Is the API running? `GET /health` reports its status and whether the database
  is reachable.
- `WEB_ORIGIN` must match the address the browser uses, or CORS blocks the
  request with credentials.
- In development the Vite dev server proxies `/api` to the API port.
