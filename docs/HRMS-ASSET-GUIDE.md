# Asset guide

The company's equipment, who is holding it, and what happened to it. Every rule
below is taken from the implementation. Nothing is simplified.

---

## 1. Two questions, never one

The whole module turns on two sentences. Read these and most of the rest
follows.

**An asset's STATUS and its CONDITION are different questions.** Status says
where the thing is in the company's custody — in stock, out with somebody, away
being fixed, written off. Condition says what state the thing is in — new, fine,
scratched, broken. A laptop can be *Assigned* and *Good*, *Assigned* and
*Damaged*, or *Available* and *Critical*. They are two columns and neither is
derived from the other. Collapsing them is how a company ends up unable to
answer "what have we got that still works".

**Who has it is a HISTORY, not a column.** There is deliberately no "current
holder" field on an asset. A laptop goes to Ahmed, comes back, and goes to Sana;
a single column would record the last of those three facts and destroy the first
two — which are exactly the facts somebody needs when the machine turns up with
a cracked screen. The holder is the one **active** row in `asset_assignments`,
and every row before it is still there.

A third rule follows from the second: **nothing is ever deleted.** There is no
delete endpoint for an asset, a handover, a repair or an incident. A written-off
laptop is a *status*, not a missing row, because a DELETE would quietly dispose
of the answer to "who had the laptop that went missing".

---

## 2. The lifecycle

```
Added to the register                 status: AVAILABLE
        ↓
Assigned to somebody                  ASSIGNED  + an active assignment row
        ↓
They acknowledge it                   (or report a problem with it)
        ↓
        ├── Returned                  RETURNED  → somebody checks it → AVAILABLE
        ├── Transferred               straight to the next person, never coming back
        ├── Sent for repair           UNDER_REPAIR → back → AVAILABLE or ASSIGNED
        ├── Marked damaged            DAMAGED
        └── Marked lost               LOST   (things turn up: LOST can go back to AVAILABLE)
        ↓
Retired                               out of service, still owned
        ↓
Disposed                              sold, scrapped, donated, recycled. The end.
```

### The eight statuses

| Status | What it means |
|---|---|
| **Available** | In stock and ready to hand to somebody |
| **Assigned** | Out with an employee. There is an active assignment behind this |
| **Under repair** | Away being fixed. Not available and not with anybody |
| **Lost** | Unaccounted for. Still on the register, because writing it off is a decision |
| **Damaged** | Broken and not fit to hand out. May still be repairable |
| **Returned** | Handed back and **not yet checked over** |
| **Retired** | Taken out of service and kept. No longer issued to anybody |
| **Disposed** | Gone — sold, scrapped or written off. The end of the record |

> **Returned is not a synonym for Available.** An asset that has just come off
> somebody's desk has not been looked at yet, and the difference between "nobody
> has this" and "somebody handed this in and we have not checked it" is the
> difference between handing it straight out again and discovering the charger
> is missing. Somebody moves it to Available on purpose.

### Which status may follow which

| From | May move to |
|---|---|
| Available | Assigned, Under repair, Damaged, Lost, Retired, Disposed |
| Assigned | Returned, Under repair, Damaged, Lost |
| Under repair | Available, Assigned, Damaged, Lost, Retired, Disposed |
| Lost | Available, Retired, Disposed |
| Damaged | Under repair, Available, Lost, Retired, Disposed |
| Returned | Available, Assigned, Under repair, Damaged, Lost, Retired, Disposed |
| Retired | **Disposed, and nothing else** |
| Disposed | **nothing** |

Permissive about the middle of an asset's life and strict about its end, for two
reasons worth stating:

- **Nothing comes back from Disposed.** An asset that was scrapped and is then
  marked available again is either a second asset or a mistake, and both deserve
  somebody's attention rather than a silent edit.
- **Retired goes only to Disposed.** Taking something out of service and then
  quietly issuing it again defeats the point of having retired it.

### Two statuses you cannot type

**Assigned** and **Returned** are refused by the edit form. They are
*consequences*: an asset is Assigned because there is an active assignment row
behind it, and Returned because that row was closed. Setting either by hand
would produce an asset marked as being on somebody's desk with no record of
whose desk — the exact state the assignment table exists to prevent. Use
**Assign** and **Return**; the status follows.

### The five conditions

| Condition | Meaning |
|---|---|
| New | Unused, or as good as |
| Good | Working normally with ordinary wear |
| Fair | Working, but showing its age |
| Damaged | Something is broken. Usable or not, it needs attention |
| Critical | Barely serviceable. Replace rather than repair |

*Damaged* appears in both lists and that is not a duplication: the **status**
says "we are not issuing this to anybody", the **condition** says "the screen is
cracked".

---

## 3. Who can do what

Thirteen grants, and the gaps between them are the design.

| Grant | What it opens |
|---|---|
| `asset.read` | The assets currently out with the people your **data scope** reaches. For most people, their own |
| `asset.read.all` | The whole register, including assets nobody is holding |
| `asset.create` | Put a new asset on the register |
| `asset.update` | Correct an asset's details and condition. Cannot assign or return one |
| `asset.assign` | Hand an asset to an employee |
| `asset.transfer` | Move one straight from one employee to another |
| `asset.return` | Take one back, recording the condition it came back in |
| `asset.repair` | Send one for repair and record what was done |
| `asset.retire` | Take one out of service while the company still holds it |
| `asset.dispose` | Write one off for good. Nothing comes back from this |
| `asset.acknowledge` | Confirm you have received an asset issued to **you**, or report a problem with it |
| `asset.category.manage` | Create, rename, reorder and retire categories |
| `asset.report` | Read the two reports and export them |

### The gap between the two read grants

This is the part worth understanding properly.

`asset.read` **alone** returns the assets currently out with the people your
data scope reaches — for an ordinary employee on an OWN scope that is the laptop
on their own desk; for a manager on REPORTS_AND_OWN it is their team's. Assets
nobody is holding belong to nobody, so they are absent from the narrow read
entirely.

The narrowing is a **WHERE clause**, not a filter applied after the fact: an
asset that is not yours is never fetched. A guessed URL answers **404**, not
403 — telling somebody "that exists but is not yours" turns a guessed id into a
way of confirming what the company owns.

`asset.read.all` widens it to the register. It is also what gates the *history*:
an employee holding a laptop has no business reading which colleague had it
before them, what state that colleague handed it back in, or what the repair
cost. On the asset's own page, a narrow reader simply does not receive those
sections.

### What the seeded roles hold

| Role | Assets |
|---|---|
| **Super Admin** | everything |
| **HR Admin** | everything — read, read all, create, update, assign, transfer, return, repair, retire, dispose, category manage, report, acknowledge |
| **Manager** | `asset.read` and `asset.acknowledge`. **Not** `asset.read.all`: the assets nobody is holding are the company's stock, not their team's |
| **Employee** | `asset.read` and `asset.acknowledge`, and nothing else |
| **Office Boy** | nothing of this module |

An employee holding the widest employee-facing permissions in the product —
including `employee.manage` and `employee.sensitive.read` — still cannot add,
edit or assign a single asset.

---

## 4. The categories

Two levels: a **group** that means something in a report ("what are we spending
on IT kit"), and a **type** underneath it that somebody picks on a form. An
asset may be filed against either level, so a company that only wants "Vehicles"
and never "Car" is not made to invent a second row.

A company is seeded with a starting catalogue — IT Equipment (Laptop, Desktop,
Monitor, Keyboard, Mouse, Headset, Mobile Phone, Tablet, Printer, UPS, Router,
External Hard Drive), Office Equipment (Desk, Chair, Cabinet, Meeting Room
Equipment), Vehicles (Car, Bike) and Other (Access Card, SIM, Other Equipment).

That catalogue is **data, not a hard-coded dropdown.** From the moment it is
seeded it is the company's to rename, reorder or retire, and nothing in the API
or the interface matches on any of those names. The seed is additive: it never
rewrites a category somebody has edited.

**Settings → Asset management** is where they are edited, behind
`asset.category.manage`. A category is **retired**, never deleted — it stops
being offered on the form while every asset already filed against it keeps its
category and every past report still adds up.

Filtering the register by a **group** returns the assets filed under the types
beneath it, not the nothing that is usually filed directly against the group.

---

## 5. The register

**Assets** in the sidebar (signposted to `asset.read.all` holders).

Four tiles — total, available, assigned, under repair — and a table. The tiles
come from **their own endpoint**, not from counting the rows on screen: counting
the page would produce figures that change when somebody clicks next.

Every filter is applied **by the database**, and the page is cut afterwards. So
"showing 1 to 20 of 80" describes the rows underneath it. Search covers the tag,
name, brand, model and serial number — **and the holder's name or employee
number**, matched through the active assignment. An asset Ahmed handed back last
year is not Ahmed's asset and searching his name will not return it.

There is deliberately **no "show everything" toggle.** How much of the register
you are served is decided on the server; a control that widens a query is a
control that has to be checked.

On a phone the table becomes one card per asset: the tag, what the thing is, who
has it, and where it stands.

### Adding one

Only the **asset tag** and the **name** are required. The tag is unique per
company, and so is the serial number when one is given.

A new asset **cannot start Assigned** — there is nobody to assign it to in the
form, and a status saying otherwise would be a claim with no assignment row
behind it. Add it, then assign it.

Purchase price and current value are both optional, both to the cent, and
neither may be negative — a negative asset value does not fail loudly anywhere,
it quietly subtracts from whatever total somebody is reporting upwards.

---

## 6. Handing one over

**Assign** (`asset.assign`) writes the assignment row that makes somebody the
holder, and moves the asset to *Assigned*.

- **Exactly one active assignment per asset**, enforced by the database. Two
  people cannot be issued the same laptop, and the claim is a compare-and-swap
  rather than a read-then-write, so two simultaneous handovers cannot both win.
- The **condition it went out in is required.** A handover with no recorded
  condition is a handover nobody can argue about later, which in practice means
  the employee loses the argument.
- **Accessories** are a list of labels — charger, bag, mouse, keyboard, HDMI
  cable, power adapter, SIM — suggestions rather than a closed set, so a company
  that issues docking stations does not need a release to say so.
- The holder gets an **in-app notification** asking them to confirm they have
  it. If they have no login account, the handover still happens; there is simply
  nobody to notify.

**Transfer** (`asset.transfer`) moves an asset from one person straight to
another without it coming back. The outgoing assignment ends as *Transferred
on* — not *Returned*, because it was not — and the new row records which one it
came from. The new holder is notified the same way.

**Return** (`asset.return`) closes the assignment and records **the condition it
came back in**, which is stored on the handover rather than only on the asset.
One current condition on the asset can never answer "what state was it in when
we gave it to him"; two columns on the handover can. Accessories missing on the
day are derived — issued minus returned, plus anything the person recording the
return adds — and **stored**, so the record survives somebody later editing the
issued list.

### What the employee does

An employee holding `asset.acknowledge` can do exactly two things, and both
reach only their own handover:

- **Acknowledge** — "yes, I have it".
- **Report an issue** — "it arrived with a cracked lid".

Neither writes anything about the asset: not its condition, not its value, not
its status, not its assignment. Reporting an issue raises an incident for HR to
act on and marks the handover *Issue reported*; it does not mark the laptop
damaged. That is HR's decision, made with `asset.update`.

---

## 7. Repairs, damage and loss

**Repairs** (`asset.repair`). Sending an asset for repair records the problem,
the vendor, the dates and the estimated cost, and moves it to *Under repair* —
remembering the status it had before. Completing the repair records what was
done and the actual cost, and returns it to where it came from. Cancelling a
repair does the same without the work.

**Damaged and Lost** (`asset.update`). Both record an incident: what happened,
when, and who reported it. Marking an asset lost does **not** end the company's
claim on it — Lost can go back to Available, because things turn up.

Every one of these is readable on the asset's page, and only to somebody holding
`asset.read.all`.

---

## 8. Retiring and disposing

Two separate grants, deliberately.

**Retire** (`asset.retire`) takes an asset out of service while the company
still has it. It records the date and the reason.

**Dispose** (`asset.dispose`) writes it off for good — **Sold, Scrapped,
Donated, Recycled** or **Other** — with the date, the reason, the final value if
there was one, and who approved it. Nothing comes back from Disposed.

HR Admin holds both, including disposal, and the reason is worth stating: the
alternative is a register where somebody can retire a dead laptop but not write
it off, so the dead laptops accumulate as *Retired* rows forever and the asset
count stops meaning anything.

---

## 9. Documents

Up to **20 files per asset**, each at most **10 MB**: Invoice, Purchase receipt,
Warranty, Repair receipt, Handover document, Other.

This reuses the existing attachment infrastructure — the same object store, the
same byte sniffing, the same accepted formats as case attachments and candidate
documents, with its own key prefix. No second storage system was built.

Reading a document needs `asset.read.all`; adding or removing one needs
`asset.update`.

---

## 10. The asset's own page

Everything known about one thing: its details, who has it now, the handover
history, the repairs, the incidents, the documents, and a **timeline**.

The timeline is read back from the **audit log**, not from a history table of
its own. Every lifecycle action already writes one audit row with a summary
written for a person to read — *"Assigned LAP-0021 to Hassan Raza in Good
condition"* — and this renders those sentences. A second history table would be
a second thing to keep in step with the first, and the one that drifted would be
the one on screen. Each event carries a heading and a colour; an action the
timeline has never seen still renders, as its audit sentence alone.

What the page **offers** you is decided on the server from your grants and the
asset's state together. The browser never reasons about statuses: two copies of
that rule eventually disagree, and the copy a person sees is the wrong one.

---

## 11. The dashboard

**Asset dashboard** in the sidebar, behind `asset.read.all`.

The whole screen is **one request**. Every figure on it is a question about the
same rows asked at the same instant; nine requests would answer them at nine
instants and produce a page whose tiles do not add up to its own lists — and
nothing on the screen would say so.

There is **no narrow version** of this screen, and that is why it needs the wide
grant rather than `asset.read`. "Total assets: 1, no warranties expiring" is not
a smaller dashboard, it is a misleading one. An employee's own view of their kit
is the card on their home page.

**Above:** total assets, available, assigned, and the register's current value
with its purchase value beneath.

**Six alerts,** and they split into two kinds:

| Alert | How you drill in |
|---|---|
| Warranty expiring | a list on this page |
| Under repair | links to the register, filtered |
| Damaged | links to the register, filtered |
| Lost | links to the register, filtered |
| Not returned | a list on this page |
| Pending clearance | a list on this page |

The three that link are a *status*, so the drill-down is the register with that
filter applied — a second copy of those rows here would be a second thing to
keep in step. The other three cannot be reached by filtering a status: a
warranty running out is date arithmetic, an asset "not returned" is a fact about
the **holder's employment**, and a person pending clearance is not an asset at
all.

**The warranty window** is 30, 60, 90 or 180 days, and it is measured against
**the company's today**, in the company's timezone. A browser in another
timezone cannot report a warranty as expiring tomorrow when the office's
calendar says it expired yesterday. Assets that are Retired or Disposed are
excluded: a dead laptop's expiring cover is not anybody's problem, and a list
that says it is trains people to ignore the list.

**Counts are exact; lists are capped** at 50 rows. The count keeps telling the
truth about the size of the problem while the list stays the shortlist somebody
acts on this morning, and the page says so when it is showing one of many.

**Two breakdowns** — by category and by department — carrying the money as well
as the count, because a department with forty chairs is not more important than
one with eight laptops. Assets filed under **no** category or **no** department
keep their own bucket rather than being dropped: the parts must sum to the whole
or the dashboard stops being trustworthy.

---

## 12. Clearance

Somebody who has **resigned** or been **terminated** and is still holding
something appears under *People pending clearance*, and the same block appears
on their own employee record.

Three states, not two:

| State | Meaning |
|---|---|
| **Cleared** | nothing outstanding |
| **Partially cleared** | something outstanding, something already back |
| **Pending** | something outstanding and nothing back |

The middle one exists because it is the state an exit interview is actually
conducted in. A two-valued flag reports that person as *Pending* —
indistinguishable from somebody who has handed back nothing — and sends HR
looking for everything when they are waiting on one thing.

**Clearance counts; it never acts.** Nothing anywhere in this module marks an
asset returned as part of a clearance. A clearance screen that could tick its
own boxes is a screen that says the laptop came back when it did not. HR records
the real return through **Return**, and this counts the result.

An asset the person lost or broke is counted separately **and stays
outstanding**, because neither of those is the same as having handed it back.

---

## 13. The two reports

**Asset reports** in the sidebar, behind `asset.report`.

One screen, two reports, and the switch at the top is the honest way to say so —
because they have **different grains**:

| Report | One row per | Answers |
|---|---|---|
| **Asset report** | asset | what do we own, and what is it worth |
| **Employee register** | handover | what is this person holding |

Eighty laptops are eighty rows in the first. A person with a laptop, a monitor
and an access card is three rows in the second. Flattening the second into the
first would force one row per asset with a person's name on it, which silently
drops everybody who has handed something back — exactly the list HR cannot
afford to be missing from.

The employee register has a **scope**: *Currently held* (the audit question) or
*Every handover* (the history, when an asset has been round three desks).

### What they share, and what they do not

Both accept the same filters: search, category, department, team, status,
condition, location, warranty, purchase date range and handover date range.
Every one is applied **in the database** — an export is the place where "filter
in the browser" stops being a rendering bug and becomes a spreadsheet with the
wrong rows in it, emailed to somebody.

> **One filter means something different here from on the register.** On the
> list screen, *department* is a fact about the **asset** — the department a
> laptop is booked to, which it keeps while it sits in a cupboard. On these two
> reports it is a fact about the **holder**, and *team* sitting beside it is the
> proof: an asset has no team. It is also the column the report prints, so the
> filter and the column agree.
>
> The consequence: **narrowing a report by department excludes assets nobody is
> holding**, because unheld stock has no holder and so no department. That is
> the right answer to "what is Development holding".

### The footer

The totals cover **every row the filters match**, not the page on screen. A
footer that totalled the visible twenty would change when somebody pressed next,
which is the most quietly wrong thing a report can do — the number looks like an
answer and is a description of the scroll position.

### The export

**Export CSV** carries the same filters and the same columns as the table, sent
to the server rather than dumped from the browser. UTF-8 with a byte-order mark
so Excel opens names correctly.

Three things worth knowing:

- **A reporting grant exports what you can see.** The data-scope narrowing is
  applied to a report exactly as it is to the list screen. `asset.report` is
  permission to take the register away as a file; it never widens which rows are
  in it.
- **An export of more than 20,000 rows is refused, not truncated,** with a
  message asking you to narrow the filters. A silently shortened export is a
  spreadsheet nobody can tell is wrong.
- **Every export is recorded** in the audit log as `asset.report.export`, with
  who, when, which report, and how many rows and columns left the building.

---

## 14. What an employee sees

Nothing of the register. Their own kit, in two places:

- **the card on their home page** — what they have been issued, and anything
  waiting on them to confirm;
- **the Assets tab on their own profile** — the same, with their handover
  history.

They may **acknowledge** a handover and **report a problem** with one. That is
the whole of their write access, and both reach only their own handover.

They cannot see what a colleague is holding, what anything cost, who had their
laptop before them, or any asset that is sitting in a cupboard.

A **manager** sees the same for their reporting line, by data scope, and still
not the unheld stock.

---

## 15. The endpoints

All under `/api/v1`.

| Method | Path | Grant |
|---|---|---|
| GET | `/assets` | `asset.read` |
| GET | `/assets/summary` | `asset.read` |
| GET | `/assets/:id` | `asset.read` |
| GET | `/assets/:id/activity` | `asset.read.all` |
| POST | `/assets` | `asset.create` |
| PATCH | `/assets/:id` | `asset.update` |
| GET | `/assets/dashboard` | `asset.read.all` |
| GET | `/assets/reports/assets` · `/assets/reports/assets.csv` | `asset.read` + `asset.report` |
| GET | `/assets/reports/employees` · `/assets/reports/employees.csv` | `asset.read` + `asset.report` |
| GET · POST | `/assets/categories` | read: `asset.read` · write: `asset.category.manage` |
| PATCH | `/assets/categories/:id` | `asset.category.manage` |
| POST | `/assets/:id/assign` | `asset.assign` |
| POST | `/assets/:id/return` | `asset.return` |
| POST | `/assets/:id/transfer` | `asset.transfer` |
| GET · POST | `/assets/:id/repairs` | read: `asset.read.all` · write: `asset.repair` |
| PATCH | `/assets/:id/repairs/:repairId` | `asset.repair` |
| GET · POST | `/assets/:id/incidents` | read: `asset.read.all` · write: `asset.update` |
| POST | `/assets/:id/retire` | `asset.retire` |
| POST | `/assets/:id/dispose` | `asset.dispose` |
| GET · POST | `/assets/:id/documents` | read: `asset.read.all` · write: `asset.update` |
| GET · DELETE | `/assets/:id/documents/:documentId` | read: `asset.read.all` · delete: `asset.update` |
| GET | `/assets/my` | `asset.read` |
| POST | `/assets/assignments/:id/acknowledge` | `asset.acknowledge` |
| POST | `/assets/assignments/:id/report-issue` | `asset.acknowledge` |
| GET | `/employees/:id/assets` | `asset.read` + the employee must be in your data scope |

There is **no DELETE** for an asset, a handover, a repair or an incident. The
omission is the design.

---

## 16. What is not here

Stated plainly, because this documentation does not describe features that do
not exist:

- **No approval step.** Assigning, retiring and disposing happen when somebody
  with the grant does them. They are audited, not routed for approval.
- **No depreciation schedule.** There is a purchase price and a current value,
  and the current value is a number somebody sets. Nothing calculates it.
- **No barcode or QR scanning.** The asset tag is typed or searched for.
- **No stock levels or reorder points.** This is a register of individual
  things, not an inventory of quantities.
- **No email.** The two handover notifications are in-app only, in line with the
  rest of the product — see the [troubleshooting guide](HRMS-TROUBLESHOOTING.md)
  on the mail provider.
- **No bulk import.** Assets are added one at a time.
- **Nothing reaches payroll.** An asset's purchase price is a number on an
  asset. Issuing somebody a laptop creates no salary row, no deduction and no
  payroll input of any kind.

---

## 17. See also

- [Admin manual §17](HRMS-ADMIN-MANUAL.md#17-assets) — the operator's walkthrough
- [Employee guide](HRMS-EMPLOYEE-GUIDE.md#your-assets) — what staff see
- [Feature matrix](HRMS-FEATURE-MATRIX.md#assets) — implementation status, line by line
