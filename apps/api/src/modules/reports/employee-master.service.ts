import type { Prisma } from '@prisma/client';
import {
  EMPLOYEE_MASTER_COLUMNS,
  PERMISSIONS,
  resolveReportPeriod,
  type EmployeeMasterQuery,
  type EmployeeMasterReport,
  type EmployeeMasterRow,
  type Permission,
} from '@hrms/shared';
import type { AuthContext } from '../../auth/session.js';
import { employeeScopeFilter } from '../../auth/scope.js';
import { prisma } from '../../core/db.js';
import { deriveRangeForEmployees, tallyDerived } from '../time/attendance.service.js';
import { balancesForEmployee, foldPaidBalances } from '../leave/leave.service.js';
import { loanTotals, toNumber } from '../loans/loans.service.js';

/**
 * The Employee Master Report.
 *
 * A query layer. It owns no arithmetic about attendance, leave, loans or pay:
 * attendance comes from `deriveRangeForEmployees` + `tallyDerived`, leave from
 * `balancesForEmployee`, loans from `loanTotals`, salary from the salary rows
 * read the way every salary screen reads them. The one thing this file decides
 * is which employees a row exists for and which columns the caller may see.
 *
 * That matters more than it sounds. A master report is exactly the kind of
 * screen that grows its own slightly-different definition of "attendance
 * percentage", and then two screens in the same product disagree about the
 * same person. Everything here delegates so they cannot.
 *
 * Read-only throughout. Nothing in this module writes.
 *
 * ORDER OF OPERATIONS, and why it is this way round:
 *
 *   1. Narrow in SQL on the columns that exist - department, status, dates.
 *   2. Enrich the survivors through the owning services.
 *   3. Narrow again on the figures those services produced - salary band,
 *      leave remaining, loan outstanding, attendance percentage. None of these
 *      is a column, so none can be a WHERE clause.
 *   4. Total, then sort, then paginate.
 *
 * Step 3 is why the totals are honest: the summary cards are computed from the
 * same enriched, filtered set the table pages through, rather than from a
 * second aggregate query that would drift from it.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (value: Date | null | undefined): string | null =>
  value ? value.toISOString().slice(0, 10) : null;
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

/** The columns this caller is allowed to fill, by permission. */
export function allowedColumns(auth: AuthContext): string[] {
  return EMPLOYEE_MASTER_COLUMNS.filter(
    (c) => !c.permission || auth.permissions.has(c.permission as Permission),
  ).map((c) => c.key);
}

const EMPLOYEE_INCLUDE = {
  department: { select: { name: true } },
  team: { select: { name: true } },
  designation: { select: { name: true } },
  location: { select: { name: true } },
  manager: { select: { firstName: true, lastName: true, displayName: true } },
  education: { select: { level: true, degree: true, institution: true, yearCompleted: true } },
} satisfies Prisma.EmployeeInclude;

type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>;

const nameOf = (e: { firstName: string; lastName: string; displayName?: string | null }) =>
  e.displayName?.trim() || `${e.firstName} ${e.lastName}`.trim();

export async function buildEmployeeMasterReport(
  auth: AuthContext,
  query: EmployeeMasterQuery,
  reference = new Date(),
): Promise<EmployeeMasterReport> {
  const period = resolveReportPeriod(query.period, reference, { from: query.from, to: query.to });
  const from = new Date(`${period.from}T00:00:00.000Z`);
  const to = new Date(`${period.to}T00:00:00.000Z`);

  const can = (p: Permission) => auth.permissions.has(p);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: auth.companyId },
    select: { currency: true },
  });

  const empty: EmployeeMasterReport = {
    from: period.from,
    to: period.to,
    rows: [],
    totals: { employees: 0, active: 0, currency: company.currency },
    meta: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
    availableColumns: allowedColumns(auth),
  };

  // Scope first. NONE means no rows, never "no filter".
  const scopeFilter = await employeeScopeFilter(auth);
  if (scopeFilter === null) return empty;

  // ---------------------------------------------------------- 1. narrow in SQL
  const terms = query.q ? query.q.split(/\s+/).filter(Boolean) : [];
  const where: Prisma.EmployeeWhereInput = {
    AND: [
      { companyId: auth.companyId },
      scopeFilter,
      query.status ? { status: query.status as never } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.teamId ? { teamId: query.teamId } : {},
      query.designationId ? { designationId: query.designationId } : {},
      query.locationId ? { locationId: query.locationId } : {},
      query.employmentType ? { employmentType: query.employmentType as never } : {},
      query.employmentStatus ? { employmentStatus: query.employmentStatus as never } : {},
      query.hiredFrom ? { hireDate: { gte: new Date(`${query.hiredFrom}T00:00:00.000Z`) } } : {},
      query.hiredTo ? { hireDate: { lte: new Date(`${query.hiredTo}T00:00:00.000Z`) } } : {},
      query.incrementDueFrom
        ? { nextIncrementDueDate: { gte: new Date(`${query.incrementDueFrom}T00:00:00.000Z`) } }
        : {},
      query.incrementDueTo
        ? { nextIncrementDueDate: { lte: new Date(`${query.incrementDueTo}T00:00:00.000Z`) } }
        : {},
      ...terms.map((term) => ({
        OR: [
          { firstName: { contains: term, mode: 'insensitive' as const } },
          { lastName: { contains: term, mode: 'insensitive' as const } },
          { displayName: { contains: term, mode: 'insensitive' as const } },
          { employeeNumber: { contains: term, mode: 'insensitive' as const } },
          { workEmail: { contains: term, mode: 'insensitive' as const } },
          { jobTitle: { contains: term, mode: 'insensitive' as const } },
          { designation: { name: { contains: term, mode: 'insensitive' as const } } },
          { department: { name: { contains: term, mode: 'insensitive' as const } } },
        ],
      })),
    ],
  };

  const employees = await prisma.employee.findMany({ where, include: EMPLOYEE_INCLUDE });
  if (employees.length === 0) return empty;

  // ------------------------------------------------------------- 2. enrich
  const ids = employees.map((e) => e.id);
  const year = reference.getUTCFullYear();

  const [punchMap, attendanceMap, salaryMap, loanMap, leaveMap, contractMap] = await Promise.all([
    can(PERMISSIONS.DEVICE_READ) ? punchCodesFor(auth.companyId, ids) : null,
    can(PERMISSIONS.ATTENDANCE_READ) ? attendanceFor(auth.companyId, employees, from, to) : null,
    can(PERMISSIONS.PAYROLL_READ) ? salaryFor(auth.companyId, ids, reference) : null,
    can(PERMISSIONS.LOAN_READ) ? loansFor(auth.companyId, ids, company.currency) : null,
    can(PERMISSIONS.LEAVE_READ) ? leaveFor(auth.companyId, ids, year) : null,
    can(PERMISSIONS.CONTRACT_READ) ? contractsFor(auth.companyId, ids) : null,
  ]);

  const sensitive = can(PERMISSIONS.EMPLOYEE_SENSITIVE_READ);

  let rows: EmployeeMasterRow[] = employees.map((e) =>
    toRow(e, {
      sensitive,
      // An empty list where the caller may read devices, matching the profile
      // summary: "no PIN mapped" is an answer, and a missing key is not.
      punchCodes: punchMap ? (punchMap.get(e.id) ?? []) : undefined,
      attendance: attendanceMap?.get(e.id),
      salary: salaryMap?.get(e.id),
      loans: loanMap?.get(e.id),
      leave: leaveMap?.get(e.id),
      contract: contractMap?.get(e.id) ?? null,
      hasContractPermission: contractMap !== null,
      period,
    }),
  );

  // ------------------------------------ 3. narrow on what the services produced
  rows = rows.filter((row) => matchesComputedFilters(row, query));

  // -------------------------------------------------------------- 4. totals
  const totals = {
    employees: rows.length,
    active: rows.filter((r) => r.status === 'ACTIVE').length,
    currency: company.currency,
    ...(salaryMap ? { totalSalary: round2(rows.reduce((a, r) => a + (r.salary?.amount ?? 0), 0)) } : {}),
    ...(leaveMap
      ? { totalLeaveRemaining: round2(rows.reduce((a, r) => a + (r.leave?.availableDays ?? 0), 0)) }
      : {}),
    ...(loanMap
      ? {
          activeLoans: rows.filter((r) => r.loans?.hasActiveLoan).length,
          outstandingLoans: round2(rows.reduce((a, r) => a + (r.loans?.outstandingTotal ?? 0), 0)),
        }
      : {}),
    ...(attendanceMap
      ? {
          totalOvertimeHours: round2(
            rows.reduce((a, r) => a + (r.attendance?.overtimeHours ?? 0), 0),
          ),
        }
      : {}),
  };

  // ------------------------------------------------------- 5. sort, paginate
  rows.sort(comparator(query.sort, query.order));

  const total = rows.length;
  const start = (query.page - 1) * query.limit;

  return {
    from: period.from,
    to: period.to,
    rows: rows.slice(start, start + query.limit),
    totals,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
    availableColumns: allowedColumns(auth),
  };
}

/** Every row, already filtered - for an export, which is not paginated. */
export async function buildEmployeeMasterExport(
  auth: AuthContext,
  query: EmployeeMasterQuery,
  reference = new Date(),
): Promise<EmployeeMasterReport> {
  return buildEmployeeMasterReport(auth, { ...query, page: 1, limit: 100_000 }, reference);
}

// ------------------------------------------------------------------ enrichers

/**
 * Device PINs from the mapping table.
 *
 * A PunchCode is NOT the employee number - 30 of this company's employees punch
 * under a PIN that differs from theirs, and two rows of the HR roster carry
 * somebody else's PIN in the ID column. It is read here, never derived.
 */
async function punchCodesFor(companyId: string, ids: string[]): Promise<Map<string, string[]>> {
  const rows = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId, employeeId: { in: ids }, isActive: true },
    select: { employeeId: true, deviceUserId: true },
    orderBy: { deviceUserId: 'asc' },
  });
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.employeeId, [...(out.get(r.employeeId) ?? []), r.deviceUserId]);
  return out;
}

/** The attendance engine, over the whole cohort in one pass. */
async function attendanceFor(
  companyId: string,
  employees: ReadonlyArray<{ id: string; locationId: string | null }>,
  from: Date,
  to: Date,
): Promise<Map<string, EmployeeMasterRow['attendance']>> {
  const derived = await deriveRangeForEmployees(companyId, employees, from, to);
  const out = new Map<string, EmployeeMasterRow['attendance']>();

  for (const [employeeId, days] of derived) {
    const t = tallyDerived(days);
    // Holiday and weekend are not in the monthly tally, so they are counted off
    // the same derived days the tally read - never re-derived from a calendar.
    const holiday = days.filter((d) => d.status === 'HOLIDAY').length;
    const weekend = days.filter((d) => d.status === 'WEEKEND').length;
    out.set(employeeId, {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      present: t.present,
      absent: t.absent,
      late: t.late,
      halfDay: t.halfDay,
      onLeave: t.onLeave,
      holiday,
      weekend,
      workedHours: hours(t.workedMinutes),
      overtimeHours: hours(t.overtimeMinutes),
      attendancePercentage: t.attendancePercentage,
    });
  }
  return out;
}

/** The salary in force on the reference day, plus its revision history. */
async function salaryFor(
  companyId: string,
  ids: string[],
  reference: Date,
): Promise<Map<string, EmployeeMasterRow['salary']>> {
  const today = reference.toISOString().slice(0, 10);
  const [salaries, revisions, employees] = await Promise.all([
    prisma.employeeSalary.findMany({
      where: { companyId, employeeId: { in: ids } },
      orderBy: { effectiveFrom: 'desc' },
      select: { employeeId: true, amount: true, currency: true, effectiveFrom: true, effectiveTo: true },
    }),
    prisma.salaryRevision.findMany({
      where: { companyId, employeeId: { in: ids } },
      orderBy: { effectiveDate: 'desc' },
      select: { employeeId: true, effectiveDate: true, newAmount: true },
    }),
    prisma.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, nextIncrementDueDate: true },
    }),
  ]);

  const out = new Map<string, EmployeeMasterRow['salary']>();
  for (const e of employees) {
    const mine = salaries.filter((s) => s.employeeId === e.id);
    // "In force" is the same test every salary screen uses: started on or
    // before today, and not yet ended.
    const current = mine.find(
      (s) => day(s.effectiveFrom)! <= today && (s.effectiveTo === null || day(s.effectiveTo)! >= today),
    );
    const lastRevision = revisions.find((r) => r.employeeId === e.id) ?? null;

    out.set(e.id, {
      amount: current ? toNumber(current.amount) : 0,
      currency: current?.currency ?? '',
      effectiveFrom: day(current?.effectiveFrom ?? null),
      revisionCount: mine.length,
      nextIncrementDueDate: day(e.nextIncrementDueDate),
      lastRevisionDate: day(lastRevision?.effectiveDate ?? null),
      lastRevisionAmount: lastRevision ? toNumber(lastRevision.newAmount) : null,
    });
  }
  return out;
}

/** Loans, priced by the schedule the loans module owns. */
async function loansFor(
  companyId: string,
  ids: string[],
  fallbackCurrency: string,
): Promise<Map<string, EmployeeMasterRow['loans']>> {
  const loans = await prisma.employeeLoan.findMany({
    where: { companyId, employeeId: { in: ids } },
    include: { installments: { select: { status: true, amount: true, dueMonth: true } } },
  });

  const out = new Map<string, EmployeeMasterRow['loans']>();
  for (const id of ids) {
    const mine = loans.filter((l) => l.employeeId === id);
    const active = mine.filter((l) => l.status === 'ACTIVE');

    let principalTotal = 0;
    let paidTotal = 0;
    let outstandingTotal = 0;
    let monthlyDeduction = 0;
    let remainingInstallments = 0;
    let nextDueMonth: string | null = null;

    for (const loan of mine) {
      const totals = loanTotals(loan.installments);
      principalTotal += toNumber(loan.principalAmount);
      paidTotal += totals.paidAmount;
      // Only an ACTIVE loan is money the next payslip will take. A pending
      // application and a cancelled loan both cost nothing.
      if (loan.status === 'ACTIVE') {
        outstandingTotal += totals.remainingAmount;
        monthlyDeduction += toNumber(loan.monthlyDeduction);
        const due = loan.installments
          .filter((i) => i.status === 'SCHEDULED' || i.status === 'PENDING_PAYROLL')
          .map((i) => day(i.dueMonth)!)
          .sort();
        remainingInstallments += due.length;
        if (due[0] && (nextDueMonth === null || due[0] < nextDueMonth)) nextDueMonth = due[0];
      }
    }

    out.set(id, {
      count: mine.length,
      hasActiveLoan: active.length > 0,
      statuses: [...new Set(mine.map((l) => l.status))],
      principalTotal: round2(principalTotal),
      paidTotal: round2(paidTotal),
      outstandingTotal: round2(outstandingTotal),
      monthlyDeduction: round2(monthlyDeduction),
      remainingInstallments,
      nextDueMonth,
      currency: mine[0]?.currency ?? fallbackCurrency,
    });
  }
  return out;
}

/**
 * Leave, from the leave service itself.
 *
 * Called once per employee rather than batched, deliberately: the balance rule
 * - opening + accrued + adjustment - used - pending, with accrual capped at the
 * entitlement - lives in `balancesForEmployee`, and a batched reimplementation
 * of it here is precisely the second calculation this report must not have.
 *
 * The headline figures count PAID types only, via the same `foldPaidBalances`
 * the Employee 360 header uses. `byType` still lists every type, so an unpaid
 * balance stays visible in the breakdown without being added to a total that
 * reads as "days you may take without losing pay".
 */
async function leaveFor(
  companyId: string,
  ids: string[],
  year: number,
): Promise<Map<string, EmployeeMasterRow['leave']>> {
  const requests = await prisma.leaveRequest.findMany({
    where: {
      employeeId: { in: ids },
      startDate: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) },
    },
    select: { employeeId: true, status: true },
  });

  const out = new Map<string, EmployeeMasterRow['leave']>();
  for (const employeeId of ids) {
    const balances = await balancesForEmployee(companyId, employeeId, year);
    const mine = requests.filter((r) => r.employeeId === employeeId);

    out.set(employeeId, {
      year,
      ...foldPaidBalances(balances),
      byType: balances.map((b) => ({
        leaveTypeId: b.leaveTypeId,
        code: b.leaveTypeCode,
        name: b.leaveTypeName,
        entitlementDays: b.annualEntitlementDays,
        usedDays: b.usedDays,
        availableDays: b.availableDays,
      })),
      requestCount: mine.length,
      pendingCount: mine.filter((r) => r.status === 'PENDING').length,
      approvedCount: mine.filter((r) => r.status === 'APPROVED').length,
      rejectedCount: mine.filter((r) => r.status === 'REJECTED' || r.status === 'CANCELLED').length,
    });
  }
  return out;
}

/** The contract in force, if the caller may read contracts. */
async function contractsFor(
  companyId: string,
  ids: string[],
): Promise<Map<string, EmployeeMasterRow['contract']>> {
  const rows = await prisma.employeeContract.findMany({
    where: { companyId, employeeId: { in: ids }, status: 'ACTIVE' },
    orderBy: { startDate: 'desc' },
    select: { employeeId: true, contractType: true, startDate: true, endDate: true, status: true },
  });
  const out = new Map<string, EmployeeMasterRow['contract']>();
  for (const r of rows) {
    if (out.has(r.employeeId)) continue;
    out.set(r.employeeId, {
      type: r.contractType,
      startDate: day(r.startDate),
      endDate: day(r.endDate),
      status: r.status,
    });
  }
  return out;
}

// ----------------------------------------------------------------- assembly

function toRow(
  e: EmployeeRow,
  ctx: {
    sensitive: boolean;
    punchCodes?: string[];
    attendance?: EmployeeMasterRow['attendance'];
    salary?: EmployeeMasterRow['salary'];
    loans?: EmployeeMasterRow['loans'];
    leave?: EmployeeMasterRow['leave'];
    contract: EmployeeMasterRow['contract'];
    hasContractPermission: boolean;
    period: { from: string; to: string };
  },
): EmployeeMasterRow {
  const education = e.education
    .map((ed) =>
      [ed.level, ed.degree, ed.institution, ed.yearCompleted].filter(Boolean).join(' · '),
    )
    .join('; ');

  return {
    employeeId: e.id,
    employeeNumber: e.employeeNumber,
    ...(ctx.punchCodes ? { punchCodes: ctx.punchCodes } : {}),

    firstName: e.firstName,
    lastName: e.lastName,
    fullName: nameOf(e),
    workEmail: e.workEmail,
    phone: e.phone,
    dateOfBirth: day(e.dateOfBirth),
    gender: e.gender,
    presentAddress: e.presentAddress,
    // Omitted, not nulled, when the caller may not read it.
    ...(ctx.sensitive ? { nationalId: e.nationalId } : {}),

    status: e.status,
    hireDate: day(e.hireDate),
    confirmationDate: day(e.confirmationDate),
    departmentName: e.department?.name ?? null,
    teamName: e.team?.name ?? null,
    designationName: e.designation?.name ?? null,
    jobTitle: e.jobTitle,
    locationName: e.location?.name ?? null,
    managerName: e.manager ? nameOf(e.manager) : null,
    employmentType: e.employmentType,
    employmentStatus: e.employmentStatus,
    terminationDate: day(e.terminationDate),
    resignationDate: day(e.resignationDate),

    education: education || null,
    priorExperienceMonths: e.priorExperienceMonths,
    ...(ctx.hasContractPermission ? { contract: ctx.contract } : {}),

    ...(ctx.attendance ? { attendance: ctx.attendance } : {}),
    ...(ctx.salary ? { salary: ctx.salary } : {}),
    ...(ctx.loans ? { loans: ctx.loans } : {}),
    ...(ctx.leave ? { leave: ctx.leave } : {}),
  };
}

/**
 * The filters that cannot be a WHERE clause.
 *
 * A row with no block for a filtered dimension fails the filter rather than
 * passing it: "employees with an outstanding loan over 50,000" must not include
 * somebody whose loans the caller cannot see, because the honest answer there
 * is "unknown", and unknown is not a match.
 */
function matchesComputedFilters(row: EmployeeMasterRow, q: EmployeeMasterQuery): boolean {
  const within = (value: number | null | undefined, min?: number, max?: number) => {
    if (min === undefined && max === undefined) return true;
    if (value === null || value === undefined) return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  };

  if (!within(row.salary?.amount, q.salaryMin, q.salaryMax)) return false;

  // A leave-type filter narrows the balance the range is tested against, so
  // "Annual, 0 or fewer remaining" reads the annual bucket and not the total.
  const leaveRemaining = q.leaveTypeId
    ? row.leave?.byType.find((t) => t.leaveTypeId === q.leaveTypeId)?.availableDays
    : row.leave?.availableDays;
  if (q.leaveTypeId && row.leave && leaveRemaining === undefined) return false;
  if (!within(leaveRemaining, q.leaveRemainingMin, q.leaveRemainingMax)) return false;

  if (q.hasActiveLoan) {
    if (!row.loans) return false;
    if ((q.hasActiveLoan === 'yes') !== row.loans.hasActiveLoan) return false;
  }
  if (q.loanStatus !== 'any') {
    if (!row.loans) return false;
    if (q.loanStatus === 'none') {
      if (row.loans.count > 0) return false;
    } else if (!row.loans.statuses.includes(q.loanStatus.toUpperCase())) {
      return false;
    }
  }
  if (!within(row.loans?.outstandingTotal, q.loanOutstandingMin, q.loanOutstandingMax)) return false;

  if (!within(row.attendance?.attendancePercentage, q.attendanceMin, q.attendanceMax)) return false;
  if (!within(row.attendance?.overtimeHours, q.overtimeMinHours, undefined)) return false;

  return true;
}

/** Sort on the flattened value a column shows, so the table sorts by what it displays. */
function comparator(sort: string, order: 'asc' | 'desc') {
  const direction = order === 'asc' ? 1 : -1;
  return (a: EmployeeMasterRow, b: EmployeeMasterRow) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    // A row with nothing in the sorted column sinks, in both directions: it is
    // not "smallest", it is absent, and absent belongs at the end either way.
    if (av === null && bv === null) return a.fullName.localeCompare(b.fullName);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  };
}

function sortValue(row: EmployeeMasterRow, key: string): string | number | null {
  switch (key) {
    case 'salaryAmount': return row.salary?.amount ?? null;
    case 'salaryEffectiveFrom': return row.salary?.effectiveFrom ?? null;
    case 'nextIncrementDueDate': return row.salary?.nextIncrementDueDate ?? null;
    case 'salaryRevisionCount': return row.salary?.revisionCount ?? null;
    case 'lastRevisionDate': return row.salary?.lastRevisionDate ?? null;
    case 'lastRevisionAmount': return row.salary?.lastRevisionAmount ?? null;
    case 'leaveEntitlement': return row.leave?.entitlementDays ?? null;
    case 'leaveUsed': return row.leave?.usedDays ?? null;
    case 'leaveConsumed': return row.leave?.consumedDays ?? null;
    case 'leaveAdjusted': return row.leave?.adjustedDays ?? null;
    case 'leaveRemaining': return row.leave?.availableDays ?? null;
    case 'leavePending': return row.leave?.pendingDays ?? null;
    case 'leaveRequestCount': return row.leave?.requestCount ?? null;
    case 'leavePendingCount': return row.leave?.pendingCount ?? null;
    case 'leaveApprovedCount': return row.leave?.approvedCount ?? null;
    case 'leaveRejectedCount': return row.leave?.rejectedCount ?? null;
    case 'loanOutstanding': return row.loans?.outstandingTotal ?? null;
    case 'loanPrincipal': return row.loans?.principalTotal ?? null;
    case 'loanPaid': return row.loans?.paidTotal ?? null;
    case 'loanMonthly': return row.loans?.monthlyDeduction ?? null;
    case 'loanCount': return row.loans?.count ?? null;
    case 'loanRemainingInstallments': return row.loans?.remainingInstallments ?? null;
    case 'loanNextDueMonth': return row.loans?.nextDueMonth ?? null;
    case 'hasActiveLoan': return row.loans ? (row.loans.hasActiveLoan ? 1 : 0) : null;
    case 'attPresent': return row.attendance?.present ?? null;
    case 'attAbsent': return row.attendance?.absent ?? null;
    case 'attLate': return row.attendance?.late ?? null;
    case 'attHalfDay': return row.attendance?.halfDay ?? null;
    case 'attOnLeave': return row.attendance?.onLeave ?? null;
    case 'attHoliday': return row.attendance?.holiday ?? null;
    case 'attWeekend': return row.attendance?.weekend ?? null;
    case 'attWorkedHours': return row.attendance?.workedHours ?? null;
    case 'attOvertimeHours': return row.attendance?.overtimeHours ?? null;
    case 'attPercentage': return row.attendance?.attendancePercentage ?? null;
    case 'punchCodes': return row.punchCodes?.join(',') ?? null;
    default: {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (value === null || value === undefined) return null;
      return typeof value === 'number' ? value : String(value);
    }
  }
}
