import type { Prisma } from '@prisma/client';
import {
  LOAN_SETTLED_STATUSES,
  buildSchedule,
  type LoanDetail,
  type LoanRecord,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';

/**
 * Loans: the parts that are arithmetic rather than routing.
 *
 * Two rules live here and nowhere else:
 *
 *  - The outstanding balance is the schedule minus what has settled. It is
 *    never stored, so it cannot drift from the installments behind it.
 *  - Only an ACTIVE loan is deductible. `dueInstallmentsForPeriod` is the one
 *    function payroll calls, and it will not return an installment belonging
 *    to a loan in any other state.
 */

export const LOAN_INCLUDE = {
  employee: {
    select: { id: true, firstName: true, lastName: true, displayName: true, employeeNumber: true },
  },
  installments: { orderBy: { sequence: 'asc' } },
} satisfies Prisma.EmployeeLoanInclude;

export type LoanRow = Prisma.EmployeeLoanGetPayload<{ include: typeof LOAN_INCLUDE }>;

export const toNumber = (value: Prisma.Decimal | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

export const day = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

/** A month string (yyyy-MM or yyyy-MM-dd) pinned to the first of that month, UTC. */
export function toMonthStart(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  }
  const [year, month] = value.slice(0, 7).split('-');
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1));
}

const employeeName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What has been repaid and what is left.
 *
 * PAID and WAIVED both settle an installment: one was collected and one was
 * forgiven, and neither is still owed. SCHEDULED and PENDING_PAYROLL are still
 * outstanding - an installment sitting in a run nobody has finalized has not
 * been paid, and treating it as paid would close a loan that is still owed.
 */
export function loanTotals(installments: ReadonlyArray<{ status: string; amount: Prisma.Decimal | number }>): {
  paidAmount: number;
  remainingAmount: number;
  paidInstallments: number;
} {
  let paid = 0;
  let paidCount = 0;
  let outstanding = 0;

  for (const row of installments) {
    const amount = toNumber(row.amount);
    if ((LOAN_SETTLED_STATUSES as readonly string[]).includes(row.status)) {
      paid += amount;
      paidCount += 1;
    } else if (row.status !== 'SKIPPED') {
      outstanding += amount;
    }
  }

  return {
    paidAmount: round2(paid),
    remainingAmount: round2(outstanding),
    paidInstallments: paidCount,
  };
}

export function toLoanRecord(
  row: LoanRow,
  caller: { employeeId: string | null; canApprove: boolean; canManage: boolean },
): LoanRecord {
  const totals = loanTotals(row.installments);
  const next = row.installments.find(
    (i) => i.status === 'SCHEDULED' || i.status === 'PENDING_PAYROLL',
  );

  const isOwner = caller.employeeId !== null && caller.employeeId === row.employeeId;

  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: employeeName(row.employee),
    employeeNumber: row.employee.employeeNumber,
    reference: row.reference,
    principalAmount: toNumber(row.principalAmount),
    currency: row.currency,
    installmentCount: row.installmentCount,
    monthlyDeduction: toNumber(row.monthlyDeduction),
    startMonth: day(row.startMonth)!,
    status: row.status,
    purpose: row.purpose,
    notes: row.notes,

    paidAmount: totals.paidAmount,
    remainingAmount: totals.remainingAmount,
    paidInstallments: totals.paidInstallments,
    nextDueMonth: next ? day(next.dueMonth) : null,

    requestedAt: row.requestedAt?.toISOString() ?? null,
    approvalRequestId: row.approvalRequestId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByName: null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),

    // A decision is only offered on something still awaiting one, and never to
    // the applicant. The endpoints re-check both; this only decides what the
    // UI shows.
    canApprove: row.status === 'PENDING' && caller.canApprove && !isOwner,
    canCancel:
      (row.status === 'PENDING' && (isOwner || caller.canManage)) ||
      (['APPROVED', 'ACTIVE'].includes(row.status) && caller.canManage),
  };
}

export function toLoanDetail(
  row: LoanRow,
  caller: { employeeId: string | null; canApprove: boolean; canManage: boolean },
): LoanDetail {
  return {
    ...toLoanRecord(row, caller),
    installments: row.installments.map((i) => ({
      id: i.id,
      sequence: i.sequence,
      dueMonth: day(i.dueMonth)!,
      amount: toNumber(i.amount),
      status: i.status,
      payrollRunId: i.payrollRunId,
      paidAt: i.paidAt?.toISOString() ?? null,
      note: i.note,
    })),
  };
}

/** The rows a fresh schedule inserts, for a loan being created or re-agreed. */
export function scheduleRows(input: {
  companyId: string;
  loanId: string;
  employeeId: string;
  principal: number;
  installmentCount: number;
  startMonth: string;
}): Prisma.EmployeeLoanInstallmentCreateManyInput[] {
  return buildSchedule({
    principal: input.principal,
    installments: input.installmentCount,
    startMonth: input.startMonth,
  }).map((row) => ({
    companyId: input.companyId,
    loanId: input.loanId,
    employeeId: input.employeeId,
    sequence: row.sequence,
    dueMonth: toMonthStart(row.dueMonth),
    amount: row.amount,
  }));
}

/**
 * The installments payroll may collect for one period.
 *
 * The single gate between loans and money, and the reason it lives in a
 * function of its own: `status: 'ACTIVE'` on the loan is the whole of "only
 * approved loans affect payroll", and it is enforced in one place rather than
 * repeated at every call site.
 *
 * An installment already claimed by THIS run is returned too - otherwise
 * recalculating a run would release the claim and then fail to see it, and a
 * repayment would silently disappear from the run meant to carry it. That is
 * exactly how PayrollAdjustment behaves, deliberately.
 */
export async function dueInstallmentsForPeriod(input: {
  companyId: string;
  employeeIds: readonly string[];
  from: Date;
  to: Date;
  runId: string | null;
}): Promise<
  Array<{
    id: string;
    loanId: string;
    employeeId: string;
    sequence: number;
    amount: number;
    reference: string | null;
    installmentCount: number;
  }>
> {
  if (input.employeeIds.length === 0) return [];

  const rows = await prisma.employeeLoanInstallment.findMany({
    where: {
      companyId: input.companyId,
      employeeId: { in: [...input.employeeIds] },
      // Anything due on or before the end of the period and not yet settled.
      // "On or before" rather than "within", so an installment a run was never
      // created for is picked up by the next one instead of being lost.
      dueMonth: { lte: input.to },
      status: { in: ['SCHEDULED', 'PENDING_PAYROLL'] },
      OR: input.runId
        ? [{ payrollRunId: null }, { payrollRunId: input.runId }]
        : [{ payrollRunId: null }],
      // The gate. Only a loan somebody activated is ever deducted.
      loan: { status: 'ACTIVE' },
    },
    orderBy: [{ dueMonth: 'asc' }, { sequence: 'asc' }],
    include: {
      loan: { select: { reference: true, installmentCount: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    loanId: row.loanId,
    employeeId: row.employeeId,
    sequence: row.sequence,
    amount: toNumber(row.amount),
    reference: row.loan.reference,
    installmentCount: row.loan.installmentCount,
  }));
}

/**
 * Closes a loan whose schedule has nothing left to collect.
 *
 * Called after a run is finalized and after an installment is waived. Reads
 * the rows rather than counting collections, so a loan settled by any route -
 * payroll, a waiver, a manual correction - ends up in the same place.
 */
export async function completeIfSettled(
  loanId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<boolean> {
  const outstanding = await client.employeeLoanInstallment.count({
    where: { loanId, status: { in: ['SCHEDULED', 'PENDING_PAYROLL'] } },
  });
  if (outstanding > 0) return false;

  const loan = await client.employeeLoan.findUnique({
    where: { id: loanId },
    select: { status: true },
  });
  if (!loan || loan.status !== 'ACTIVE') return false;

  await client.employeeLoan.update({
    where: { id: loanId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  return true;
}
