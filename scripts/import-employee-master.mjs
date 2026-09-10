/**
 * Employee master import from the HR roster workbook.
 *
 * Reads "Master Sheet.xlsx" and reconciles it against the HRMS employee
 * records. Dry-run by default: it prints the plan and writes nothing. Only
 * `--apply` writes, and even then it never touches attendance, payroll, leave,
 * loan or contract history, and never touches punch-code mappings.
 *
 *   npx dotenv -e .env -- npx tsx scripts/import-employee-master.mjs --file "/root/Master Sheet.xlsx"
 *   npx dotenv -e .env -- npx tsx scripts/import-employee-master.mjs --file "..." --apply
 *
 * Decisions this encodes, all of them signed off before it was written:
 *   - Employees are matched on `employeeNumber` and nothing else. The roster's
 *     "Employee ID" column has been observed to hold a device punch code for at
 *     least two people, one of whom is a different employee entirely, so a
 *     fallback match on punch code would corrupt the wrong record.
 *   - Rows with a blank or zero Employee ID are never imported.
 *   - Yearly salary columns take effect on 31 December of their year - they
 *     record what somebody was on by the end of it - except the year still in
 *     progress, which takes effect today, because a salary dated into the
 *     future is one payroll cannot see. The joining salary takes effect on the
 *     hire date.
 *   - "Unpaid", "-" and blank salaries are unknown, not zero. A zero would flow
 *     into payroll as a real figure.
 *   - Official Email and Role overwrite what HRMS holds. Every other field is
 *     filled only where HRMS is empty; a genuine disagreement is reported for a
 *     person to settle, never resolved by this script.
 */
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
// A sheet that cannot be read safely stops the whole import unless the operator
// says otherwise, so a broken Leavers tab cannot quietly become a partial run.
const SKIP_REFUSED = process.argv.includes('--skip-refused-sheets');
const fileArg = process.argv.indexOf('--file');
const FILE = fileArg > -1 ? process.argv[fileArg + 1] : '/root/Master Sheet.xlsx';

// --------------------------------------------------------------- cell reading

/** Excel gives dates, numbers, strings and formula results; flatten them. */
function cell(row, idx) {
  const v = row.getCell(idx).value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? null;
    if ('text' in v) return v.text ?? null;
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    return null;
  }
  return v;
}

function text(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function date(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  return null;
}

/**
 * A salary cell. "Unpaid", "-" and blank all mean "not known", which is not the
 * same as nothing being paid: returning 0 here would put a real zero in front of
 * payroll. Only an actual number counts.
 */
function money(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return null;
}

/** The roster's Employee ID, or null when it is blank or the placeholder 0. */
function employeeNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n === 0) return null;
  return String(Math.trunc(n));
}

const norm = (s) => (s ?? '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Treat a stored placeholder as the absence of a value.
 *
 * Fourteen employees carry "--" as their father's name, which records that
 * nobody knew it rather than that it is two hyphens. Counting those as real
 * would turn every one of them into a conflict for a person to adjudicate, when
 * the roster simply has the answer.
 */
const blankish = (v) => v === null || v === undefined || (typeof v === 'string' && /^[\s\-.,_/]*$/.test(v));

// ------------------------------------------------------------------- mappings

const STATUS = {
  'on job': { status: 'ACTIVE' },
  'notice period': { status: 'ACTIVE', useLeavingDateAsTermination: true },
  resigned: { status: 'RESIGNED' },
  terminate: { status: 'TERMINATED' },
  terminated: { status: 'TERMINATED' },
  'end of services': { status: 'INACTIVE' },
};

/**
 * "Permanent" and "Probation" answer whether an employment is confirmed, which
 * is a different question from EmploymentType. They land in confirmationStatus
 * and leave the type as FULL_TIME, which is what they both are.
 */
const EMPLOYMENT = {
  permanent: { employmentType: 'FULL_TIME', confirmationStatus: 'Permanent' },
  probation: { employmentType: 'FULL_TIME', confirmationStatus: 'Probation' },
  probabtion: { employmentType: 'FULL_TIME', confirmationStatus: 'Probation' },
  contract: { employmentType: 'CONTRACT', confirmationStatus: null },
  intern: { employmentType: 'INTERN', confirmationStatus: null },
  internship: { employmentType: 'INTERN', confirmationStatus: null },
};

const GENDER = { m: 'MALE', male: 'MALE', f: 'FEMALE', female: 'FEMALE' };

const SALARY_YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

/** Today, at UTC midnight, so effective dates line up with the DATE columns. */
const TODAY = (() => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
})();
// --------------------------------------------------------------- sheet reading

/** Header label -> column index, so the code names columns instead of counting. */
function headerMap(sheet) {
  const map = new Map();
  const row = sheet.getRow(1);
  for (let i = 1; i <= sheet.columnCount; i += 1) {
    const label = text(cell(row, i));
    if (!label) continue;
    // "Institution Name" and "Year of Completion" each appear twice, once for
    // the bachelor's block and once for the master's. Keep both positions.
    const key = map.has(label) ? `${label}#2` : label;
    map.set(key, i);
  }
  return map;
}

function readRows(sheet) {
  const cols = headerMap(sheet);
  const get = (row, label) => (cols.has(label) ? cell(row, cols.get(label)) : null);
  const out = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    if (!text(get(row, 'Name'))) continue;
    out.push({ rowNumber: r, get: (label) => get(row, label), raw: row, cols });
  }
  return { cols, rows: out };
}

/**
 * Refuse a sheet whose data does not sit under its own headers.
 *
 * The Leavers sheet shipped in this workbook is laid out inconsistently: some
 * rows follow its header, some follow the Master Sheet's, and several carry
 * values in columns past the end of its header row entirely. Resignation and
 * leaving dates are exactly what that sheet exists to carry, so importing it
 * misaligned would write the wrong last-working-day for a former employee.
 * Rather than guess a per-row layout, this checks the columns whose type is
 * unmistakable and refuses the whole sheet if any row disagrees.
 *
 * Structural only. A CNIC with the wrong number of digits is a bad value in the
 * right column and is handled per-row further down; it says nothing about
 * whether the sheet is aligned, and refusing a whole sheet over one is wrong.
 */
function alignmentProblems(sheet, { cols, rows }) {
  const problems = [];
  const lastHeaderCol = Math.max(...cols.values());

  for (const r of rows) {
    const beyond = [];
    for (let i = lastHeaderCol + 1; i <= sheet.columnCount; i += 1) {
      if (cell(r.raw, i) !== null) beyond.push(sheet.getColumn(i).letter);
    }
    if (beyond.length) {
      problems.push(`row ${r.rowNumber} (${text(r.get('Name'))}): data in ${beyond.join(', ')}, past the last header column`);
    }

    const dob = r.get('Date of Birth');
    if (dob !== null && !(dob instanceof Date)) {
      problems.push(`row ${r.rowNumber} (${text(r.get('Name'))}): "Date of Birth" holds ${JSON.stringify(text(dob))}, not a date`);
    }

    for (const label of ['Probation End Date', 'Resignation Date', 'Leaving Date']) {
      const v = r.get(label);
      if (v === null) continue;
      const s = text(v);
      if (!(v instanceof Date) && s !== '-') {
        problems.push(`row ${r.rowNumber} (${text(r.get('Name'))}): "${label}" holds ${JSON.stringify(s)}, not a date`);
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------- planning

/**
 * The salary timeline a roster row implies.
 *
 * The joining salary starts on the hire date and each year column starts on 1
 * January of its year. Consecutive equal amounts collapse: a year that repeats
 * the previous figure is not a revision and must not open a new salary record.
 */
function salaryTimeline(r, hireDate) {
  const points = [];
  const joining = money(r.get('Joining Salary'));
  if (joining !== null && hireDate) points.push({ effectiveFrom: hireDate, amount: joining, source: 'Joining Salary' });

  for (const year of SALARY_YEARS) {
    const amount = money(r.get(`Salary ${year}`));
    if (amount === null) continue;
    // 31 December of the year. The column records what somebody was on by the
    // end of that year, and dating it there is what keeps a mid-year joiner's
    // starting salary and their first year-end figure as two separate facts
    // instead of two amounts fighting over the hire date.
    //
    // Still clamped to the hire date for the pathological case of somebody who
    // joined in the last days of December: no pay takes effect before day one.
    // The year in progress is the exception: 31 December has not happened yet,
    // and dating a current salary there would leave payroll reading last year's
    // figure until the year turned - or, for anyone hired this year, no salary
    // in force at all. The current year takes effect today instead.
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const stated = yearEnd > TODAY ? TODAY : yearEnd;
    const effectiveFrom = hireDate && hireDate > stated ? hireDate : stated;
    points.push({ effectiveFrom, amount, source: `Salary ${year}` });
  }

  points.sort((a, b) => a.effectiveFrom - b.effectiveFrom);

  const timeline = [];
  const collisions = [];
  for (const p of points) {
    const prev = timeline[timeline.length - 1];
    if (prev && prev.amount === p.amount) continue;
    if (prev && prev.effectiveFrom.getTime() === p.effectiveFrom.getTime()) {
      // Two different figures claiming the same effective date - typically a
      // joining salary and the year column for the year they joined. Which one
      // is the truth is a question about that person's offer, not something to
      // settle by ordering, so the whole timeline goes for review.
      collisions.push(`${prev.source} (${prev.amount}) and ${p.source} (${p.amount}) both start ${p.effectiveFrom.toISOString().slice(0, 10)}`);
      continue;
    }
    timeline.push(p);
  }
  return { timeline, collisions };
}

function educationRows(r) {
  const out = [];
  const blocks = [
    { level: 'Bachelors', degree: "Bachelor's Degree", institution: 'Institution Name', year: 'Year of Completion' },
    { level: 'Masters', degree: "Master's Degree", institution: 'Institution Name#2', year: 'Year of Completion#2' },
  ];
  for (const b of blocks) {
    const degree = text(r.get(b.degree));
    const institution = text(r.get(b.institution));
    const rawYear = r.get(b.year);
    const yearCompleted = typeof rawYear === 'number' && rawYear > 1900 && rawYear < 2100 ? Math.trunc(rawYear) : null;
    if (!degree && !institution && yearCompleted === null) continue;
    out.push({ level: b.level, degree, institution, yearCompleted });
  }
  return out;
}

/**
 * Scalar fields, with the disposition each one gets.
 *
 * `overwrite` is set only where that was explicitly approved. Everything else
 * fills a gap and otherwise reports: a roster and a database disagreeing about
 * someone's CNIC is a question for a person, not something to settle by
 * whichever source was read last.
 */
function scalarFields(r) {
  const employment = EMPLOYMENT[norm(text(r.get('Employment Type')))] ?? null;
  const experienceYears = r.get('Previous Experience');

  return [
    { field: 'workEmail', value: text(r.get('Official Email')), overwrite: true, valid: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) },
    { field: 'jobTitle', value: text(r.get('Role')), overwrite: true },
    { field: 'fatherName', value: text(r.get("Father's Name")) },
    { field: 'dateOfBirth', value: date(r.get('Date of Birth')), valid: isPlausibleBirthDate },
    { field: 'nationalId', value: text(r.get('CNIC')), sensitive: true, valid: isCnic },
    { field: 'phone', value: text(r.get('Mobile Number')) },
    { field: 'personalEmail', value: text(r.get('Personal Email')), valid: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) },
    { field: 'presentAddress', value: text(r.get('Address')) },
    { field: 'bankName', value: text(r.get('Bank Name')), sensitive: true },
    { field: 'bankAccountNumber', value: text(r.get('Account Number')), sensitive: true },
    { field: 'gender', value: GENDER[norm(text(r.get('Gender')))] ?? null },
    { field: 'hireDate', value: date(r.get('Joining Date')) },
    { field: 'confirmationDate', value: date(r.get('Probation End Date')) },
    { field: 'nextIncrementDueDate', value: date(r.get('Next Increment Due Date')) },
    { field: 'employmentType', value: employment?.employmentType ?? null },
    { field: 'confirmationStatus', value: employment?.confirmationStatus ?? null },
    {
      field: 'priorExperienceMonths',
      value: typeof experienceYears === 'number' && experienceYears > 0 ? Math.round(experienceYears * 12) : null,
    },
  ];
}

const isCnic = (v) => /^\d{5}-?\d{7}-?\d$/.test(v);

/**
 * A birth date has to be in the past and belong to someone old enough to be
 * employed. Three rows in this roster carry a date in 2023-2025 here, which is
 * a mistake rather than a fact about a colleague.
 */
function isPlausibleBirthDate(v) {
  const year = v.getUTCFullYear();
  return year >= 1940 && year <= new Date().getUTCFullYear() - 14;
}

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return norm(a) === norm(b);
}

// ----------------------------------------------------------------------- main

async function buildPlan() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  const company = await prisma.company.findFirstOrThrow({ select: { id: true, currency: true } });
  const employees = await prisma.employee.findMany({
    where: { companyId: company.id },
    include: {
      department: { select: { name: true } },
      salaries: { select: { id: true, amount: true, effectiveFrom: true } },
      education: { select: { level: true } },
    },
  });
  const byNumber = new Map(employees.map((e) => [e.employeeNumber, e]));
  // Punch codes are loaded for one reason: to recognise a roster row whose
  // "Employee ID" is actually a device PIN. They are never used to match, and
  // nothing here writes to them.
  const punchMappings = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId: company.id },
    select: { deviceUserId: true, employee: { select: { employeeNumber: true, firstName: true, lastName: true } } },
  });
  const byPunchCode = new Map(punchMappings.map((m) => [m.deviceUserId, m.employee]));

  const departments = await prisma.department.findMany({ where: { companyId: company.id } });
  const deptByName = new Map(departments.map((d) => [norm(d.name), d]));
  const teams = await prisma.team.findMany({ where: { companyId: company.id } });
  const teamByName = new Map(teams.map((t) => [norm(t.name), t]));

  const plan = {
    company,
    updates: [],
    creates: [],
    statusChanges: [],
    salaries: [],
    education: [],
    conflicts: [],
    skipped: [],
    rejectedValues: [],
    unresolved: [],
    refusedSheets: [],
    newDepartments: new Set(),
    pendingDepartments: [],
    newTeams: new Map(),
  };

  for (const sheetName of ['Master Sheet', 'Leavers']) {
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) {
      plan.refusedSheets.push({ sheetName, reason: 'sheet not present in the workbook' });
      continue;
    }
    const parsed = readRows(sheet);
    const problems = alignmentProblems(sheet, parsed);
    if (problems.length) {
      plan.refusedSheets.push({ sheetName, reason: 'column alignment does not match the header', problems });
      continue;
    }
    for (const r of parsed.rows) {
      planRow(plan, sheetName, r, { byNumber, byPunchCode, deptByName, teamByName, company });
    }
  }

  return plan;
}

function planRow(plan, sheetName, r, ctx) {
  const name = text(r.get('Name'));
  const number = employeeNumber(r.get('Employee ID'));
  const where = `${sheetName} row ${r.rowNumber}`;

  if (!number) {
    plan.skipped.push({
      where,
      name,
      reason: r.get('Employee ID') === null ? 'Employee ID is blank' : 'Employee ID is 0',
    });
    return;
  }

  const existing = ctx.byNumber.get(number);
  if (!existing) {
    // The number is not an employee number. Before treating the row as a new
    // joiner, check whether it is a device punch code: this roster has been
    // observed to carry one in the Employee ID column, once for a person who
    // already exists under a different number, and once for a code belonging to
    // somebody else entirely. Creating either would be a duplicate or, worse,
    // an employee filed under a stranger's identity.
    const punchOwner = ctx.byPunchCode.get(number);
    if (punchOwner) {
      const owner = `${punchOwner.firstName} ${punchOwner.lastName}`.trim();
      const sameHuman = norm(owner) === norm(name);
      plan.unresolved.push({
        where, number, name,
        what: sameHuman
          ? `"Employee ID" ${number} is this person's PUNCH CODE, not their employee number (they are ${punchOwner.employeeNumber}). Not created, not matched - correct the roster.`
          : `"Employee ID" ${number} is the PUNCH CODE of a DIFFERENT employee (${punchOwner.employeeNumber} ${owner}). Not created, not matched - correct the roster.`,
      });
      return;
    }

    // Nothing is created blind. A roster row with an ID the database has never
    // seen is a new joiner or a typo, and which of the two it is decides
    // whether creating a record is right.
    plan.creates.push({ where, name, number, status: text(r.get('Status')), department: text(r.get('Department')) });
    return;
  }

  // --- scalar fields -------------------------------------------------------
  const sets = {};
  const fills = [];
  const overwrites = [];
  for (const f of scalarFields(r)) {
    if (f.value === null || f.value === undefined) continue;
    if (f.valid && !f.valid(f.value)) {
      plan.rejectedValues.push({ where, number, name, field: f.field, value: f.sensitive ? '<redacted>' : show(f.field, f.value) });
      continue;
    }
    const current = blankish(existing[f.field]) ? null : existing[f.field];
    if (current === null) {
      sets[f.field] = f.value;
      fills.push(f.field);
    } else if (sameValue(current, f.value)) {
      // already agrees
    } else if (f.overwrite) {
      sets[f.field] = f.value;
      overwrites.push({ field: f.field, from: current, to: f.value });
    } else {
      plan.conflicts.push({
        where,
        number,
        name,
        field: f.field,
        excel: f.sensitive ? '<redacted>' : f.value,
        hrms: f.sensitive ? '<redacted>' : current,
      });
    }
  }

  if (norm(name) !== norm(`${existing.firstName}${existing.lastName}`)) {
    // Names are never rewritten from the roster: several are shortened, several
    // carry a different surname, and telling a spelling variant from a wrong
    // record is a judgement the importer is in no position to make.
    plan.conflicts.push({ where, number, field: 'name', excel: name, hrms: `${existing.firstName} ${existing.lastName}` });
  }

  // --- status --------------------------------------------------------------
  const statusLabel = norm(text(r.get('Status')));
  const mapped = STATUS[Object.keys(STATUS).find((k) => norm(k) === statusLabel) ?? ''] ?? null;
  if (!mapped) {
    plan.unresolved.push({ where, number, name, what: `status ${JSON.stringify(text(r.get('Status')))} has no mapping` });
  } else {
    const resignation = date(r.get('Resignation Date'));
    const leaving = date(r.get('Leaving Date'));
    if (mapped.status !== existing.status) sets.status = mapped.status;
    if (resignation) sets.resignationDate = resignation;
    if (leaving) sets.terminationDate = leaving;
    if (mapped.status !== existing.status || resignation || leaving) {
      plan.statusChanges.push({
        where, number, name,
        from: existing.status, to: mapped.status,
        resignationDate: resignation, terminationDate: leaving,
      });
    }
  }

  // --- department and team -------------------------------------------------
  const deptName = text(r.get('Department'));
  if (deptName) {
    const dept = ctx.deptByName.get(norm(deptName));
    if (!dept) {
      plan.newDepartments.add(deptName);
      if (!existing.departmentId) plan.pendingDepartments.push({ employeeId: existing.id, number, name, deptName });
    } else if (dept.id !== existing.departmentId && existing.departmentId) {
      plan.conflicts.push({ where, number, name, field: 'department', excel: deptName, hrms: existing.department?.name ?? null });
    } else if (!existing.departmentId) {
      sets.departmentId = dept.id;
      fills.push('departmentId');
    }
  }
  // Team is deliberately not imported. In this roster a team spans departments -
  // "GamEmpires" covers all eight - but HRMS models a Team as belonging to
  // exactly one Department, and is unique on (departmentId, name). There is no
  // honest way to store one of these without either picking a department at
  // random or splitting one team into eight. That is a modelling decision, not
  // an import detail, so the names are collected and reported instead.
  const teamName = text(r.get('Team Name'));
  if (teamName && !ctx.teamByName.has(norm(teamName))) {
    const spans = plan.newTeams.get(teamName) ?? new Set();
    if (deptName) spans.add(deptName);
    plan.newTeams.set(teamName, spans);
  }

  // --- salary --------------------------------------------------------------
  const hireDate = date(r.get('Joining Date')) ?? existing.hireDate;
  const { timeline, collisions } = salaryTimeline(r, hireDate);
  if (collisions.length) {
    plan.unresolved.push({ where, number, name, what: `salary history not written - ${collisions.join('; ')}` });
  } else if (timeline.length) {
    if (existing.salaries.length) {
      plan.unresolved.push({
        where, number, name,
        what: `already has ${existing.salaries.length} salary record(s); roster history not written, needs a person to reconcile`,
      });
    } else {
      plan.salaries.push({ where, number, name, employeeId: existing.id, timeline });
    }
  }

  // --- education -----------------------------------------------------------
  const haveLevels = new Set(existing.education.map((e) => e.level));
  const rows = educationRows(r).filter((e) => !haveLevels.has(e.level));
  if (rows.length) plan.education.push({ where, number, name, employeeId: existing.id, rows });

  if (Object.keys(sets).length) {
    plan.updates.push({ where, number, name, employeeId: existing.id, sets, fills, overwrites });
  }
}

// -------------------------------------------------------------------- preview

const SENSITIVE = new Set(['nationalId', 'bankAccountNumber', 'bankName']);
const money0 = (n) => Number(n).toLocaleString('en-US');
const day = (d) => (d ? d.toISOString().slice(0, 10) : '-');
const show = (field, v) => (SENSITIVE.has(field) ? '<redacted>' : v instanceof Date ? day(v) : String(v));

function printPreview(plan) {
  const h = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

  h('REFUSED SHEETS');
  if (!plan.refusedSheets.length) console.log('  none');
  for (const s of plan.refusedSheets) {
    console.log(`  ${s.sheetName}: ${s.reason}`);
    for (const p of (s.problems ?? []).slice(0, 12)) console.log(`      - ${p}`);
    if ((s.problems ?? []).length > 12) console.log(`      ... and ${s.problems.length - 12} more`);
  }

  if (plan.refusedSheets.length) {
    console.log('\n  Everything below covers only the sheets that parsed. Rows on a refused');
    console.log('  sheet are neither updated nor created, and no status change is applied.');
  }

  h(`A. EXISTING EMPLOYEES TO UPDATE (${plan.updates.length})`);
  for (const u of plan.updates) {
    const ov = u.overwrites.map((o) => `${o.field}: ${show(o.field, o.from)} -> ${show(o.field, o.to)}`);
    console.log(`  ${u.number.padEnd(6)} ${(u.name ?? '').padEnd(26)} fill[${u.fills.join(',') || '-'}]`);
    for (const o of ov) console.log(`         overwrite ${o}`);
  }

  h(`B. NEW EMPLOYEES TO CREATE (${plan.creates.length})`);
  if (!plan.creates.length) console.log('  none');
  for (const c of plan.creates) console.log(`  ${c.where}  id=${c.number}  ${c.name}  ${c.department ?? ''}  ${c.status ?? ''}`);

  h(`C. STATUS CHANGES / LEAVERS (${plan.statusChanges.length})`);
  if (!plan.statusChanges.length) console.log('  none');
  for (const s of plan.statusChanges) {
    console.log(`  ${s.number.padEnd(6)} ${(s.name ?? '').padEnd(26)} ${s.from} -> ${s.to}   resigned=${day(s.resignationDate)} left=${day(s.terminationDate)}`);
  }

  const salaryRows = plan.salaries.reduce((n, s) => n + s.timeline.length, 0);
  h(`D. SALARY HISTORY (${plan.salaries.length} employees, ${salaryRows} salary records, ${salaryRows - plan.salaries.length} revisions)`);
  for (const s of plan.salaries.slice(0, 12)) {
    console.log(`  ${s.number.padEnd(6)} ${(s.name ?? '').padEnd(26)} ${s.timeline.map((t) => `${day(t.effectiveFrom)}=${money0(t.amount)}`).join('  ')}`);
  }
  if (plan.salaries.length > 12) console.log(`  ... and ${plan.salaries.length - 12} more employees`);

  const eduRows = plan.education.reduce((n, e) => n + e.rows.length, 0);
  h(`E. EDUCATION (${plan.education.length} employees, ${eduRows} records)`);
  for (const e of plan.education) {
    console.log(`  ${e.number.padEnd(6)} ${(e.name ?? '').padEnd(26)} ${e.rows.map((x) => `${x.level}:${x.degree ?? '?'}@${x.institution ?? '?'}(${x.yearCompleted ?? '?'})`).join('  ')}`);
  }

  h(`F. CONFLICTS - NOT APPLIED, need a person (${plan.conflicts.length})`);
  const byField = {};
  for (const c of plan.conflicts) (byField[c.field] ??= []).push(c);
  for (const [field, list] of Object.entries(byField)) {
    console.log(`  -- ${field} (${list.length})`);
    for (const c of list) console.log(`     ${String(c.number).padEnd(6)} excel=${show(field, c.excel)}   hrms=${show(field, c.hrms)}`);
  }

  h(`G. REJECTED VALUES - field not imported, row otherwise fine (${plan.rejectedValues.length})`);
  if (!plan.rejectedValues.length) console.log('  none');
  for (const v of plan.rejectedValues) {
    console.log(`  ${String(v.number).padEnd(6)} ${(v.name ?? '').padEnd(26)} ${v.field} = ${v.value}  (fails validation, left as-is in HRMS)`);
  }

  h(`H. SKIPPED ROWS (${plan.skipped.length})`);
  for (const s of plan.skipped) console.log(`  ${s.where.padEnd(22)} ${(s.name ?? '').padEnd(26)} ${s.reason}`);

  h(`I. UNRESOLVED (${plan.unresolved.length})`);
  if (!plan.unresolved.length) console.log('  none');
  for (const u of plan.unresolved) console.log(`  ${String(u.number ?? '').padEnd(6)} ${(u.name ?? '').padEnd(26)} ${u.what}`);

  h('J. LOOKUP RECORDS TO CREATE');
  const needed = neededDepartments(plan);
  console.log(`  departments (${needed.size}): ${[...needed].join(', ') || 'none'}`);
  console.log(`  ${plan.pendingDepartments.length} employee(s) would then be filed under them.`);
  const unused = [...plan.newDepartments].filter((d) => !needed.has(d));
  if (unused.length) {
    console.log(`  named by the roster but not created (nobody to file under them yet): ${unused.join(', ')}`);
    console.log('  every employee the roster puts there already has a department in HRMS, so');
    console.log('  the move shows up as a department conflict in F rather than a new record here.');
  }

  h(`K. NOT IMPORTABLE - teams (${plan.newTeams.size})`);
  console.log('  HRMS Team belongs to one Department and is unique on (department, name).');
  console.log('  These roster teams span several, so none of them is created:');
  for (const [team, spans] of plan.newTeams) {
    const list = [...spans];
    console.log(`    ${team.padEnd(12)} ${list.length} department(s): ${list.join(', ')}`);
  }

  h('UNTOUCHED BY THIS IMPORT');
  console.log('  punch-code mappings, attendance records, raw punches, payroll, leave,');
  console.log('  contracts, loans, and every employee name. No record is ever deleted.');
}

// ---------------------------------------------------------------------- apply

/** Only departments that an employee is actually waiting on. */
function neededDepartments(plan) {
  return new Set(plan.pendingDepartments.map((a) => a.deptName));
}

async function apply(plan) {
  let updated = 0;
  let salaryRows = 0;
  let revisions = 0;
  let eduRows = 0;

  await prisma.$transaction(async (tx) => {
    const created = new Map();
    for (const name of neededDepartments(plan)) {
      const dept = await tx.department.create({ data: { companyId: plan.company.id, name } });
      created.set(name, dept.id);
    }
    for (const a of plan.pendingDepartments) {
      await tx.employee.update({ where: { id: a.employeeId }, data: { departmentId: created.get(a.deptName) } });
    }

    for (const u of plan.updates) {
      await tx.employee.update({ where: { id: u.employeeId }, data: u.sets });
      updated += 1;
    }

    for (const s of plan.salaries) {
      let previousSalaryId = null;
      let previousAmount = null;
      for (const [i, point] of s.timeline.entries()) {
        const next = s.timeline[i + 1];
        const effectiveTo = next ? new Date(next.effectiveFrom.getTime() - 86400000) : null;
        const salary = await tx.employeeSalary.create({
          data: {
            companyId: plan.company.id,
            employeeId: s.employeeId,
            salaryType: 'MONTHLY',
            amount: point.amount,
            currency: plan.company.currency,
            effectiveFrom: point.effectiveFrom,
            effectiveTo,
            note: `Imported from roster (${point.source})`,
          },
        });
        salaryRows += 1;

        if (previousAmount !== null) {
          const increment = point.amount - previousAmount;
          await tx.salaryRevision.create({
            data: {
              companyId: plan.company.id,
              employeeId: s.employeeId,
              previousSalaryId,
              salaryId: salary.id,
              salaryType: 'MONTHLY',
              currency: plan.company.currency,
              currentAmount: previousAmount,
              newAmount: point.amount,
              incrementAmount: increment,
              incrementPercent: Number(((increment / previousAmount) * 100).toFixed(2)),
              effectiveDate: point.effectiveFrom,
              reason: 'Imported from employee master roster',
              notes: `Source column: ${point.source}`,
            },
          });
          revisions += 1;
        }
        previousSalaryId = salary.id;
        previousAmount = point.amount;
      }
    }

    for (const e of plan.education) {
      for (const row of e.rows) {
        await tx.employeeEducation.create({ data: { employeeId: e.employeeId, ...row } });
        eduRows += 1;
      }
    }
  }, { timeout: 120_000 });

  console.log(`\nApplied: ${neededDepartments(plan).size} departments created, ${updated} employees updated, ${salaryRows} salary records, ${revisions} revisions, ${eduRows} education records.`);
}

async function main() {
  const plan = await buildPlan();
  printPreview(plan);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing was written. Re-run with --apply to write.');
    return;
  }
  if (plan.refusedSheets.length && !SKIP_REFUSED) {
    console.log(`\nREFUSING TO APPLY: ${plan.refusedSheets.length} sheet(s) could not be read safely (see above).`);
    console.log('Fix the sheet and re-run, or pass --skip-refused-sheets to import only the sheets');
    console.log('that parsed cleanly, leaving the rest for a later run.');
    process.exitCode = 1;
    return;
  }
  if (plan.refusedSheets.length) {
    console.log(`\nProceeding WITHOUT ${plan.refusedSheets.map((s) => s.sheetName).join(', ')} - refused above, --skip-refused-sheets given.`);
  }
  await apply(plan);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
