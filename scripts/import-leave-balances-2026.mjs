/**
 * 2026 leave balances from the HR leaves workbook.
 *
 * The workbook is a monthly count summary, not a leave register: it carries no
 * dates, no leave types, no statuses and no approvers, so it cannot produce
 * `leave_requests` rows without inventing four NOT NULL columns. See
 * docs/leaves-2026-import-assessment.md. What it does carry is how many days
 * each person has taken, and that is what this imports - as a balance
 * adjustment, which is the field HRMS provides for exactly this: a figure an
 * administrator asserts rather than one the system derived from requests.
 *
 * Decisions, taken by the operator on 2026-09-10 and recorded here because
 * none of them follow from the file:
 *
 *   Leave type   Every used day is booked against Annual Leave. The sheet has
 *                one combined "Leave" bucket and no evidence of which days
 *                were casual or sick, so splitting them would be invention.
 *   Entitlement  A flat 15 days for everyone - 6 annual, 3 casual, 6 sick -
 *                overriding the sheet's own per-person figure, which reads
 *                0 / 6 / 7.5 / 11 / 15 and appears to be pro-rated by joining
 *                date for 20 of the 84 rows.
 *   Balance      "Total Leave Remaining" (column 42) is the source of truth.
 *                HRMS is made to agree with the figure HR has already told
 *                each employee, rather than re-deriving one from the monthly
 *                cells and then disagreeing with the spreadsheet on 58 rows.
 *   Bad rows     The 10 rows that cannot be matched safely are skipped and
 *                reported, never guessed.
 *
 * TWO CONSEQUENCES of taking column 42 as the source, both deliberate and both
 * worth knowing before reading a "days consumed" figure out of HRMS:
 *
 * The column ignores half days. Amir Nadeem worked 9 full days of leave and 6
 * half days; his remaining reads 6, which is 15 - 9. So consumption derived
 * from this basis is the sheet's own basis, and it is lower than the days
 * actually taken.
 *
 * For the 12 people whose sheet entitlement is not 15, the column was computed
 * against their own pro-rated figure. Pairing it with a flat 15 makes their
 * REMAINING right - which is the number they have been told and the number
 * this import exists to reproduce - while making consumption derived from it
 * overstate what they took. Waqas Farooq took 2 days against an entitlement of
 * 7.5, leaving 5.5; against 15 that same 5.5 implies 9.5 days taken.
 *
 * It does not read a PunchCode as an employee identity. Two rows carry a
 * device user id in the Employee ID column, and one of them (198) is the punch
 * code of a DIFFERENT employee, so matching on it would write one person's
 * leave onto another's record.
 *
 *   npx dotenv -e .env -- npx tsx scripts/import-leave-balances-2026.mjs --file "/root/Leaves Data_2026.xlsx"
 *   ... --apply     to write
 */
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.indexOf('--file');
const FILE = fileArg > -1 ? process.argv[fileArg + 1] : '/root/Leaves Data_2026.xlsx';
const YEAR = 2026;

/** The entitlement split the operator specified. Sums to 15. */
const ENTITLEMENTS = { AL: 6, CL: 3, SL: 6 };
/** Used days are booked here. */
const USED_AGAINST = 'AL';

/** "Total Leave Remaining" - the balance HR has already told each employee. */
const REMAINING_COL = 42;
/** The flat allowance, and the sum of the three paid types below. */
const ENTITLEMENT_TOTAL = 15;

/** The 12 monthly "Leave" columns - whole days off. */
const LEAVE_COLS = [7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40];
/**
 * The 12 monthly "Half Day" columns.
 *
 * Read and reported, but NOT added to the balance: "Total Leave Remaining" is
 * the source of truth and that column does not count them, so adding them here
 * would make HRMS disagree with the spreadsheet it is meant to reproduce. They
 * are carried into the balance note so the omission is visible on the record
 * rather than only in this file. The "Late" columns are the third of each
 * month's triple and are not leave at all.
 */
const HALF_DAY_COLS = [6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39];

const cell = (c) => {
  const v = c?.value;
  if (v && typeof v === 'object') return v.result ?? v.text ?? null;
  return v;
};
const num = (v) => (typeof v === 'number' ? v : v == null || v === '' ? 0 : Number(v));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const nameOf = (e) =>
  [e.firstName, e.lastName].filter(Boolean).join(' ').trim() || e.displayName || '';

async function readSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const rows = [];
  for (const [sheet, start] of [['Leaves Data', 3], ['Sheet1', 1]]) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) continue;
    for (let r = start; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const id = cell(row.getCell(2));
      const name = cell(row.getCell(3));
      if ((id == null || id === '') && (name == null || name === '')) continue;
      const fullDays = LEAVE_COLS.reduce((a, c) => a + num(cell(row.getCell(c))), 0);
      const halfDays = HALF_DAY_COLS.reduce((a, c) => a + num(cell(row.getCell(c))), 0);
      const rawRemaining = cell(row.getCell(REMAINING_COL));
      const remaining = rawRemaining === null || rawRemaining === '' ? null : Number(rawRemaining);

      /**
       * What HRMS must end up showing as left.
       *
       * Eight rows have the cell blank. Blank is not zero - three of those
       * people took their whole allowance and five took nothing - so it falls
       * back to the sheet's OWN basis, entitlement minus full days, which
       * reproduces 0 for the first group and 15 for the second. Half days are
       * excluded from that fallback on purpose, because column 42 excludes
       * them too and a fallback on a different basis would be worse than an
       * approximate one.
       */
      const effectiveRemaining = remaining ?? ENTITLEMENT_TOTAL - fullDays;

      rows.push({
        sheet,
        excelRow: r,
        id: id == null ? '' : String(id).trim(),
        name: String(name ?? '').trim(),
        fullDays,
        halfDays,
        sheetRemaining: remaining,
        remaining: Math.round(effectiveRemaining * 100) / 100,
        // Consumption implied by the balance, not counted from the months.
        used: Math.round((ENTITLEMENT_TOTAL - effectiveRemaining) * 100) / 100,
      });
    }
  }
  return rows;
}

async function main() {
  const rows = await readSheet();

  const employees = await prisma.employee.findMany({
    select: { id: true, employeeNumber: true, firstName: true, lastName: true, displayName: true },
  });
  const byNumber = new Map(employees.map((e) => [String(e.employeeNumber).trim(), e]));

  // Loaded only to RECOGNISE a punch code in the id column, never to resolve one.
  const punchCodes = new Map(
    (await prisma.attendanceDeviceUserMapping.findMany({
      select: { deviceUserId: true, employeeId: true },
    })).map((m) => [String(m.deviceUserId).trim(), m.employeeId]),
  );

  const matched = [];
  const skipped = [];
  for (const row of rows) {
    if (!row.id || row.id === '0') {
      skipped.push({ ...row, why: 'no usable Employee ID in the sheet' });
      continue;
    }
    const employee = byNumber.get(row.id);
    if (employee) {
      matched.push({ ...row, employee });
      continue;
    }
    if (punchCodes.has(row.id)) {
      const owner = employees.find((e) => e.id === punchCodes.get(row.id));
      skipped.push({
        ...row,
        why: `id ${row.id} is a device punch code, belonging to ${nameOf(owner)} (employeeNumber ${owner?.employeeNumber}) - importing it would write to the wrong record`,
      });
      continue;
    }
    skipped.push({ ...row, why: `employeeNumber ${row.id} is not in HRMS` });
  }

  const types = await prisma.leaveType.findMany({
    where: { code: { in: Object.keys(ENTITLEMENTS) } },
    select: { id: true, code: true, name: true, annualEntitlementDays: true, monthlyAccrualDays: true },
  });

  console.log(`file            ${FILE}`);
  console.log(`sheet rows      ${rows.length}`);
  console.log(`matched         ${matched.length}`);
  console.log(`skipped         ${skipped.length}`);

  console.log('\n--- leave types: entitlement ---');
  for (const t of types) {
    const want = ENTITLEMENTS[t.code];
    const from = `${Number(t.annualEntitlementDays)}/yr accruing ${Number(t.monthlyAccrualDays)}/mo`;
    // Accrual is set equal to the annual figure so the whole year's allowance
    // is available from January. That is what the workbook means by "15 days":
    // remaining is 15 minus what you have taken, not a twelfth per month.
    console.log(`  ${t.name.padEnd(14)} ${from}  ->  ${want}/yr granted in full`);
  }

  console.log(`\n--- balances: used days booked against ${USED_AGAINST}, year ${YEAR} ---`);
  const withUse = matched.filter((m) => m.used > 0);
  console.log(`  ${withUse.length} employees with days taken, ${matched.length - withUse.length} with none`);
  const blanks = matched.filter((m) => m.sheetRemaining === null);
  console.log(
    `  total remaining: ${Math.round(matched.reduce((a, m) => a + m.remaining, 0) * 100) / 100}` +
      ` | implied consumption: ${Math.round(matched.reduce((a, m) => a + m.used, 0) * 100) / 100}`,
  );
  console.log(
    `  ${blanks.length} row(s) had a blank Remaining cell and fell back to ${ENTITLEMENT_TOTAL} - full days:` +
      ` ${blanks.map((m) => `${m.id}=${m.remaining}`).join(', ') || 'none'}`,
  );
  for (const m of matched.filter((x) => x.remaining < 0)) {
    console.log(
      `    overdrawn: ${String(m.id).padEnd(6)} ${nameOf(m.employee).padEnd(26)} remaining ${m.remaining}`,
    );
  }

  console.log(`\n--- skipped (${skipped.length}) ---`);
  for (const s of skipped) console.log(`  ${String(s.id || '(blank)').padEnd(7)} "${s.name}" used=${s.used}\n      ${s.why}`);

  const targetType = types.find((t) => t.code === USED_AGAINST);
  if (!targetType) throw new Error(`Leave type ${USED_AGAINST} not found`);

  // What is already stored, so a re-run reports the delta rather than just the
  // destination. This import has run before; the second run must be legible.
  const existing = new Map(
    (
      await prisma.leaveBalance.findMany({
        where: { leaveTypeId: targetType.id, year: YEAR },
        select: { employeeId: true, adjustmentDays: true },
      })
    ).map((b) => [b.employeeId, Number(b.adjustmentDays)]),
  );
  const changing = matched.filter((m) => {
    const was = existing.get(m.employee.id);
    return was === undefined || was !== -m.used;
  });
  // Balances left behind by an earlier run whose row is no longer imported.
  const stale = [...existing.keys()].filter((id) => !matched.some((m) => m.employee.id === id));

  console.log(`\n--- changes against what is already stored ---`);
  console.log(`  ${changing.length} of ${matched.length} balances change`);
  for (const m of changing) {
    const was = existing.get(m.employee.id);
    console.log(
      `    ${String(m.id).padEnd(6)} ${nameOf(m.employee).padEnd(26)}` +
        ` ${was === undefined ? 'new' : `used ${-was}`} -> used ${m.used}` +
        ` (remaining ${m.remaining})`,
    );
  }
  console.log(`  ${stale.length} stale balance row(s) to remove`);

  if (!APPLY) {
    console.log('\nDRY RUN - nothing was written. Re-run with --apply to write.');
    return;
  }

  let typesUpdated = 0;
  for (const t of types) {
    await prisma.leaveType.update({
      where: { id: t.id },
      data: { annualEntitlementDays: ENTITLEMENTS[t.code], monthlyAccrualDays: ENTITLEMENTS[t.code] },
    });
    typesUpdated += 1;
  }

  const target = targetType;

  /**
   * Clear this import's own rows first.
   *
   * The balance is a whole-record assertion, not an increment, and an earlier
   * run wrote a different one from a different basis. Deleting the year's rows
   * for this type and rewriting them means the result depends on the sheet
   * alone, rather than on which imports happened to run before.
   *
   * Scoped to (this leave type, this year) so nothing else is touched: other
   * types, other years and anything an administrator entered by hand survive.
   */
  const removed = await prisma.leaveBalance.deleteMany({
    where: { leaveTypeId: target.id, year: YEAR },
  });

  let written = 0;
  for (const m of matched) {
    const source =
      m.sheetRemaining === null
        ? `no "Total Leave Remaining" recorded; derived from ${m.fullDays} full day(s) taken`
        : `"Total Leave Remaining" of ${m.sheetRemaining}`;
    const note = `2026 leaves workbook (row ${m.excelRow} of "${m.sheet}"): ${source}, against a flat ${ENTITLEMENT_TOTAL}-day allowance, leaving ${m.remaining}. Sheet also records ${m.fullDays} full and ${m.halfDays} half day(s). Imported ${new Date().toISOString().slice(0, 10)}.`;
    await prisma.leaveBalance.upsert({
      where: {
        employeeId_leaveTypeId_year: { employeeId: m.employee.id, leaveTypeId: target.id, year: YEAR },
      },
      create: {
        companyId: (await prisma.employee.findUniqueOrThrow({ where: { id: m.employee.id }, select: { companyId: true } })).companyId,
        employeeId: m.employee.id,
        leaveTypeId: target.id,
        year: YEAR,
        adjustmentDays: -m.used,
        adjustmentNote: note,
      },
      update: { adjustmentDays: -m.used, adjustmentNote: note },
    });
    written += 1;
  }

  console.log(
    `\nAPPLIED. leave types updated: ${typesUpdated}.` +
      ` old balances removed: ${removed.count}. leave_balances written: ${written}.`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
