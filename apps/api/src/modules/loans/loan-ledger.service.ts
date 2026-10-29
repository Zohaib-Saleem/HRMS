import type { Prisma } from '@prisma/client';
import {
  LOAN_KIND_PAYROLL_CODES,
  PERMISSIONS,
  addMonths,
  advanceNeedsDeductionDecision,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { completeIfSettled, toMonthStart, toNumber } from './loans.service.js';
import { carryForwardShift, closedPayrollMonths } from './loan-schedule.service.js';

/**
 * The loan ledger: corrections to what has been repaid, and when.
 *
 * Installments are the plan - what is owed and in which month. The ledger
 * (`employee_loan_transactions`) is what was done about it. Three rules hold
 * everything here together:
 *
 *  - An installment is PAID only with a ledger entry behind it: a
 *    PAYROLL_DEDUCTION written by the finalizing run, or a MANUAL_PAYMENT a
 *    person recorded with a date, a reason and, ideally, a reference.
 *  - Nothing in the ledger is edited or deleted. A manual payment recorded in
 *    error is taken back by a PAYMENT_REVERSAL that points at it; both stay.
 *  - A finalized payroll is never reopened from here. Money a finalized run
 *    deducted is corrected with a payroll adjustment on the next run, which
 *    is the payroll module's own correction mechanism, not this one.
 *
 * Correcting history is a financial act, so it needs both halves of the
 * authority that produced it: `loan.manage` for the loan and `payroll.manage`
 * for what payroll does with it.
 */

type Client = Prisma.TransactionClient;

export function canCorrectLoans(permissions: ReadonlySet<string>): boolean {
  return permissions.has(PERMISSIONS.LOAN_MANAGE) && permissions.has(PERMISSIONS.PAYROLL_MANAGE);
}

const dateColumn = (day: string): Date => new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
const todayColumn = (): Date => dateColumn(new Date().toISOString());
const monthOf = (value: Date): string => value.toISOString().slice(0, 7);

/** Payroll run statuses an installment can still be taken back from. */
const RELEASABLE_RUN_STATUSES = ['DRAFT', 'REVIEW'];

async function installmentOrThrow(
  tx: Client,
  input: { companyId: string; loanId: string; installmentId: string },
) {
  const installment = await tx.employeeLoanInstallment.findFirst({
    where: { id: input.installmentId, loanId: input.loanId, companyId: input.companyId },
    include: {
      loan: { select: { id: true, employeeId: true, status: true, kind: true, reference: true } },
      run: { select: { id: true, status: true } },
    },
  });
  if (!installment) throw new NotFoundError('Installment');
  return installment;
}

/**
 * Moves one installment from the status it was read in, or fails.
 *
 * The `status` in the WHERE is the guard against two people settling the same
 * installment at once: the second update matches nothing, and the second
 * ledger entry is never written. That is what keeps a repayment from being
 * recorded twice.
 */
async function moveInstallment(
  tx: Client,
  id: string,
  from: string,
  data: Prisma.EmployeeLoanInstallmentUncheckedUpdateManyInput,
): Promise<void> {
  const moved = await tx.employeeLoanInstallment.updateMany({
    where: { id, status: from as never },
    data,
  });
  if (moved.count !== 1) {
    throw new ConflictError('That installment changed while you were looking at it. Reload and try again.');
  }
}

/**
 * Records an installment as repaid outside payroll.
 *
 * For money that genuinely changed hands some other way - cash, a transfer,
 * or months repaid before the loan was entered in HRMS. It is what stops the
 * next payroll collecting those months a second time.
 *
 * An installment already claimed by a run that is still open (draft or in
 * review) is taken back from that run. The run's stored figures then no longer
 * match its loans, and finalizing refuses until it is recalculated - see
 * `assertRunLoanDeductionsReconcile`. A run that is approved has to be sent
 * back to review first; a finalized one cannot be touched at all.
 */
export async function recordManualPayment(input: {
  companyId: string;
  loanId: string;
  installmentId: string;
  paidOn: string;
  reference: string | null;
  reason: string;
  actorId: string;
}): Promise<{ installmentId: string; loanCompleted: boolean; releasedFromRunId: string | null }> {
  const paidOn = dateColumn(input.paidOn);
  if (paidOn > todayColumn()) {
    throw new ValidationError({ paidOn: ['A payment cannot be recorded for a date that has not happened.'] });
  }

  return prisma.$transaction(async (tx) => {
    const installment = await installmentOrThrow(tx, input);

    if (installment.loan.status !== 'ACTIVE') {
      throw new ConflictError(
        `Payments are recorded against a released loan. This one is ${installment.loan.status.toLowerCase()}.`,
      );
    }

    let releasedFromRunId: string | null = null;
    if (installment.status === 'PENDING_PAYROLL') {
      const runStatus = installment.run?.status ?? null;
      if (!runStatus || !RELEASABLE_RUN_STATUSES.includes(runStatus)) {
        throw new ConflictError(
          runStatus === 'APPROVED'
            ? 'That installment is in an approved payroll run. Send the run back to review before recording a payment against it.'
            : 'That installment is being collected by a payroll run that can no longer change.',
        );
      }
      releasedFromRunId = installment.payrollRunId;
    } else if (installment.status !== 'SCHEDULED') {
      throw new ConflictError(`That installment is already ${installment.status.toLowerCase()}.`);
    }

    await moveInstallment(tx, installment.id, installment.status, {
      status: 'PAID',
      paidAt: paidOn,
      payrollRunId: null,
      note: `Paid outside payroll: ${input.reason}`,
    });

    await tx.employeeLoanTransaction.create({
      data: {
        companyId: input.companyId,
        loanId: input.loanId,
        installmentId: installment.id,
        type: 'MANUAL_PAYMENT',
        amount: installment.amount,
        effectiveDate: paidOn,
        reference: input.reference,
        reason: input.reason,
        detail: releasedFromRunId ? { releasedFromRunId } : undefined,
        createdBy: input.actorId,
      },
    });

    const loanCompleted = await completeIfSettled(input.loanId, tx);
    return { installmentId: installment.id, loanCompleted, releasedFromRunId };
  });
}

/**
 * Settles the first `count` installments of a loan being entered after the
 * fact, as repaid outside payroll.
 *
 * Runs inside the transaction that creates the loan, so a historical loan
 * never exists - not even for a moment a payroll run could read it - with
 * months owed that were paid long ago. Each one gets its own MANUAL_PAYMENT,
 * dated the last day of its month or today, whichever is earlier.
 */
export async function settleHistoricalInstallments(
  tx: Client,
  input: { companyId: string; loanId: string; count: number; reason: string; actorId: string },
): Promise<number> {
  if (input.count <= 0) return 0;
  const rows = await tx.employeeLoanInstallment.findMany({
    where: { loanId: input.loanId, status: 'SCHEDULED' },
    orderBy: { sequence: 'asc' },
    take: input.count,
    select: { id: true, amount: true, dueMonth: true },
  });

  const today = todayColumn();
  for (const row of rows) {
    const monthEnd = new Date(
      Date.UTC(row.dueMonth.getUTCFullYear(), row.dueMonth.getUTCMonth() + 1, 0),
    );
    const paidOn = monthEnd < today ? monthEnd : today;
    await moveInstallment(tx, row.id, 'SCHEDULED', {
      status: 'PAID',
      paidAt: paidOn,
      note: `Repaid before it was entered in HRMS: ${input.reason}`,
    });
    await tx.employeeLoanTransaction.create({
      data: {
        companyId: input.companyId,
        loanId: input.loanId,
        installmentId: row.id,
        type: 'MANUAL_PAYMENT',
        amount: row.amount,
        effectiveDate: paidOn,
        reason: input.reason,
        detail: { historical: true },
        createdBy: input.actorId,
      },
    });
  }
  await completeIfSettled(input.loanId, tx);
  return rows.length;
}

/**
 * Takes back a manual payment recorded in error.
 *
 * Only a MANUAL_PAYMENT can be reversed here. An installment a finalized run
 * deducted was paid out of a payslip that has been issued; undoing it is a
 * payroll correction (an adjustment on the next run), not a loan one.
 */
export async function reverseManualPayment(input: {
  companyId: string;
  loanId: string;
  installmentId: string;
  reason: string;
  actorId: string;
}): Promise<{ installmentId: string; loanReopened: boolean }> {
  return prisma.$transaction(async (tx) => {
    const installment = await installmentOrThrow(tx, input);
    if (installment.status !== 'PAID') {
      throw new ConflictError('Only a paid installment can have its payment reversed.');
    }

    const settlement = await tx.employeeLoanTransaction.findFirst({
      where: {
        installmentId: installment.id,
        type: { in: ['MANUAL_PAYMENT', 'PAYROLL_DEDUCTION'] },
        reversedBy: { is: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!settlement || settlement.type === 'PAYROLL_DEDUCTION' || installment.payrollRunId) {
      throw new ConflictError(
        'That installment was deducted by a finalized payroll run. Correct it with a payroll adjustment on the next run instead.',
      );
    }

    await moveInstallment(tx, installment.id, 'PAID', {
      status: 'SCHEDULED',
      paidAt: null,
      note: `Payment reversed: ${input.reason}`,
    });

    await tx.employeeLoanTransaction.create({
      data: {
        companyId: input.companyId,
        loanId: input.loanId,
        installmentId: installment.id,
        type: 'PAYMENT_REVERSAL',
        amount: settlement.amount,
        effectiveDate: todayColumn(),
        reason: input.reason,
        reversesId: settlement.id,
        createdBy: input.actorId,
      },
    });

    // Owed again, so a loan closed by that payment is open again.
    let loanReopened = false;
    if (installment.loan.status === 'COMPLETED') {
      await tx.employeeLoan.update({
        where: { id: input.loanId },
        data: { status: 'ACTIVE', completedAt: null },
      });
      loanReopened = true;
    }

    return { installmentId: installment.id, loanReopened };
  });
}

/**
 * Forgives one installment without ending the loan.
 *
 * Settles it - it is no longer owed - but it is not a payment, and the ledger
 * says so: a WAIVER, with the reason, never a MANUAL_PAYMENT.
 */
export async function waiveInstallment(input: {
  companyId: string;
  loanId: string;
  installmentId: string;
  reason: string;
  actorId: string;
}): Promise<{ installmentId: string; sequence: number; amount: number; employeeId: string; loanCompleted: boolean }> {
  return prisma.$transaction(async (tx) => {
    const installment = await installmentOrThrow(tx, input);

    if (installment.status !== 'SCHEDULED') {
      throw new ConflictError(
        installment.status === 'PENDING_PAYROLL'
          ? 'That installment is in a payroll run that has not been finalized. Recalculate or cancel the run first.'
          : `That installment is already ${installment.status.toLowerCase()}.`,
      );
    }

    await moveInstallment(tx, installment.id, 'SCHEDULED', {
      status: 'WAIVED',
      note: input.reason,
    });

    await tx.employeeLoanTransaction.create({
      data: {
        companyId: input.companyId,
        loanId: input.loanId,
        installmentId: installment.id,
        type: 'WAIVER',
        amount: installment.amount,
        effectiveDate: todayColumn(),
        reason: input.reason,
        createdBy: input.actorId,
      },
    });

    const loanCompleted = await completeIfSettled(input.loanId, tx);
    return {
      installmentId: installment.id,
      sequence: installment.sequence,
      amount: toNumber(installment.amount),
      employeeId: installment.loan.employeeId,
      loanCompleted,
    };
  });
}

interface ScheduleMove {
  sequence: number;
  from: string;
  to: string;
}

/**
 * Re-dates every installment still SCHEDULED, keeping their order and spacing.
 *
 * Writes the moves, the loan's start month and one SCHEDULE_CORRECTION entry.
 * Rows already claimed, paid, waived or not collected stay where they are:
 * they are history, and history is not re-dated.
 */
async function applyScheduleMoves(
  tx: Client,
  input: {
    companyId: string;
    loanId: string;
    reason: string;
    actorId: string | null;
    kind: 'RESCHEDULE' | 'CARRY_FORWARD';
    monthFor: (index: number, current: string) => string;
  },
): Promise<ScheduleMove[]> {
  const scheduled = await tx.employeeLoanInstallment.findMany({
    where: { loanId: input.loanId, status: 'SCHEDULED' },
    orderBy: { sequence: 'asc' },
    select: { id: true, sequence: true, dueMonth: true },
  });

  const moves: ScheduleMove[] = [];
  for (const [index, row] of scheduled.entries()) {
    const from = monthOf(row.dueMonth);
    const to = input.monthFor(index, from).slice(0, 7);
    if (from === to) continue;
    await tx.employeeLoanInstallment.update({
      where: { id: row.id },
      data: { dueMonth: toMonthStart(to) },
    });
    moves.push({ sequence: row.sequence, from, to });
  }
  if (moves.length === 0) return moves;

  // The loan's start month follows its first installment still on the books.
  const first = await tx.employeeLoanInstallment.findFirst({
    where: { loanId: input.loanId, status: { not: 'SKIPPED' } },
    orderBy: { sequence: 'asc' },
    select: { dueMonth: true },
  });
  if (first) {
    await tx.employeeLoan.update({
      where: { id: input.loanId },
      data: { startMonth: first.dueMonth },
    });
  }

  await tx.employeeLoanTransaction.create({
    data: {
      companyId: input.companyId,
      loanId: input.loanId,
      type: 'SCHEDULE_CORRECTION',
      amount: 0,
      effectiveDate: todayColumn(),
      reason: input.reason,
      detail: { kind: input.kind, moves } as unknown as Prisma.InputJsonValue,
      createdBy: input.actorId,
    },
  });

  return moves;
}

/**
 * Moves a loan's remaining schedule to start in a different month.
 *
 * The audited way to change a deduction month - an advance recovered from
 * December instead of November, or a historical loan whose first deduction was
 * entered in the wrong month. No target month may be one whose payroll is
 * finalized: that payroll cannot collect it.
 */
export async function rescheduleLoan(input: {
  companyId: string;
  loanId: string;
  startMonth: string;
  reason: string;
  actorId: string;
}): Promise<{ moves: ScheduleMove[] }> {
  return prisma.$transaction(async (tx) => {
    const loan = await tx.employeeLoan.findFirst({
      where: { id: input.loanId, companyId: input.companyId },
      select: { id: true, status: true },
    });
    if (!loan) throw new NotFoundError('Loan');
    if (!['PENDING', 'APPROVED', 'ACTIVE'].includes(loan.status)) {
      throw new ConflictError(`A loan in ${loan.status.toLowerCase()} has nothing left to reschedule.`);
    }

    const count = await tx.employeeLoanInstallment.count({
      where: { loanId: loan.id, status: 'SCHEDULED' },
    });
    if (count === 0) {
      throw new ConflictError('Nothing on this loan is still scheduled.');
    }

    const target = input.startMonth.slice(0, 7);
    const closed = await closedPayrollMonths(input.companyId, target, tx);
    for (let i = 0; i < count; i += 1) {
      const month = addMonths(target, i).slice(0, 7);
      if (closed.has(month)) {
        throw new ValidationError({
          startMonth: [`Payroll for ${month} is already finalized, so nothing can be scheduled into it.`],
        });
      }
    }

    const moves = await applyScheduleMoves(tx, {
      companyId: input.companyId,
      loanId: loan.id,
      reason: input.reason,
      actorId: input.actorId,
      kind: 'RESCHEDULE',
      monthFor: (index) => addMonths(target, index),
    });
    return { moves };
  });
}

/**
 * The defined policy for a loan released after its first month's payroll is
 * already finalized: the remaining schedule is carried forward to the first
 * open month, on the record, rather than left pointing at a payroll that can
 * no longer collect it.
 *
 * Not for a salary advance. An advance keeps the month it was requested for
 * and waits on an authorised decision instead - see `advanceAwaitingDecision`
 * - so nothing here moves it.
 *
 * Returns the move, or null when nothing had to move.
 */
export async function carryForwardPastClosedMonths(
  tx: Client,
  input: { companyId: string; loanId: string; actorId: string | null },
): Promise<{ from: string; to: string } | null> {
  const loan = await tx.employeeLoan.findUnique({
    where: { id: input.loanId },
    select: { kind: true },
  });
  if (!loan || loan.kind === 'SALARY_ADVANCE') return null;

  const first = await tx.employeeLoanInstallment.findFirst({
    where: { loanId: input.loanId, status: 'SCHEDULED' },
    orderBy: { sequence: 'asc' },
    select: { dueMonth: true },
  });
  if (!first) return null;

  const firstMonth = monthOf(first.dueMonth);
  const closed = await closedPayrollMonths(input.companyId, firstMonth, tx);
  const shift = carryForwardShift(firstMonth, closed);
  if (shift === 0) return null;

  const to = addMonths(firstMonth, shift).slice(0, 7);
  await applyScheduleMoves(tx, {
    companyId: input.companyId,
    loanId: input.loanId,
    reason: `Carried forward: payroll for ${firstMonth} was already finalized when this was released.`,
    actorId: input.actorId,
    kind: 'CARRY_FORWARD',
    monthFor: (_index, current) => addMonths(current, shift),
  });
  return { from: firstMonth, to };
}

/**
 * The finalized month a salary advance is still scheduled in, or null.
 *
 * Such an advance is flagged rather than moved: payroll holds the recovery
 * and an authorised user chooses a revised month (`rescheduleLoan`, which
 * keeps the original and revised month, the actor and the reason on the
 * ledger) or records the repayment outside payroll.
 */
export async function advanceAwaitingDecision(
  client: Client,
  input: { companyId: string; loanId: string },
): Promise<string | null> {
  const loan = await client.employeeLoan.findUnique({
    where: { id: input.loanId },
    select: { kind: true, status: true },
  });
  if (!loan) return null;
  const rows = await client.employeeLoanInstallment.findMany({
    where: { loanId: input.loanId, status: 'SCHEDULED' },
    select: { status: true, dueMonth: true },
  });
  if (rows.length === 0) return null;
  const earliest = rows.map((r) => monthOf(r.dueMonth)).sort()[0]!;
  const closed = await closedPayrollMonths(input.companyId, earliest, client);
  return advanceNeedsDeductionDecision(
    {
      kind: loan.kind,
      status: loan.status,
      installments: rows.map((r) => ({ status: r.status, dueMonth: monthOf(r.dueMonth) })),
    },
    closed,
  );
}

/**
 * The ledger entries for what a finalizing run collected.
 *
 * Called inside the finalize transaction, BEFORE the installments are marked
 * PAID, so it reads exactly the rows that run is about to settle.
 */
export async function recordPayrollDeductions(
  tx: Client,
  input: { companyId: string; runId: string; finalizedAt: Date; actorId: string | null },
): Promise<number> {
  const collected = await tx.employeeLoanInstallment.findMany({
    where: { payrollRunId: input.runId, status: 'PENDING_PAYROLL' },
    select: { id: true, loanId: true, amount: true },
  });
  if (collected.length === 0) return 0;

  const effectiveDate = dateColumn(input.finalizedAt.toISOString());
  await tx.employeeLoanTransaction.createMany({
    data: collected.map((row) => ({
      companyId: input.companyId,
      loanId: row.loanId,
      installmentId: row.id,
      type: 'PAYROLL_DEDUCTION' as const,
      amount: row.amount,
      effectiveDate,
      payrollRunId: input.runId,
      createdBy: input.actorId,
    })),
  });
  return collected.length;
}

const PAYROLL_LOAN_CODES = Object.values(LOAN_KIND_PAYROLL_CODES) as string[];

/**
 * Refuses to finalize a run whose loan deductions disagree with its loans.
 *
 * A run stores its lines when it is calculated. If a repayment is recorded
 * afterwards - or anything else releases an installment the run had claimed -
 * the stored payslip would deduct money the loan no longer expects, and the
 * finalize would mark nothing paid for it. Both are a duplicate deduction in
 * all but name, so the run has to be recalculated first.
 *
 * Compared per employee: the LOAN and ADVANCE deductions on the line against
 * the installments the run has claimed.
 */
export async function assertRunLoanDeductionsReconcile(
  client: Client | typeof prisma,
  runId: string,
): Promise<void> {
  const [lines, claimed] = await Promise.all([
    client.payrollLine.findMany({
      where: { runId },
      select: {
        employeeId: true,
        deductions: { where: { code: { in: PAYROLL_LOAN_CODES } }, select: { amount: true } },
      },
    }),
    client.employeeLoanInstallment.findMany({
      where: { payrollRunId: runId, status: 'PENDING_PAYROLL' },
      select: { employeeId: true, amount: true },
    }),
  ]);

  const deducted = new Map<string, number>();
  for (const line of lines) {
    const total = line.deductions.reduce((sum, d) => sum + toNumber(d.amount), 0);
    if (total !== 0) deducted.set(line.employeeId, total);
  }
  const owed = new Map<string, number>();
  for (const row of claimed) {
    owed.set(row.employeeId, (owed.get(row.employeeId) ?? 0) + toNumber(row.amount));
  }

  const employees = new Set([...deducted.keys(), ...owed.keys()]);
  const mismatched = [...employees].filter(
    (id) => Math.abs((deducted.get(id) ?? 0) - (owed.get(id) ?? 0)) >= 0.01,
  );
  if (mismatched.length > 0) {
    throw new ValidationError({
      run: [
        `Loan deductions on ${mismatched.length} line(s) no longer match the loans they collect - a repayment was recorded or a loan changed after this run was calculated. Recalculate the run before finalizing it.`,
      ],
    });
  }
}
