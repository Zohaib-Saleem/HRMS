# Attendance guide

Every rule below is taken from the implementation. Nothing is simplified.

---

## 1. The lifecycle

```
Shift assignment          what was expected
        ↓
Punch                     a terminal, or a self check-in, or an administrator
        ↓
Raw punch                 stored verbatim, never edited
        ↓
Pairing                   first in, last out (or the direction the device reports)
        ↓
Attendance record         one row per employee per day
        ↓
Derivation                weekend → holiday → leave → the record → absent
        ↓
Correction                a request, approved, applied
        ↓
Payroll                   reads the derived day, never the punch
```

Three separate things produce an attendance record, and they are not equal:

| Source | Written by | Overwritten by a device sync? |
|---|---|---|
| `SELF` | the employee's own check-in | yes |
| `DEVICE` | a terminal, via pull or push | yes |
| `ADMIN` | an administrator, or an approved correction | **never** |
| `SYSTEM` | the nightly absence job | yes |

A record marked `ADMIN` is a human decision and a device sync will not touch
it. That is the mechanism behind "manual attendance is protected".

---

## 2. Shifts

### Creating a shift

**Shifts → New shift.** Four fields:

| Field | Meaning |
|---|---|
| Name | Unique per company |
| Start time | Local wall clock, `HH:mm` |
| End time | Local wall clock, `HH:mm` |
| Break minutes | Subtracted from the rostered length |

Times are wall clock in the **company** timezone. They carry no date and no
offset.

### Rostered length

```
end > start            length = end − start − break
end ≤ start            length = (24:00 − start) + end − break     (overnight)
```

`22:00 → 06:00` with a 60-minute break is **420 minutes**, not minus sixteen
hours. An unreadable time falls back to 8 hours. A break longer than the shift
floors at zero.

### Assigning a shift

**Shifts → Assignments.** Effective-dated: `effectiveFrom`, and optionally
`effectiveTo`. The shift in force on a day is the assignment with the latest
`effectiveFrom` that has begun and has not ended.

An employee with **no shift assignment** still has attendance. What they lose:

- lateness is `null` — there is nothing to be late against
- early leave is `null`
- payroll assumes **8 hours** and raises a `MISSING_SHIFT` warning

### Changing a shift

Two ways:

1. **Administrator** — add a new assignment from a date. The old one stays.
2. **Employee or manager** — *Shifts → Request a change*, which raises an
   approval. On approval the assignment is created automatically.

Past attendance is **not** rescored when a shift changes. Each attendance
record stores the `shiftId` in force when it was written, so a later shift
change cannot retrospectively alter how late somebody was.

---

## 3. The attendance policy

The company baseline lives in **Settings → Attendance policy**. Named overrides
live in **Settings → Policy overrides**, scoped to a department, team or
employee with effective dates. Resolution is most-specific-first:
**employee → team → department → company**.

| Setting | Default | What it does |
|---|---|---|
| `graceMinutes` | 10 | Lateness at or below this is forgiven entirely |
| `halfDayMinutes` | 240 | Worked minutes at or above this earn a half day |
| `fullDayMinutes` | 480 | Worked minutes at or above this earn a full day |
| `earlyLeaveGraceMinutes` | 10 | Early leaving at or below this is forgiven |
| `overtimeEnabled` | true | |
| `overtimeAfterMinutes` | 480 | Worked minutes beyond this are overtime |
| `overtimeDailyCapMinutes` | 240 | Ceiling on overtime credited in one day |
| `locationRestrictionEnabled` | false | Geofence on check-in |
| `defaultGeofenceRadiusM` | 200 | Fallback radius |
| `ipRestrictionEnabled` | false | Network allow-list on check-in |
| `allowedCheckInCidrs` | `[]` | Addresses or CIDR ranges |

Both restrictions **fail closed**. With IP restriction on and an empty
allow-list, nobody can check in — an allow-list that silently meant
"everything" would be a control that does the opposite of its name.

---

## 4. The calculations, exactly

### Worked minutes

```
checkIn and checkOut both present   →  round((checkOut − checkIn) / 60000), floored at 0
otherwise                          →  null
```

Break minutes are **not** subtracted from worked minutes. They affect the
rostered length only.

### Lateness

```
no shift                       →  null
raw = round((checkIn − shiftStartOnThatDay) / 60000)
raw ≤ 0                        →  0        (early or exactly on time)
raw ≤ graceMinutes             →  0        (forgiven)
otherwise                      →  raw      (the whole lateness, not the excess)
```

Note the last line: grace is a **threshold, not a discount**. With a 10-minute
grace, arriving 11 minutes late records 11 minutes, not 1.

### Early leave

```
no shift                       →  null
shift end ≤ shift start        →  null     (overnight — not evaluated)
raw = round((shiftEndOnThatDay − checkOut) / 60000)
raw ≤ 0                        →  0
raw ≤ earlyLeaveGraceMinutes   →  0
otherwise                      →  raw
```

> **Overnight shifts are not evaluated for early leave.** The shift end falls on
> the following calendar day and guessing which one would produce a
> confidently wrong number, so the implementation returns `null` instead.
> Lateness and worked minutes still work for overnight shifts.

### Overtime

```
worked is null                 →  null
overtime disabled              →  0
over = worked − overtimeAfterMinutes
over ≤ 0                       →  0
otherwise                      →  min(over, overtimeDailyCapMinutes)
```

Overtime is a **labelled portion of worked minutes, not additional time**. A
9-hour day with an 8-hour threshold is 540 worked minutes, of which 60 are
overtime — never 600.

The cap exists so a forgotten check-out cannot silently book 14 hours.

### Day status

```
no check-in                    →  ABSENT
worked is null (no check-out)  →  PRESENT
worked ≥ fullDayMinutes        →  PRESENT
worked ≥ halfDayMinutes        →  HALF_DAY
otherwise                      →  ABSENT
```

A day with a check-in and no check-out is **PRESENT**, and its worked minutes
stay `null`. The system refuses to guess how long somebody worked. Payroll
counts such a day as an `INVALID_ATTENDANCE` warning.

Someone who checks in and straight back out has worked ~0 minutes and is
scored **ABSENT** — with the check-in and check-out times still on the record.

### Derived status — what the screens actually show

The stored record is only one input. Precedence, highest first:

```
1. WEEKEND    the day is in the company's weekend days
2. HOLIDAY    a holiday applies to that employee's location
3. ON_LEAVE   approved leave covers the date
4. the stored record's status
5. ABSENT     nothing recorded on a working day
```

Weekend and holiday beat leave **deliberately**: booking leave across a public
holiday should not report the holiday as a day of leave, and the leave balance
already excluded it.

---

## 5. Check-in and check-out

**Attendance → Check in.** Rules enforced by the server:

- Refused on a weekend, a holiday, or a day covered by approved leave —
  *"there is nothing to check in to"*.
- Refused if already checked in today (409).
- IP allow-list checked if enabled. The address comes from the server, never
  from a client-supplied header.
- Geofence checked if enabled. Fails closed: an employee with no work location,
  or a location with no coordinates, is refused rather than waved through. This
  applies to remote check-ins too — exempting them would make the restriction
  one dropdown away from being defeated.
- The shift in force is captured onto the record.

Check-out refuses if there is no check-in (409) or if already checked out
(409). On check-out the whole day is recomputed: worked minutes, lateness,
early leave, overtime and status.

**One pair per day.** The self-service path does not support multiple in/out
pairs. A device *can* deliver many punches for a day — see below.

---

## 6. Multiple punches, from a device

A terminal typically sends several punches a day. Pairing is configured per
device:

| Mode | Behaviour |
|---|---|
| `FIRST_IN_LAST_OUT` | earliest punch is the check-in, latest the check-out |
| `DEVICE_STATE` | use the in/out direction the device reports |

`FIRST_IN_LAST_OUT` is the default because many terminals report no direction
at all.

A single punch in a day gives a check-in and **no check-out** — worked minutes
stay `null` and the day is `PRESENT`.

---

## 7. Absence marking

Anyone with no attendance record on a working day is recorded absent.

- Runs **at server boot, then every 24 hours from boot** — not at a fixed clock
  time. Restarting the API at 15:00 moves the daily run to 15:00.
- Processes **the previous day only**.
- Skips weekends, holidays, days covered by approved leave, and days that
  already have a record.
- Idempotent — running it again is harmless.
- Can be triggered manually: `POST /attendance/mark-absences`
  (`attendance.manage`).

> **Limitation.** Because the schedule is tied to process uptime rather than a
> cron, a server restarted repeatedly runs it repeatedly (harmless), and a
> server down across a day boundary marks that day late — on the next boot.

---

## 8. Corrections

An employee or manager raises **Attendance → Request a correction** with the
date, the proposed check-in and check-out, and a reason. This creates an
approval request of type `ATTENDANCE_REGULARIZATION`.

On approval the attendance record is written with `source: ADMIN`, which means
**no future device sync will overwrite it**.

An administrator holding `attendance.manage` can also write a record directly
via `POST /attendance` without an approval.

---

## 9. Timezone handling

Everything is stored in UTC. Everything is *reasoned about* in the company
timezone.

- A punch arrives as a wall-clock reading with no offset. The **device's**
  configured timezone turns those digits into an instant.
- The **company's** timezone decides which working day that instant belongs to.
  A terminal in another zone still contributes to the working day the company
  is having.
- Shift start and end are compared against the same day in the company zone.

Worked example, company in `Asia/Karachi` (UTC+5):

| Reading | Instant | Company day |
|---|---|---|
| 23:30 on the 24th | 18:30Z on the 24th | the 24th |
| 01:00 on the 25th | 20:00Z on the **24th** | the **25th** |

Read in UTC, the second punch would land on the 24th and the late shift would
be counted on the wrong day. The zone-aware conversion is what prevents it.

> This was a real defect, fixed during the device integration work:
> `Company.timezone` was stored but never read, so every derived day was a UTC
> day. On a Karachi company that was five hours wrong in both directions.

---

## 10. Historical attendance

- Attendance is queried by date range and narrowed by data scope.
- Changing a shift does **not** rescore past days.
- Changing an attendance policy does **not** rescore past days automatically.
  Policy assignments are effective-dated so that a *deliberate* recalculation
  uses the policy that was in force on the day — but nothing recalculates on
  its own.
- A finalized payroll run is immune to all of it: every figure it used was
  copied onto the payroll line.

---

## 11. Team attendance

**Attendance → Team attendance**, for anyone with `attendance.read` and a scope
wider than OWN.

- Filters: date range, department, team, and free-text employee search.
- Columns: per-day status, check-in, check-out, worked, late and early minutes.
- Click through to one employee's calendar, history and the policy in force.
- Totals: worked minutes, overtime, absent days, leave days, incomplete days.

A manager sees their reporting line; an administrator sees everyone. **There is
no correction action on this screen** — a manager corrects a report's
attendance by approving the correction request that employee raised, or by
asking HR to write it directly.

---

## 12. Timesheets

Separate from attendance, and related to it in exactly one direction.

- **Create** a timesheet for a period (*Timesheets → New timesheet*).
- **Fill from attendance** rewrites the `CAPTURED` lines from recorded
  attendance and leaves `MANUAL` lines alone. Days with no check-out are
  skipped — worked time is unknown and the system will not guess.
- **Submit** raises an approval; the timesheet can no longer be edited.
- Statuses: `DRAFT → SUBMITTED → APPROVED / REJECTED`.

**Relationship with payroll:** a timesheet does not add hours to pay. Its only
payroll effect is that an **APPROVED** timesheet covering a date makes that
day's overtime *payable*. With `requireApprovedOvertime` on (the default),
overtime with no approved timesheet is counted, reported as an exception, and
not paid.
