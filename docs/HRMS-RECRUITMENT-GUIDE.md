# Recruitment guide

Job openings, candidates, interviews, offers, and the one bridge from a
candidate to an employee. Every rule below is taken from the implementation.
Nothing is simplified.

---

## 1. A candidate is not an employee

This is the sentence the whole module is built on, and almost everything else
follows from it.

Somebody applying for a job has no employee number, no department, no contract,
no attendance and no login. Modelling them as an employee with a "status:
applicant" would mean every headcount, payroll run, org chart and attendance
report in this product quietly counting people who have never worked here — and
the day somebody forgets the filter is the day a payroll run includes a
stranger.

So candidates are their own record with their own lifecycle, and there is
**exactly one bridge** between the two worlds: **Convert to Employee**, which a
person performs, reviews and confirms. Nothing else in recruitment writes to the
employees table at all.

Three more decisions run through the module:

- **The stage lives on the application, not the person.** Somebody can be
  shortlisted for one role and rejected for another on the same afternoon. One
  stage column on the candidate could only ever record one of those.
- **An evaluation is advice, not arithmetic.** Nothing averages the scores,
  ranks candidates by them, or moves anybody's stage because of one. Three
  interviewers produce three separate opinions and a human reads them.
- **An offer is not a contract and not payroll.** The proposed salary is a
  number on an offer. Accepting one creates no salary row, no payroll profile
  and no contract; a new hire's pay is still set in payroll, by a person, on
  purpose.

---

## 2. The shape of it

```
Job opening                    DRAFT → OPEN → (ON_HOLD) → CLOSED / CANCELLED
        ↓
Candidate                      a person, with their own reference (CAN-0042)
        ↓
Application                    this candidate, for this opening. The stage lives here
        ↓
Interviews                     rounds, a panel, a time and a zone
        ↓
Evaluations                    one per panellist per interview. Never merged
        ↓
Offer                          DRAFT → SENT → ACCEPTED / DECLINED / EXPIRED
        ↓
Convert to Employee            reviewed, confirmed, and the only write to `employees`
```

A candidate exists independently of any vacancy — a CV in the database before an
opening exists is a perfectly good record — and gains an **application** each
time they are put against one.

---

## 3. Job openings

### The five statuses

| Status | What it means |
|---|---|
| **Draft** | Being written. Takes no applications and counts towards nothing |
| **Open** | Live. Candidates can be put against it and interviews arranged |
| **On hold** | Paused — a freeze, a budget question — but not given up on |
| **Closed** | Finished. The seats were filled or the search ended |
| **Cancelled** | Called off. The vacancy went away unfilled |

> **Draft is not a quiet Open.** A draft does not appear on the pipeline, cannot
> take applications, and does not count towards "open positions" — because the
> difference between "we are hiring" and "somebody started typing" is a number
> HR reports upwards.

**Only Open accepts new applications and new interviews.** On hold keeps the
vacancy in the count of live openings but stops new activity against it.

**Closing or cancelling requires a reason.** "Closed" with nothing beside it is
the answer nobody can use six months later when the same headcount comes back
round, so the API insists on one — and that is why status changes have their own
endpoint rather than riding along on a form save where the reason could be
forgotten.

### What an opening carries

A title (the only required field), department, team, location, employment type,
expected employment status, the **number of vacancies** (seats, not openings),
a hiring manager, a recruiter, description, requirements, skills, minimum
experience, a salary band, and opening and closing dates.

The salary band is validated both ways — the top cannot be below the bottom —
and so are the dates: closing cannot be before opening.

Openings carry a generated reference, `JOB-0007`, unique per company and derived
from the highest number already issued rather than from a row count, so deleting
a record cannot cause a collision.

---

## 4. Candidates and the pipeline

### The nine stages

Seven are a progression, and two are ways out.

| Stage | Meaning |
|---|---|
| **New** | Applied. Nobody has looked yet |
| **Screening** | Being read — the CV, the basics, the salary expectation |
| **Shortlisted** | Worth meeting |
| **Interview** | Interviewing, or booked to |
| **Selected** | The panel wants them. No offer has been made yet |
| **Offer** | An offer is with them |
| **Hired** | They accepted. Convert them to an employee when they start |
| **Rejected** | We said no |
| **Withdrawn** | They said no, or stopped answering |

Rejected and Withdrawn are deliberately **absent from the board's columns**:
they are states somebody leaves the pipeline *into*, and giving them columns
would turn a board that shows a process into a board that mostly shows people
who are no longer in it.

They are also kept apart from each other on purpose. Who ended it is exactly the
question somebody asks when the same CV arrives again next year — a candidate we
turned down and a candidate who took another job are not the same candidate, and
collapsing them into "closed" loses the one fact that would have been useful.

### Moving between stages

Deliberately **permissive forwards and backwards** between the live stages,
because hiring is not a state machine in real life: a candidate shortlisted on
Monday goes back to screening on Tuesday when somebody actually reads the CV,
and a process that refuses to let HR say so produces a board nobody trusts.

Two things it is *not* permissive about:

- **Hired is reachable only from Offer.** Arriving there from Screening would
  mean an offer was made that this system has no record of.
- **Nothing comes back from Hired.** A hired candidate is converted to an
  employee, and undoing that is an employee-record action, not a drag on a
  board.

Rejected and Withdrawn are reachable from every live stage — people drop out at
every point — and reversible back to **Screening**, because candidates are
re-opened and refusing to model that would mean a second duplicate record.

**A move into Rejected or Withdrawn must say why.**

### The candidate's own stage is derived

`CandidateRecord` carries a stage, and it is a **summary, not a decision**: the
furthest stage reached across their applications, for the list and the board.

Terminal stages count for nothing unless there is nothing else — somebody whose
only application was rejected *is* rejected, and somebody rejected by
Development while shortlisted by Design summarises as **shortlisted**. When
every application has ended, Withdrawn wins over Rejected, because somebody who
walked away did so of their own accord and that is the more informative of the
two. A candidate with no applications keeps their own stage, which is how a CV
filed before any vacancy exists stays *New*.

Decisions are made against the **application**, never against this summary.

### The restricted block

What a candidate earns now, what they are asking for, and the notes HR has
written about them are a **restricted block**, attached only for a caller
holding `candidate.manage`. It is stripped from every response without that
grant — so an interviewer with `candidate.read` opens the person they are
meeting and finds no salary history.

The candidate **timeline** is filtered the same way and carries no restricted
value: an offer's salary is absent from the entry, and confidential documents
are filtered out, so the timeline cannot become a way around the block.

### Documents

Up to **20 per candidate**, each at most **10 MB**: CV / Resume, Cover letter,
Portfolio, Certificate, Other. Same object store, same byte sniffing, same
accepted formats as case attachments — no second storage system was built.

Reading them needs `candidate.read`; **adding or deleting** one needs
`candidate.manage`.

---

## 5. Interviews

### Booking one

An interview is booked as a **day, two wall-clock times and a timezone** — never
as an instant the browser computed. The browser's zone is the interviewer's
laptop; the interview is at ten o'clock in Karachi whoever is looking at it. The
server combines the three into an instant. A zone the runtime does not recognise
is **refused** rather than silently treated as UTC, which would move every
interview booked through it.

Each interview has a **type** (HR, Technical, Manager, Final, Other), a **round**
(Round 1, 2, 3, Final), a panel, and a candidate — and, where there is one, the
opening and application it belongs to.

### Clash detection

Before an interview is scheduled, rescheduled, or has a panellist added, the
server checks whether anyone on the panel is already booked in that window.

**A clash refuses the request** and names who clashes — and it is
**overrulable**: the caller can say "book it anyway". The same check answers the
form's warning *before* you commit to a time, so the warning you see and the
refusal you get cannot disagree.

Only interviews in a **blocking** status occupy a slot: Scheduled, Confirmed,
Rescheduled and **Completed**. A cancelled interview frees its slot; a completed
one still occupied it, which matters when somebody is booking into the past to
correct a record.

### The six statuses

| Status | Meaning |
|---|---|
| **Scheduled** | Booked. Nobody has confirmed yet |
| **Confirmed** | Everyone has said they will be there |
| **Completed** | It happened. Evaluations can be filed |
| **Rescheduled** | It moved. The new time is on this same interview |
| **Cancelled** | Called off. Kept, because cancelling on somebody is a fact |
| **No show** | The candidate did not turn up |

Two details worth knowing:

- **Rescheduled is produced, never picked.** It is absent from every list of
  allowed manual transitions; the reschedule endpoint is the only thing that
  writes it. A reschedule also writes a history row saying where it moved from,
  in the same transaction as the move — a moved interview with no record of
  where it came from is the outcome the design forbids.
- **Completed is nearly terminal, and deliberately not quite.** It can still
  move to *No show*, because "marked complete by mistake, they never arrived" is
  an ordinary Tuesday. Nothing comes back from **Cancelled**: a cancelled
  interview that is happening after all is a new booking, which keeps the
  cancellation visible instead of erasing it.

### Who is told

The panel gets an in-app notification when an interview is **scheduled**,
**moved** or **cancelled**, plus reminders and an evaluation-pending nudge.

The email half is honest about itself. The notification service reports four
outcomes and they are not interchangeable: **skipped** (no address),
**delivered** (a real transport accepted it), **unconfirmed** (it went to a
transport that logs and drops — the console provider is always this), and
**failed**. Only *delivered* is an email. On this installation mail is the
console provider, so **no email is actually sent** — see the
[troubleshooting guide](HRMS-TROUBLESHOOTING.md).

An interviewer with no login account is skipped silently rather than failing the
request: a panel of three where one person is unreachable should still produce
the interview.

**Candidates are never notified.** They have no login, no address on file that
this module writes to, and nothing in recruitment emails them.

### Confirming your own seat

A panellist confirms with one action, and it reaches exactly one row: their own
seat, found by interview and their employee id. There is no request shape that
confirms on somebody else's behalf. This is the only write an ordinary
`interview.read` holder may perform.

---

## 6. Evaluations

**One per panellist per interview**, and they are **never merged**. Nothing
averages them, ranks candidates by them, or moves a stage because of one.

Each carries a recommendation — **Strong yes, Yes, Maybe, No** — and five
optional scores out of ten: technical skills, problem solving, communication,
experience, culture / team fit.

> **Optional is the load-bearing part.** An HR interviewer has no business
> scoring technical skill, and a blank score says "not assessed" where a zero
> would say "assessed, and terrible" — which is the difference between an honest
> panel summary and a libel.

**When they can be filed:** only once an interview is **Completed** or **No
show**. An interview that has not happened has nothing to evaluate; *No show* is
included because "they did not turn up" is itself feedback worth recording, and
the alternative is an interviewer with nowhere to put it.

**Whose seat:** `interview.evaluate` reaches only the holder's own. The endpoint
matches the caller's employee id against the panel before it will write
anything, so it can never be used to file an opinion in somebody else's name or
to overwrite theirs.

Removing somebody from a panel removes their evaluation with it.

---

## 7. Offers

| Status | Meaning |
|---|---|
| **Draft** | Being written. Nothing has been promised to anybody |
| **Sent** | With the candidate, waiting for an answer |
| **Accepted** | They said yes. Convert them when they start |
| **Declined** | They said no |
| **Expired** | The answer never came and the offer lapsed |

**An answered offer is finished.** No transition leaves Accepted, Declined or
Expired. Changing the terms after somebody has answered is a **new offer**,
which keeps the first one — and what it promised — on the record.

Marking an offer **Sent** nudges the application to the *Offer* stage, and only
forward: if the candidate is already at Offer or beyond, nothing happens. That
rule exists so marking an old offer expired can never drag somebody back from
*Hired*.

`recruitment.offer.manage` is separate from `recruitment.manage` because an
offer is a commitment about money, and the person who arranges interviews need
not be the person who makes one.

---

## 8. Convert to Employee

The only thing in the entire module that writes to the employees table — its own
file, its own grant, its own two-step flow.

**Step one: the preview.** Read-only. It creates nothing and calling it twice
changes nothing. It assembles a **proposal** — from the accepted offer, then the
job opening, then the candidate — and reports any existing employees who look
like this person, matched by email and by name.

**Step two: the conversion.** Four rules, enforced here rather than trusted to a
form:

1. **No automatic duplicate.** The POST **refuses** while any look-alike exists,
   unless the caller has explicitly acknowledged them. Two people really do
   share a name, so it is an overrulable refusal rather than a hard block; what
   it is not is silent. The duplicate check is **re-run at the moment of
   writing** — a preview taken ten minutes ago says nothing about the employee
   somebody else created five minutes ago.
2. **One candidate, one employee, ever.** Enforced by a unique index, so a
   second conversion cannot produce a second employee even under a race. The
   readable message names the record it already became.
3. **HR reviews the mapping.** What gets created is what a person confirmed on
   the form, not what the candidate record said. The candidate's single name
   field is split into first and last by a guess — everything before the last
   space, then the remainder — and openly a guess, which is exactly why the
   result lands on a form HR edits rather than straight into the database.
4. **Nothing else is touched.** No existing employee is read for writing. **No
   login account is created** — the HRMS has a user-creation flow behind
   `user.manage` that HR uses deliberately afterwards. No salary, no payroll
   profile, no contract: the offer's figure stays on the offer.

Employment status comes from the canonical three-member enum the employee record
already uses, and defaults to **Probation**.

Converting sets the candidate to **Hired** and stamps the link back to the
employee record.

> Conversion does **not** require the candidate to be at *Hired* first, or to
> have an accepted offer. It is a deliberate, reviewed action by somebody
> holding the grant, and the review is the control.

---

## 9. Who can do what

Nine grants. Three read grants that are **narrow on their own**, and grants that
widen them.

| Grant | What it opens |
|---|---|
| `recruitment.read` | The job openings you are **named on** — as hiring manager or recruiter |
| `recruitment.manage` | Every opening in the company; create, edit, close and cancel |
| `candidate.read` | Candidates, with the restricted block stripped |
| `candidate.manage` | Maintain candidates, move stages, and read the restricted block |
| `interview.read` | The interviews you are **on** |
| `interview.manage` | Every interview; schedule, reschedule, cancel, complete |
| `interview.evaluate` | File an evaluation for an interview you sat on — your seat only |
| `recruitment.offer.manage` | Make, send and record the answer to an offer |
| `recruitment.convert.employee` | Turn a hired candidate into an employee record |

### Narrowed by involvement, not by data scope

This is the part worth understanding, and it is a deliberate departure from the
rest of the product.

**Recruitment does not consult the data scope.** A data scope is granted for
line-management reasons — it says whose *employee records* somebody may read —
and a reporting line is not a reason to read the CVs of people who do not work
here. A department head's DEPARTMENT scope is given so they can read their
people's records; it is not a reason to read what the company is paying a
stranger to replace them with.

Recruitment is narrowed by **named involvement** instead: you see the opening
you are hiring for and the interview you are sitting on.

The narrowing is a **WHERE clause**, so an interview that is not yours is absent
from the query rather than fetched and then hidden — an interviewer cannot
browse the calendar, discover who else is being seen for a role, or open an
interview they were not invited to. A guessed id answers **404**, never 403:
telling somebody "that exists but is not yours" confirms that a particular
candidate is being interviewed, which is precisely what an unauthorised caller
was probing for.

A caller whose login is not linked to an employee record has **no anchor**, so
the narrow grants return nothing. An administrator's unlinked login is not on
anybody's panel.

### `candidate.read` is not part of `employee.read`

Somebody who can read the staff roster has no business reading the CVs of people
who do not work here. It is a separate grant, and it also gates candidate
documents.

An interviewer holding no candidate grant reaches the candidate's **name**
through the interview — which carries it — and reaches the candidate record not
at all.

### What the seeded roles hold

| Role | Recruitment |
|---|---|
| **Super Admin** | all nine |
| **HR Admin** | all nine, including conversion — HR already holds `employee.manage`, so withholding it would mean HR creating the same employee by hand and losing the link back to the candidate |
| **Manager** | `recruitment.read`, `interview.read`, `interview.evaluate` — their own vacancies, their own panels, their own feedback |
| **Interviewer** | `interview.read` and `interview.evaluate`, and nothing else. The whole module for them is one sidebar row leading to their own calendar |
| **Employee** | nothing |
| **Office Boy** | nothing |

**Managers do not hold `candidate.read`.** That absence is the design: somebody
interviewing a person is shown that person through the interview, and has no
business browsing what everybody who ever applied is earning.

---

## 10. The screens

Four, all under **Recruitment** in the sidebar, each carrying the grant its own
endpoints need — so an interviewer sees one row and a hiring manager sees two.

**Recruitment** (`recruitment.read`) — the dashboard. Open positions, open
vacancies (seats, not openings — six openings for two people each is twelve),
active candidates, candidates in interview, interviews today, upcoming
interviews, offers pending, hired this month. Plus the upcoming-interviews
panel.

Every figure is computed in the **company's timezone**. "Interviews today" is a
calendar question and the calendar in question is the office's; a UTC-based
count would put a 9 a.m. Karachi interview on the previous day.

The figures are also **scoped**, which is easy to miss on a dashboard: a caller
without `recruitment.manage` sees the openings they are named on, and one
without `interview.manage` sees the interviews they are on — the same filters
the list endpoints use, because a dashboard that aggregates rows the reader may
not open is a way around the filters. A hiring manager's "open positions: 2" is
their own two.

**Job openings** (`recruitment.read`) — the list, and an opening's own page with
its pipeline.

**Candidates** (`candidate.read`) — a list and a **board**. The board's columns
are the seven progression stages.

**Interviews** (`interview.read`) — a list and a calendar, and an interview's own
page with its panel, its evaluations and its schedule history.

---

## 11. The endpoints

All under `/api/v1`. Every plugin is gated at the plugin level by the grant in
the heading; individual writes carry their own.

### `/recruitment/dashboard` — `recruitment.read`

| Method | Path |
|---|---|
| GET | `/recruitment/dashboard` |
| GET | `/recruitment/dashboard/upcoming-interviews` |
| GET | `/recruitment/dashboard/interviewers` |

### `/recruitment/job-openings` — `recruitment.read`

| Method | Path | Extra grant |
|---|---|---|
| GET | `/` · `/:id` · `/:id/pipeline` | — |
| POST · PATCH | `/` · `/:id` | `recruitment.manage` |
| POST | `/:id/status` | `recruitment.manage` |

### `/recruitment/candidates` — `candidate.read`

| Method | Path | Extra grant |
|---|---|---|
| GET | `/` · `/board` · `/:id` · `/:id/timeline` | — |
| POST · PATCH | `/` · `/:id` | `candidate.manage` |
| POST | `/:id/applications` | `candidate.manage` |
| POST | `/applications/:id/stage` | `candidate.manage` |
| GET | `/:id/documents` · `/:id/documents/:documentId` | — |
| POST · DELETE | `/:id/documents` · `/:id/documents/:documentId` | `candidate.manage` |
| GET | `/:id/conversion-preview` | `recruitment.convert.employee` |
| POST | `/:id/convert` | `recruitment.convert.employee` |

### `/recruitment/interviews` — `interview.read`

| Method | Path | Extra grant |
|---|---|---|
| GET | `/` · `/calendar` · `/my-summary` · `/:id` | — |
| GET | `/conflicts` | `interview.manage` |
| POST · PATCH | `/` · `/:id` | `interview.manage` |
| POST | `/:id/reschedule` · `/:id/status` | `interview.manage` |
| POST | `/:id/confirm` | — (your own seat) |
| GET | `/:id/evaluations` · `/by-candidate/:id` | — |
| POST | `/:id/evaluations` | `interview.evaluate` |

### `/recruitment/offers` — `recruitment.read`

| Method | Path | Extra grant |
|---|---|---|
| GET | `/` · `/:id` | — |
| POST · PATCH | `/` · `/:id` | `recruitment.offer.manage` |
| POST | `/:id/status` | `recruitment.offer.manage` |

---

## 12. What is not here

Stated plainly, because this documentation does not describe features that do
not exist:

- **No careers portal and no public job board.** An opening is an internal
  record; nothing publishes it anywhere, and there is no application form a
  member of the public can reach. Candidates are entered by HR.
- **No CV parsing.** A CV is a file on a shelf. Nothing reads it, extracts
  fields from it, or matches it against requirements.
- **No email to candidates.** Nothing in this module writes to a candidate.
  Interview notifications go to the **panel**, who are employees — and on this
  installation even those are in-app only, because mail is the console provider.
- **No offer letter document.** An offer is a record of terms, not a generated
  PDF, and nothing is sent to the candidate by the system.
- **No automatic offer expiry.** *Expired* is a status somebody sets. No
  scheduled job moves an offer there when its date passes.
- **No scoring, ranking or shortlisting by score.** Evaluations are read, not
  computed with.
- **No approval workflow.** Opening a vacancy, making an offer and converting a
  candidate happen when somebody with the grant does them. They are audited, not
  routed.
- **No login is created on conversion.** That is a separate, deliberate step
  behind `user.manage`.
- **Nothing reaches payroll.** An offer's salary is a number on an offer.
  Converting a candidate writes one employee record and stops.

---

## 13. See also

- [Admin manual §18](HRMS-ADMIN-MANUAL.md#18-recruitment) — the operator's walkthrough
- [Manager guide](HRMS-MANAGER-GUIDE.md#hiring-and-interviews) — vacancies you own and panels you sit on
- [Feature matrix](HRMS-FEATURE-MATRIX.md#recruitment) — implementation status, line by line
