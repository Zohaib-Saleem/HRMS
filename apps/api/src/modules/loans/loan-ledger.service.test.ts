import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The loan ledger, against an in-memory store.
 *
 * The scenario these tests are built around is the one production is in: a
 * loan entered in October with a start month of April, so the September run -
 * still in review - has claimed six installments at once. Five of them were
 * repaid before HRMS knew about the loan. The correction has to settle those
 * five without a second deduction, without touching the sixth, and without
 * letting the run be finalized on figures that still deduct all six.
 */

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  installments: [] as Row[],
  transactions: [] as Row[],
  loans: [] as Row[],
  runs: [] as Row[],
  periods: [] as Row[],
  lines: [] as Row[],
  seq: 0,
}));

/** Equality, `in`, `not`, `lte`/`gte` - the operators the ledger uses. */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      if ('is' in c) return true; // relation filters are applied by the caller
      if ('lte' in c) return (value as Date) <= (c.lte as Date);
      if ('gte' in c) return (value as Date) >= (c.gte as Date);
    }
    if (value instanceof Date && cond instanceof Date) return value.getTime() === cond.getTime();
    return value === cond;
  });
}

const bySequence = (a: Row, b: Row) => (a.sequence as number) - (b.sequence as number);

const db = vi.hoisted(() => {
  const id = (prefix: string) => `${prefix}-${++store.seq}`;
  const withRelations = (row: Row) => ({
    ...row,
    loan: store.loans.find((l) => l.id === row.loanId),
    run: store.runs.find((r) => r.id === row.payrollRunId) ?? null,
  });
  return {
    company: { findUniqueOrThrow: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    employeeLoan: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.loans.find((l) => matches(l, where)) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.loans.find((l) => l.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const loan = store.loans.find((l) => l.id === where.id)!;
        Object.assign(loan, data);
        return loan;
      }),
    },
    employeeLoanInstallment: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const rows = store.installments.filter((r) => matches(r, where));
        if (orderBy) rows.sort(bySequence);
        return rows[0] ? withRelations(rows[0]) : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        store.installments
          .filter((r) => matches(r, where))
          .sort(bySequence)
          .slice(0, take ?? Infinity),
      ),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.installments.filter((r) => matches(r, where)).length,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = store.installments.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const rows = store.installments.filter((r) => matches(r, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    employeeLoanTransaction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { createdAt: new Date(Date.now() + store.seq), ...data, id: id('tx') } as Row;
        store.transactions.push(row);
        return row;
      }),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const d of data) store.transactions.push({ ...d, id: id('tx'), createdAt: new Date() });
        return { count: data.length };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const reversed = new Set(store.transactions.map((t) => t.reversesId));
        const rows = store.transactions
          .filter((t) => matches(t, where))
          .filter((t) => !('reversedBy' in where) || !reversed.has(t.id));
        return rows.at(-1) ?? null;
      }),
    },
    payrollPeriod: {
      findMany: vi.fn(async ({ where }: { where: { endDate: { gte: Date } } }) =>
        store.periods.filter(
          (p) =>
            (p.endDate as Date) >= where.endDate.gte &&
            (p.status === 'CLOSED' ||
              store.runs.some((r) => r.periodId === p.id && r.status === 'FINALIZED')),
        ),
      ),
    },
    payrollLine: {
      findMany: vi.fn(async ({ where }: { where: { runId: string } }) =>
        store.lines.filter((l) => l.runId === where.runId),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
});

vi.mock('../../core/db.js', () => ({ prisma: db }));

const ledger = await import('./loan-ledger.service.js');
const { completeIfSettled } = await import('./loans.service.js');

const month = (m: string) => new Date(`${m}-01T00:00:00.000Z`);

/** The production shape: 70,000 over six months from April, all six claimed by September's run. */
function seedHistoricalLoan(runStatus = 'REVIEW') {
  store.loans.push({ id: 'loan-1', companyId: 'c1', employeeId: 'e1051', status: 'ACTIVE', kind: 'LOAN', reference: null });
  store.runs.push({ id: 'run-sep', periodId: 'p-sep', status: runStatus });
  store.periods.push({ id: 'p-sep', startDate: month('2026-09'), endDate: new Date('2026-09-30T00:00:00Z'), status: 'OPEN' });
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  months.forEach((m, i) =>
    store.installments.push({
      id: `inst-${i + 1}`,
      companyId: 'c1',
      loanId: 'loan-1',
      employeeId: 'e1051',
      sequence: i + 1,
      dueMonth: month(m),
      amount: i === 5 ? 11666.7 : 11666.66,
      status: 'PENDING_PAYROLL',
      payrollRunId: 'run-sep',
      paidAt: null,
      note: null,
    }),
  );
  // The stored line, calculated before the correction: all six deducted.
  store.lines.push({
    id: 'line-1051',
    runId: 'run-sep',
    employeeId: 'e1051',
    deductions: [{ amount: 70000 }],
  });
}

const record = (installmentId: string, over: Partial<Parameters<typeof ledger.recordManualPayment>[0]> = {}) =>
  ledger.recordManualPayment({
    companyId: 'c1',
    loanId: 'loan-1',
    installmentId,
    paidOn: '2026-08-31',
    reference: 'Bank ref 991',
    reason: 'Repaid by salary cut before HRMS',
    actorId: 'user-accounts',
    ...over,
  });

beforeEach(() => {
  store.installments.length = 0;
  store.transactions.length = 0;
  store.loans.length = 0;
  store.runs.length = 0;
  store.periods.length = 0;
  store.lines.length = 0;
  store.seq = 0;
});

describe('recording months repaid before HRMS', () => {
  it('settles the five old months, leaves September for payroll, and writes one ledger entry each', async () => {
    seedHistoricalLoan();
    for (const id of ['inst-1', 'inst-2', 'inst-3', 'inst-4', 'inst-5']) {
      const result = await record(id);
      expect(result.releasedFromRunId).toBe('run-sep');
    }

    const paid = store.installments.filter((i) => i.status === 'PAID');
    expect(paid.map((i) => i.id)).toEqual(['inst-1', 'inst-2', 'inst-3', 'inst-4', 'inst-5']);
    expect(paid.every((i) => i.payrollRunId === null)).toBe(true);
    expect(store.installments.find((i) => i.id === 'inst-6')).toMatchObject({
      status: 'PENDING_PAYROLL',
      payrollRunId: 'run-sep',
    });

    expect(store.transactions).toHaveLength(5);
    expect(store.transactions.every((t) => t.type === 'MANUAL_PAYMENT')).toBe(true);
    expect(store.transactions[0]).toMatchObject({
      installmentId: 'inst-1',
      amount: 11666.66,
      reference: 'Bank ref 991',
      reason: 'Repaid by salary cut before HRMS',
      createdBy: 'user-accounts',
    });
    expect(store.loans[0]!.status).toBe('ACTIVE');
  });

  it('cannot record the same installment twice', async () => {
    seedHistoricalLoan();
    await record('inst-1');
    await expect(record('inst-1')).rejects.toThrow(/already paid/);
    expect(store.transactions).toHaveLength(1);
  });

  it('blocks the run from finalizing until it is recalculated, so nothing is deducted twice', async () => {
    seedHistoricalLoan();
    await expect(ledger.assertRunLoanDeductionsReconcile(db as never, 'run-sep')).resolves.toBeUndefined();

    await record('inst-1');
    await expect(ledger.assertRunLoanDeductionsReconcile(db as never, 'run-sep')).rejects.toMatchObject({
      statusCode: 422,
      details: { run: [expect.stringMatching(/Recalculate the run/)] },
    });

    // What recalculating produces: a line deducting only what is still claimed.
    for (const id of ['inst-2', 'inst-3', 'inst-4', 'inst-5']) await record(id);
    store.lines[0]!.deductions = [{ amount: 11666.7 }];
    await expect(ledger.assertRunLoanDeductionsReconcile(db as never, 'run-sep')).resolves.toBeUndefined();
  });

  it('refuses an installment in an approved run until the run is sent back to review', async () => {
    seedHistoricalLoan('APPROVED');
    await expect(record('inst-1')).rejects.toThrow(/Send the run back to review/);
    expect(store.installments[0]!.status).toBe('PENDING_PAYROLL');
    expect(store.transactions).toHaveLength(0);
  });

  it('refuses a payment dated in the future', async () => {
    seedHistoricalLoan();
    await expect(record('inst-1', { paidOn: '2999-01-01' })).rejects.toThrow();
  });

  it('refuses a payment against a loan that was never released', async () => {
    seedHistoricalLoan();
    store.loans[0]!.status = 'APPROVED';
    await expect(record('inst-1')).rejects.toThrow(/released loan/);
  });

  it('completes the loan when the last installment is recorded', async () => {
    seedHistoricalLoan();
    for (const id of ['inst-1', 'inst-2', 'inst-3', 'inst-4', 'inst-5', 'inst-6']) await record(id);
    expect(store.loans[0]!.status).toBe('COMPLETED');
  });
});

describe('a loan entered with its earlier months already repaid', () => {
  it('settles exactly the first N installments as historical manual payments', async () => {
    seedHistoricalLoan();
    for (const row of store.installments) Object.assign(row, { status: 'SCHEDULED', payrollRunId: null });

    const settled = await ledger.settleHistoricalInstallments(db as never, {
      companyId: 'c1',
      loanId: 'loan-1',
      count: 5,
      reason: 'Deducted from pay in the old system',
      actorId: 'user-hr',
    });

    expect(settled).toBe(5);
    expect(store.installments.filter((i) => i.status === 'PAID')).toHaveLength(5);
    expect(store.installments.find((i) => i.id === 'inst-6')!.status).toBe('SCHEDULED');
    // Dated at the end of the month each was repaid in.
    expect(store.installments.find((i) => i.id === 'inst-1')!.paidAt).toEqual(new Date('2026-04-30T00:00:00Z'));
    expect(store.transactions.every((t) => t.type === 'MANUAL_PAYMENT')).toBe(true);
  });
});

describe('reversing a payment recorded in error', () => {
  it('puts the installment back to scheduled and keeps both ledger entries', async () => {
    seedHistoricalLoan();
    await record('inst-1');
    const original = store.transactions[0]!;

    await ledger.reverseManualPayment({
      companyId: 'c1',
      loanId: 'loan-1',
      installmentId: 'inst-1',
      reason: 'Recorded against the wrong month',
      actorId: 'user-accounts',
    });

    expect(store.installments[0]).toMatchObject({ status: 'SCHEDULED', paidAt: null });
    expect(store.transactions).toHaveLength(2);
    expect(store.transactions[1]).toMatchObject({
      type: 'PAYMENT_REVERSAL',
      reversesId: original.id,
      amount: original.amount,
    });
  });

  it('reopens a loan the reversed payment had completed', async () => {
    seedHistoricalLoan();
    for (const id of ['inst-1', 'inst-2', 'inst-3', 'inst-4', 'inst-5', 'inst-6']) await record(id);
    expect(store.loans[0]!.status).toBe('COMPLETED');

    const result = await ledger.reverseManualPayment({
      companyId: 'c1',
      loanId: 'loan-1',
      installmentId: 'inst-6',
      reason: 'September is collected by payroll',
      actorId: 'user-accounts',
    });
    expect(result.loanReopened).toBe(true);
    expect(store.loans[0]).toMatchObject({ status: 'ACTIVE', completedAt: null });
  });

  it('will not reverse money a finalized payroll run deducted', async () => {
    seedHistoricalLoan();
    Object.assign(store.installments[5]!, { status: 'PAID' });
    store.transactions.push({
      id: 'tx-payroll',
      installmentId: 'inst-6',
      type: 'PAYROLL_DEDUCTION',
      amount: 11666.7,
      createdAt: new Date(),
    });

    await expect(
      ledger.reverseManualPayment({
        companyId: 'c1',
        loanId: 'loan-1',
        installmentId: 'inst-6',
        reason: 'Trying to undo payroll',
        actorId: 'user-accounts',
      }),
    ).rejects.toThrow(/payroll adjustment/);
  });
});

describe('waiving', () => {
  it('settles the installment as WAIVED - not paid - with the reason on the ledger', async () => {
    seedHistoricalLoan();
    for (const row of store.installments) Object.assign(row, { status: 'SCHEDULED', payrollRunId: null });

    await ledger.waiveInstallment({
      companyId: 'c1',
      loanId: 'loan-1',
      installmentId: 'inst-2',
      reason: 'Hardship relief approved by the CEO',
      actorId: 'user-hr',
    });

    expect(store.installments[1]!.status).toBe('WAIVED');
    expect(store.transactions).toEqual([
      expect.objectContaining({ type: 'WAIVER', reason: 'Hardship relief approved by the CEO' }),
    ]);
    expect(store.transactions.some((t) => t.type === 'MANUAL_PAYMENT')).toBe(false);
  });
});

describe('deduction months', () => {
  function seedAdvance(dueMonth: string) {
    store.loans.push({ id: 'loan-1', companyId: 'c1', employeeId: 'e219', status: 'APPROVED', kind: 'SALARY_ADVANCE', startMonth: month(dueMonth) });
    store.installments.push({
      id: 'inst-1', companyId: 'c1', loanId: 'loan-1', employeeId: 'e219', sequence: 1,
      dueMonth: month(dueMonth), amount: 10000, status: 'SCHEDULED', payrollRunId: null,
    });
  }

  it('carries an advance released after its month closed to the first open month, on the record', async () => {
    seedAdvance('2026-10');
    store.periods.push({ id: 'p-oct', startDate: month('2026-10'), endDate: new Date('2026-10-31T00:00:00Z'), status: 'CLOSED' });

    const moved = await ledger.carryForwardPastClosedMonths(db as never, {
      companyId: 'c1',
      loanId: 'loan-1',
      actorId: 'user-hr',
    });

    expect(moved).toEqual({ from: '2026-10', to: '2026-11' });
    expect(store.installments[0]!.dueMonth).toEqual(month('2026-11'));
    expect(store.loans[0]!.startMonth).toEqual(month('2026-11'));
    expect(store.transactions[0]).toMatchObject({ type: 'SCHEDULE_CORRECTION', amount: 0 });
  });

  it('leaves an open month alone', async () => {
    seedAdvance('2026-11');
    const moved = await ledger.carryForwardPastClosedMonths(db as never, { companyId: 'c1', loanId: 'loan-1', actorId: null });
    expect(moved).toBeNull();
    expect(store.transactions).toHaveLength(0);
  });

  it('refuses to reschedule into a finalized month, and records a valid move with its reason', async () => {
    seedAdvance('2026-11');
    store.runs.push({ id: 'run-dec', periodId: 'p-dec', status: 'FINALIZED' });
    store.periods.push({ id: 'p-dec', startDate: month('2026-12'), endDate: new Date('2026-12-31T00:00:00Z'), status: 'OPEN' });

    await expect(
      ledger.rescheduleLoan({ companyId: 'c1', loanId: 'loan-1', startMonth: '2026-12', reason: 'Employee asked', actorId: 'u' }),
    ).rejects.toMatchObject({
      details: { startMonth: [expect.stringMatching(/already finalized/)] },
    });

    const { moves } = await ledger.rescheduleLoan({
      companyId: 'c1',
      loanId: 'loan-1',
      startMonth: '2027-01',
      reason: 'Employee asked to move it after the holidays',
      actorId: 'u',
    });
    expect(moves).toEqual([{ sequence: 1, from: '2026-11', to: '2027-01' }]);
    expect(store.transactions.at(-1)).toMatchObject({
      type: 'SCHEDULE_CORRECTION',
      reason: 'Employee asked to move it after the holidays',
    });
  });
});

describe('completion', () => {
  it('does not complete a loan with anything still claimed by an open run', async () => {
    seedHistoricalLoan();
    for (const id of ['inst-1', 'inst-2', 'inst-3', 'inst-4', 'inst-5']) await record(id);
    expect(await completeIfSettled('loan-1', db as never)).toBe(false);
  });
});
