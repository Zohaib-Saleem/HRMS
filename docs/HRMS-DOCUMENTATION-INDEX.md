# HRMS documentation

Everything here describes what the system **actually does today**, verified
against the source: the Prisma schema, the API routes, the permission
catalogue, the React pages and the audit suites. Where the interface and the
backend disagree, the disagreement is written down rather than smoothed over.

Nothing in these documents describes a feature that is not implemented. Where
something is missing, it says so.

## Start here

| Document | Read it if you are |
|---|---|
| [Quick start](HRMS-QUICK-START.md) | setting the system up for the first time |
| [User manual](HRMS-USER-MANUAL.md) | looking for the overview and how modules fit together |
| [Feature matrix](HRMS-FEATURE-MATRIX.md) | asking "is X implemented?" |

## By role

| Document | Audience |
|---|---|
| [Employee guide](HRMS-EMPLOYEE-GUIDE.md) | every member of staff |
| [Manager guide](HRMS-MANAGER-GUIDE.md) | managers and heads of department |
| [Admin manual](HRMS-ADMIN-MANUAL.md) | HR administrators and system administrators |
| [Payroll guide](HRMS-PAYROLL-GUIDE.md) | whoever runs payroll |

## By subject

| Document | Covers |
|---|---|
| [Attendance guide](HRMS-ATTENDANCE-GUIDE.md) | the full attendance lifecycle and every calculation rule |
| [Device guide](HRMS-DEVICE-GUIDE.md) | ZKTeco K50 integration, pull and ADMS push |
| [Troubleshooting](HRMS-TROUBLESHOOTING.md) | when something is wrong |

## Technical references

These predate this manual and are written for developers rather than operators.

| Document | Covers |
|---|---|
| [Attendance devices](attendance-devices.md) | the device protocols, in implementation terms |
| [Payroll](payroll.md) | the payroll engine, in implementation terms |
| [Architecture](architecture.md) | how the codebase is laid out |
| [Roadmap](roadmap.md) | what was built in each phase, and what was deliberately not |
| [Feature map](feature-map.md) | the original scoping decisions |

## Reading this inside the application

Everything here is also available from **Help & Documentation** in the sidebar,
with search and cross-links. The files in this directory are the source: the
application reads them at request time, so editing one changes what staff see
without a rebuild or a redeploy.

### Adding a document

1. Write the `.md` file into `docs/`.
2. Add one entry to `DOC_ENTRIES` in
   `apps/api/src/modules/docs/catalogue.ts`:

```ts
{
  slug: 'leave',                    // the URL: /help/leave
  file: 'HRMS-LEAVE-GUIDE.md',      // the file in docs/
  title: 'Leave guide',
  summary: 'One line for the card on the documentation home.',
  category: 'workforce',            // a key from DOC_CATEGORIES
  permission: PERMISSIONS.LEAVE_MANAGE,  // omit for "any signed-in user"
  order: 3,
}
```

That is the whole procedure. Nothing is copied, generated or bundled, and the
frontend needs no change: the catalogue drives the home page, the search index,
the previous/next navigation and the link rewriting.

Two things worth knowing:

- **The slug is not a path.** It is a key into that map, which is what makes
  path traversal impossible: `../../.env` is not a key, so it resolves to
  nothing. Never build a filename from a request.
- **`permission` gates the document server-side.** A reader without it does not
  see the document listed, cannot open it directly, does not match it in search,
  and has links to it flattened to plain text in other documents.

Supported markdown: headings, paragraphs, bullet and numbered lists (one level
of nesting), GFM tables, fenced code, block quotes, horizontal rules, and inline
bold, italic, code, links and strikethrough. Anything else degrades to a
paragraph rather than disappearing. Raw HTML is **not** rendered — the parser
produces a typed block tree that React renders as components, so a document
cannot inject markup.

---

## Three things to know before you read anything else

**The physical ZKTeco K50 has never been connected.** Both the pull and the
push integrations are implemented and tested against a simulator that speaks
the real protocol over a real socket. That is evidence the implementation is
internally consistent, not evidence it matches your hardware. See the
[device guide](HRMS-DEVICE-GUIDE.md).

**Logins are created by invitation, never with a password.** An administrator
invites somebody from **Settings → Users**; they set their own password through
an emailed link. No password is ever generated, displayed or transmitted, so an
administrator never knows anybody's. See
[User management](HRMS-ADMIN-MANUAL.md#13-user-management).

**Performance and Documents do not exist.** They appear in the sidebar as
greyed-out "planned" entries. There is no database table, no API and no screen
behind either.
