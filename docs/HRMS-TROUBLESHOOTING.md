# Troubleshooting

Symptoms, causes, and what to actually do. Each entry says which of these it is:
a configuration problem, a data problem, or a known limitation.

---

## Access

### An employee cannot sign in

**First, the known limitation.** There is no user-management module. If this
person has never signed in, they probably have **no account** — one was never
created, because nothing in the application creates one. Recording an employee
does not give them a login.

If they have signed in before:

| Cause | Check | Fix |
|---|---|---|
| Wrong password | — | Password reset from the sign-in screen |
| Reset email never arrived | Is `MAIL_PROVIDER=smtp`? On `console` the link is written to the server log instead | Configure SMTP, or read the link out of the log |
| Reset link expired | Valid 60 minutes | Request a new one |
| Rate limited | 10 sign-in attempts per 5 minutes per IP | Wait five minutes |
| **Account suspended after termination** | Were they terminated and then reactivated? | **Known limitation** — reactivation does not restore the login. Needs a direct database change |
| Session expired mid-work | 8-hour default | Sign in again |

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
| Device is ADMS | Pushing devices are never polled — the Test and Sync buttons are hidden for them |

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
