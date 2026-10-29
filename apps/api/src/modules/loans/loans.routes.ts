import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  LOAN_KIND_LABELS,
  PERMISSIONS,
  SALARY_ADVANCE_INSTALLMENTS,
  idParamSchema,
  loanApplicationSchema,
  loanCancelSchema,
  loanCreateSchema,
  loanDecisionSchema,
  loanQuerySchema,
  loanRecordPaymentSchema,
  loanRejectSchema,
  loanRescheduleSchema,
  loanReversePaymentSchema,
  loanWaiveSchema,
  monthlyDeductionFor,
  type LoanKind,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  assertChainUsable,
  cancel as cancelApproval,
  createApprovalRequest,
  notifyApprover,
  resolveChain,
} from '../../core/approvals/approval.service.js';
import { notify } from '../../core/notifications/notification.service.js';
import { callerEmployeeOrThrow } from '../time/helpers.js';
import { evaluateLoanEligibility } from './loan-eligibility.service.js';
import { currentLoanPolicy } from './loan-policy.service.js';
import {
  LOAN_DETAIL_INCLUDE,
  LOAN_INCLUDE,
  day,
  scheduleRows,
  toLoanDetail,
  toLoanRecord,
  toMonthStart,
  toNumber,
} from './loans.service.js';
import {
  advanceAwaitingDecision,
  canCorrectLoans,
  carryForwardPastClosedMonths,
  recordManualPayment,
  rescheduleLoan,
  reverseManualPayment,
  settleHistoricalInstallments,
  waiveInstallment,
} from './loan-ledger.service.js';
import {
  closedPayrollMonths,
  currentPayrollMonth,
  deductionMonthInfo,
  resolveRequestedDeductionMonth,
} from './loan-schedule.service.js';

/**
 * Employee loans.
 *
 * Two ways a loan comes into being and they meet in the same table: an
 * administrator records one that has already been agreed, or an employee
 * applies and it runs through the same approval engine as leave, timesheets
 * and shift changes. Nothing here invents a second workflow.
 *
 * The state machine, and what each state costs the employee:
 *
 *   PENDING   applied for            nothing is deducted
 *   APPROVED  agreed, not released   nothing is deducted
 *   ACTIVE    released               payroll collects the installment due
 *   REJECTED / CANCELLED             nothing is deducted, ever again
 *   COMPLETED schedule settled       nothing left to collect
 *
 * Approval and release are separate acts on purpose. Somebody agreeing to a
 * loan and somebody handing over the money are two decisions, and only the
 * second one should start taking money out of a payslip.
 */

const employeeLabel = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

/** Far enough back to read every finalized payroll month the company has. */
const EARLIEST_MONTH = '2000-01';

/** The sentence an employee reads when their advance's month is already finalized. */
const awaitingDecisionNote = (month: string) =>
  ` Payroll for ${month} is already finalized, so it will not be changed: Payroll will confirm the month this is recovered from, and you will be told.`;

/** "loan" or "salary advance", for sentences an audit row or a toast reads. */
const nounFor = (kind: LoanKind) => LOAN_KIND_LABELS[kind].toLowerCase();

/**
 * Tells the employee what happened to their loan or advance when it is decided
 * or released from this screen. A decision made from the Approvals screen is
 * told by the approval engine instead; these are the routes that bypass it.
 * Best-effort: `notify` never throws, and an employee without a login is
 * skipped. Amounts stay in the in-app message - the browser push for an
 * `EmployeeLoan` never carries them.
 */
async function notifyLoanHolder(
  request: FastifyRequest,
  loan: { id: string; companyId: string; employeeId: string },
  title: string,
  message: string,
): Promise<void> {
  const employee = await prisma.employee.findUnique({
    where: { id: loan.employeeId },
    select: { userId: true },
  });
  if (!employee?.userId) return;
  await notify({
    companyId: loan.companyId,
    userId: employee.userId,
    type: 'SYSTEM',
    title,
    message,
    entityType: 'EmployeeLoan',
    entityId: loan.id,
    logger: request.log,
  });
}

async function callerContext(auth: {
  companyId: string;
  userId: string;
  permissions: ReadonlySet<string>;
}) {
  const self = await prisma.employee.findFirst({
    where: { companyId: auth.companyId, userId: auth.userId },
    select: { id: true },
  });
  return {
    employeeId: self?.id ?? null,
    canApprove: auth.permissions.has(PERMISSIONS.LOAN_APPROVE),
    canManage: auth.permissions.has(PERMISSIONS.LOAN_MANAGE),
    canCorrect: canCorrectLoans(auth.permissions),
  };
}

/**
 * One loan in full, as every endpoint that changes a loan returns it: the
 * schedule, the ledger behind it with the names of who recorded what, and the
 * month the screen should measure Due and Overdue against.
 */
async function loanDetailFor(
  auth: { companyId: string; userId: string; permissions: ReadonlySet<string> },
  loanId: string,
) {
  const [row, currentMonth, caller, closedMonths] = await Promise.all([
    prisma.employeeLoan.findUniqueOrThrow({ where: { id: loanId }, include: LOAN_DETAIL_INCLUDE }),
    currentPayrollMonth(auth.companyId),
    callerContext(auth),
    closedPayrollMonths(auth.companyId, EARLIEST_MONTH),
  ]);
  const actorIds = [
    ...new Set((row.transactions ?? []).map((t) => t.createdBy).filter(Boolean) as string[]),
  ];
  const users = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true, employee: { select: { firstName: true, lastName: true, displayName: true } } },
      })
    : [];
  const names = new Map(
    users.map((u) => [u.id, u.employee ? employeeLabel(u.employee) : u.email] as const),
  );
  return toLoanDetail(row, caller, { currentMonth, names, closedMonths });
}

/**
 * Correcting a loan's history needs both halves of the authority behind it.
 *
 * `loan.manage` for the loan and `payroll.manage` for what payroll does with
 * it: Super Admin, HR Admin and Accounts hold both; nobody else does.
 */
function requireLoanCorrector() {
  return async (request: FastifyRequest) => {
    const auth = requireAuthContext(request);
    if (!canCorrectLoans(auth.permissions)) {
      throw new ForbiddenError('Correcting loan history needs both loan and payroll management permissions.');
    }
  };
}

/**
 * Rejects a schedule that would clash with one the employee is still repaying.
 *
 * Within a kind: a loan being repaid does not block an advance, nor the other
 * way round. Two advances, or two loans, open at once still cannot happen.
 */
async function assertNoActiveLoan(
  employeeId: string,
  kind: LoanKind,
  excludeLoanId?: string,
): Promise<void> {
  const existing = await prisma.employeeLoan.findFirst({
    where: {
      employeeId,
      kind,
      status: { in: ['PENDING', 'APPROVED', 'ACTIVE'] },
      ...(excludeLoanId ? { NOT: { id: excludeLoanId } } : {}),
    },
    select: { id: true, status: true },
  });

  if (existing) {
    throw new ValidationError({
      principalAmount: [
        `That employee already has a ${nounFor(kind)} in ${existing.status.toLowerCase()}. Settle or cancel it before starting another.`,
      ],
    });
  }
}

/**
 * Refuse an application the loan policy does not allow.
 *
 * The gate, and the only one that counts. The browser runs the same evaluation
 * to draw its form, but nothing it sends is trusted here: the subject, the
 * salary, the attendance and every threshold are re-read from the database
 * inside `evaluateLoanEligibility`, so a forged eligibility response, an edited
 * maximum or a hand-rolled POST all meet the same answer.
 *
 * It sits in FRONT of the existing application flow and changes nothing behind
 * it. A loan that passes is created exactly as it always was - same schedule,
 * same approval chain, same statuses, same payroll collector.
 *
 * `override` is how an authorised user allows an application the rules refused.
 * It is refused in turn unless the policy permits overrides, and the reason is
 * mandatory when the policy says so: an unexplained exception to a financial
 * control is worth less than no exception at all.
 */
async function assertLoanAllowed(input: {
  companyId: string;
  employeeId: string;
  principalAmount: number;
  installmentCount: number;
  kind: LoanKind;
  override?: { by: string; reason: string | null; request: FastifyRequest } | null;
}): Promise<void> {
  const result = await evaluateLoanEligibility({
    companyId: input.companyId,
    employeeId: input.employeeId,
    requestedAmount: input.principalAmount,
    requestedInstallments: input.installmentCount,
    kind: input.kind,
  });

  if (result.eligible) return;

  const override = input.override ?? null;
  if (!override) {
    throw new ValidationError({ principalAmount: result.reasons });
  }

  const policy = await currentLoanPolicy(input.companyId);
  if (!policy.allowHrOverride) {
    throw new ForbiddenError('The loan policy does not allow eligibility to be overridden.');
  }
  if (policy.requireOverrideReason && !override.reason) {
    throw new ValidationError({
      overrideReason: ['Give a reason for overriding the eligibility rules.'],
    });
  }

  // The exception, on the record. Who allowed it, when, why, and exactly which
  // rules were set aside - so the decision can be read back later by somebody
  // who was not in the room.
  await recordAudit({
    companyId: input.companyId,
    actorId: override.by,
    action: 'loan.eligibility.override',
    entityType: 'Employee',
    entityId: input.employeeId,
    summary: `Overrode ${result.failedRules.length} loan eligibility rule(s): ${result.failedRules.join(', ')}`,
    after: {
      failedRules: result.failedRules,
      reasons: result.reasons,
      reason: override.reason,
      kind: input.kind,
      principalAmount: input.principalAmount,
      installmentCount: input.installmentCount,
    },
    request: override.request,
  });
}

export const loanRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requirePermission(PERMISSIONS.LOAN_READ));

  app.get('/', async (request, reply) => {
    const auth = requireAuthContext(request);
    const query = parseOrThrow(loanQuerySchema, request.query);

    // Loans inherit the employee data scope: an employee with an OWN scope
    // sees their own and nothing else, without a second permission.
    const scopeFilter = await employeeScopeFilter(auth);
    if (scopeFilter === null) {
      return reply.send({ data: [], meta: buildMeta(query.page, query.limit, 0) });
    }
    if (query.employeeId) await assertEmployeeInScope(auth, query.employeeId);

    const caller = await callerContext(auth);

    const where: Prisma.EmployeeLoanWhereInput = {
      AND: [
        { companyId: auth.companyId },
        { employee: scopeFilter },
        query.view === 'mine' ? { employeeId: caller.employeeId ?? '__none__' } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.status ? { status: query.status } : {},
        query.kind ? { kind: query.kind } : {},
        query.employmentStatus ? { employee: { employmentStatus: query.employmentStatus } } : {},
        query.q
          ? {
              OR: [
                { reference: { contains: query.q, mode: 'insensitive' } },
                { purpose: { contains: query.q, mode: 'insensitive' } },
                { employee: { firstName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { lastName: { contains: query.q, mode: 'insensitive' } } },
                { employee: { employeeNumber: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.limit);
    const [total, rows, closedMonths] = await Promise.all([
      prisma.employeeLoan.count({ where }),
      prisma.employeeLoan.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
        include: LOAN_INCLUDE,
      }),
      closedPayrollMonths(auth.companyId, EARLIEST_MONTH),
    ]);

    return reply.send({
      data: rows.map((row) => toLoanRecord(row, caller, closedMonths)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.employeeLoan.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, employeeId: true },
    });
    if (!row) throw new NotFoundError('Loan');

    await assertEmployeeInScope(auth, row.employeeId);

    return reply.send({ data: await loanDetailFor(auth, row.id) });
  });

  /**
   * The deduction month rule, as the server will apply it.
   *
   * The request form reads its default from here instead of the browser's own
   * clock, so the month an employee sees is the month the server stores.
   */
  app.get('/deduction-month', async (request, reply) => {
    const auth = requireAuthContext(request);
    return reply.send({ data: await deductionMonthInfo(auth.companyId) });
  });

  /** An administrator recording a loan that has already been agreed. */
  app.post(
    '/',
    { preHandler: requirePermission(PERMISSIONS.LOAN_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(loanCreateSchema, request.body);

      await assertEmployeeInScope(auth, input.employeeId);

      const [employee, company] = await Promise.all([
        prisma.employee.findFirst({
          where: { id: input.employeeId, companyId: auth.companyId },
          select: { id: true, firstName: true, lastName: true, displayName: true },
        }),
        prisma.company.findUniqueOrThrow({
          where: { id: auth.companyId },
          select: { currency: true },
        }),
      ]);
      if (!employee) throw new ValidationError({ employeeId: ['That employee does not exist.'] });

      await assertNoActiveLoan(input.employeeId, input.kind);

      if (input.alreadyRepaidInstallments > 0) {
        if (!canCorrectLoans(auth.permissions)) {
          throw new ForbiddenError(
            'Recording repayments made before a loan was entered needs both loan and payroll management permissions.',
          );
        }
        if (!input.activate) {
          throw new ValidationError({
            alreadyRepaidInstallments: ['Earlier repayments can only be recorded on a loan that is released.'],
          });
        }
      }

      /*
       * The same gate, with the override an authorised user is allowed.
       *
       * Creating a loan for somebody is the route HR uses to grant one the
       * rules would refuse - a hardship case, a board decision - so the
       * refusal is offered as something to override rather than a wall. What
       * it is not is a way around the rules by accident: without an
       * `overrideReason` in the body there is no override, and the application
       * is refused exactly as the employee's own would be.
       */
      await assertLoanAllowed({
        companyId: auth.companyId,
        employeeId: input.employeeId,
        principalAmount: input.principalAmount,
        installmentCount: input.installmentCount,
        kind: input.kind,
        override:
          input.overrideReason === undefined
            ? null
            : { by: auth.userId, reason: input.overrideReason ?? null, request },
      });

      const currency = input.currency ?? company.currency;
      const now = new Date();

      const created = await prisma.$transaction(async (tx) => {
        const loan = await tx.employeeLoan.create({
          data: {
            companyId: auth.companyId,
            employeeId: input.employeeId,
            kind: input.kind,
            reference: input.reference,
            principalAmount: input.principalAmount,
            currency,
            installmentCount: input.installmentCount,
            monthlyDeduction: monthlyDeductionFor(input.principalAmount, input.installmentCount),
            startMonth: toMonthStart(input.startMonth),
            // An administrator creating a loan directly has already made the
            // decision, so it is approved on the spot. Whether it is released
            // is still a separate choice.
            status: input.activate ? 'ACTIVE' : 'APPROVED',
            purpose: input.purpose,
            notes: input.notes,
            approvedByUserId: auth.userId,
            approvedAt: now,
            activatedAt: input.activate ? now : null,
            createdBy: auth.userId,
          },
        });

        // The schedule is written up front, so "what is left?" is a sum over
        // rows from the first day rather than a figure somebody maintains.
        await tx.employeeLoanInstallment.createMany({
          data: scheduleRows({
            companyId: auth.companyId,
            loanId: loan.id,
            employeeId: input.employeeId,
            principal: input.principalAmount,
            installmentCount: input.installmentCount,
            startMonth: input.startMonth,
          }),
        });

        // A loan entered after the fact, with months already repaid: settle
        // them now, inside the same transaction, so no payroll run ever sees
        // them as owed.
        if (input.alreadyRepaidInstallments > 0) {
          await settleHistoricalInstallments(tx, {
            companyId: auth.companyId,
            loanId: loan.id,
            count: input.alreadyRepaidInstallments,
            reason: input.alreadyRepaidReason ?? 'Repaid before it was entered in HRMS.',
            actorId: auth.userId,
          });
        }

        return loan;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.create',
        entityType: 'EmployeeLoan',
        entityId: created.id,
        summary:
          input.kind === 'SALARY_ADVANCE'
            ? `Created a ${currency} ${input.principalAmount} salary advance for ${employeeLabel(employee)}, recovered from ${input.startMonth}`
            : `Created a ${currency} ${input.principalAmount} loan for ${employeeLabel(employee)} over ${input.installmentCount} installment(s) from ${input.startMonth}`,
        after: {
          kind: input.kind,
          principalAmount: input.principalAmount,
          installmentCount: input.installmentCount,
          startMonth: input.startMonth,
          status: created.status,
          alreadyRepaidInstallments: input.alreadyRepaidInstallments,
          alreadyRepaidReason: input.alreadyRepaidReason ?? null,
        },
        request,
      });

      return reply.status(201).send({ data: await loanDetailFor(auth, created.id) });
    },
  );

  /**
   * An employee applying for a loan.
   *
   * Mirrors the leave request path deliberately, down to the ordering: the
   * approver chain is resolved and checked BEFORE anything is written, so an
   * employee with no manager gets a clean rejection rather than a PENDING loan
   * nobody can decide on.
   */
  app.post(
    '/apply',
    { preHandler: requirePermission(PERMISSIONS.LOAN_REQUEST) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(loanApplicationSchema, request.body);

      const self = await callerEmployeeOrThrow(auth);
      await assertNoActiveLoan(self.id, input.kind);

      /*
       * The policy gate.
       *
       * No override is offered here and none can be passed: this is the
       * employee's own application, and an employee allowing themselves past
       * the rules is not an override, it is the absence of a rule. An
       * authorised user who wants to make an exception does it through
       * `POST /loans`, where the decision carries their name.
       */
      await assertLoanAllowed({
        companyId: auth.companyId,
        employeeId: self.id,
        principalAmount: input.principalAmount,
        installmentCount: input.installmentCount,
        kind: input.kind,
      });

      const company = await prisma.company.findUniqueOrThrow({
        where: { id: auth.companyId },
        select: { currency: true },
      });

      // The deduction month, by the company rule - the one asked for if it is
      // allowed, the default if none was asked for. Stored on the loan and
      // its schedule; payroll reads the schedule and nothing else.
      const startMonth = await resolveRequestedDeductionMonth(
        auth.companyId,
        input.startMonth,
        prisma,
        new Date(),
        input.kind,
      );

      const chain = await resolveChain(auth.companyId, 'LOAN_REQUEST', self.id);
      assertChainUsable(chain, self.id);

      const monthly = monthlyDeductionFor(input.principalAmount, input.installmentCount);

      const { created, approval } = await prisma.$transaction(async (tx) => {
        const loan = await tx.employeeLoan.create({
          data: {
            companyId: auth.companyId,
            employeeId: self.id,
            kind: input.kind,
            principalAmount: input.principalAmount,
            currency: company.currency,
            installmentCount: input.installmentCount,
            monthlyDeduction: monthly,
            startMonth: toMonthStart(startMonth),
            status: 'PENDING',
            purpose: input.purpose,
            notes: input.notes,
            requestedByUserId: auth.userId,
            requestedAt: new Date(),
            createdBy: auth.userId,
          },
        });

        // Written now so the applicant can see exactly what they would repay
        // and when, while the application is still pending. Nothing collects
        // against it until the loan is ACTIVE.
        await tx.employeeLoanInstallment.createMany({
          data: scheduleRows({
            companyId: auth.companyId,
            loanId: loan.id,
            employeeId: self.id,
            principal: input.principalAmount,
            installmentCount: input.installmentCount,
            startMonth,
          }),
        });

        const approval = await createApprovalRequest({
          companyId: auth.companyId,
          subjectType: 'LOAN_REQUEST',
          subjectId: loan.id,
          requesterEmployeeId: self.id,
          requesterUserId: auth.userId,
          title:
            input.kind === 'SALARY_ADVANCE'
              ? `Salary advance: ${company.currency} ${input.principalAmount}, recovered from ${startMonth} pay`
              : `Loan: ${company.currency} ${input.principalAmount} over ${input.installmentCount} month${input.installmentCount === 1 ? '' : 's'}, from ${startMonth}`,
          summary: input.purpose,
          chain,
          request,
          client: tx,
          deferAudit: true,
        });

        await tx.employeeLoan.update({
          where: { id: loan.id },
          data: { approvalRequestId: approval.id },
        });

        return { created: loan, approval };
      });

      // Requested in a month whose payroll is already finalized: kept, and
      // flagged for Payroll's decision rather than moved.
      const awaitingDecision = await advanceAwaitingDecision(prisma, {
        companyId: auth.companyId,
        loanId: created.id,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.submit',
        entityType: 'ApprovalRequest',
        entityId: approval.id,
        summary: `Submitted for approval: ${nounFor(input.kind)} of ${company.currency} ${input.principalAmount}`,
        after: { subjectType: 'LOAN_REQUEST', subjectId: created.id, steps: chain.stages.length },
        request,
      });
      await notifyApprover(approval.id, 1, request);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.apply',
        entityType: 'EmployeeLoan',
        entityId: created.id,
        summary:
          input.kind === 'SALARY_ADVANCE'
            ? `Applied for a ${company.currency} ${input.principalAmount} salary advance`
            : `Applied for a ${company.currency} ${input.principalAmount} loan over ${input.installmentCount} installment(s)`,
        after: {
          kind: input.kind,
          principalAmount: input.principalAmount,
          installmentCount: input.installmentCount,
          startMonth,
          requestedStartMonth: input.startMonth ?? null,
          deductionDecisionMonth: awaitingDecision,
        },
        request,
      });

      return reply.status(201).send({
        data: {
          id: created.id,
          approvalRequestId: approval.id,
          monthlyDeduction: monthly,
          startMonth,
          deductionDecisionMonth: awaitingDecision,
        },
      });
    },
  );

  /**
   * Approve an application directly.
   *
   * The same decision an approver can make from the Approvals screen, offered
   * here so an HR administrator who is not in the chain can act on it. The
   * terms may be changed while approving - a loan agreed at a different amount
   * is still the same application - and the schedule is rebuilt when they are.
   */
  app.post(
    '/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.LOAN_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(loanDecisionSchema, request.body ?? {});

      const loan = await prisma.employeeLoan.findFirst({
        where: { id, companyId: auth.companyId },
        include: LOAN_INCLUDE,
      });
      if (!loan) throw new NotFoundError('Loan');

      await assertEmployeeInScope(auth, loan.employeeId);

      if (loan.status !== 'PENDING') {
        throw new ConflictError(`That loan is already ${loan.status.toLowerCase()}.`);
      }

      const self = await prisma.employee.findFirst({
        where: { companyId: auth.companyId, userId: auth.userId },
        select: { id: true },
      });
      if (self && self.id === loan.employeeId) {
        throw new ForbiddenError('A loan cannot be approved by the person who applied for it.');
      }

      const principal = input.principalAmount ?? toNumber(loan.principalAmount);
      const installments = input.installmentCount ?? loan.installmentCount;
      if (loan.kind === 'SALARY_ADVANCE' && installments !== SALARY_ADVANCE_INSTALLMENTS) {
        throw new ValidationError({
          installmentCount: ['A salary advance is recovered in full from a single month.'],
        });
      }
      const requestedStart = input.startMonth?.slice(0, 7);
      const storedStart = day(loan.startMonth)!.slice(0, 7);
      // A month the approver changes is held to the same rule as the
      // applicant's; the month already on the request is carried forward
      // below if its payroll has closed since.
      const startMonth =
        requestedStart && requestedStart !== storedStart
          ? await resolveRequestedDeductionMonth(
              auth.companyId,
              requestedStart,
              prisma,
              new Date(),
              loan.kind,
            )
          : storedStart;
      const retermed =
        principal !== toNumber(loan.principalAmount) ||
        installments !== loan.installmentCount ||
        startMonth !== storedStart;

      const now = new Date();

      const carried = await prisma.$transaction(async (tx) => {
        if (retermed) {
          // Nothing has been collected yet - the loan was PENDING - so the
          // whole schedule is replaced rather than patched.
          await tx.employeeLoanInstallment.deleteMany({ where: { loanId: loan.id } });
          await tx.employeeLoanInstallment.createMany({
            data: scheduleRows({
              companyId: auth.companyId,
              loanId: loan.id,
              employeeId: loan.employeeId,
              principal,
              installmentCount: installments,
              startMonth,
            }),
          });
        }

        await tx.employeeLoan.update({
          where: { id: loan.id },
          data: {
            status: input.activate ? 'ACTIVE' : 'APPROVED',
            principalAmount: principal,
            installmentCount: installments,
            monthlyDeduction: monthlyDeductionFor(principal, installments),
            startMonth: toMonthStart(startMonth),
            approvedByUserId: auth.userId,
            approvedAt: now,
            activatedAt: input.activate ? now : null,
            ...(input.note ? { notes: input.note } : {}),
          },
        });

        return carryForwardPastClosedMonths(tx, {
          companyId: auth.companyId,
          loanId: loan.id,
          actorId: auth.userId,
        });
      });
      const awaitingDecision = await advanceAwaitingDecision(prisma, {
        companyId: auth.companyId,
        loanId: loan.id,
      });

      // Mirror the decision into the approval record so the Approvals screen
      // and the loan never disagree about what happened.
      if (loan.approvalRequestId) {
        await prisma.approvalRequest.updateMany({
          where: { id: loan.approvalRequestId, status: 'PENDING' },
          data: { status: 'APPROVED', decidedAt: now, decidedByUserId: auth.userId },
        });
        await prisma.approvalStep.updateMany({
          where: { approvalRequestId: loan.approvalRequestId, status: 'PENDING' },
          data: { status: 'APPROVED', decidedAt: now, decidedByUserId: auth.userId },
        });
        await prisma.approvalEvent.create({
          data: {
            approvalRequestId: loan.approvalRequestId,
            actorUserId: auth.userId,
            action: 'APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            comment: input.note ?? 'Approved from the loans screen.',
          },
        });
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.approve',
        entityType: 'EmployeeLoan',
        entityId: loan.id,
        summary: `Approved a ${loan.currency} ${principal} ${nounFor(loan.kind)} for ${employeeLabel(loan.employee)}${input.activate ? ' and released it' : ''}${retermed ? ' on revised terms' : ''}`,
        before: {
          principalAmount: toNumber(loan.principalAmount),
          installmentCount: loan.installmentCount,
          startMonth: day(loan.startMonth),
        },
        after: {
          principalAmount: principal,
          installmentCount: installments,
          startMonth: carried?.to ?? startMonth,
          status: input.activate ? 'ACTIVE' : 'APPROVED',
          carriedForwardFrom: carried?.from ?? null,
          deductionDecisionMonth: awaitingDecision,
        },
        request,
      });

      const deductionMonth = carried?.to ?? startMonth;
      await notifyLoanHolder(
        request,
        loan,
        input.activate
          ? `Your ${nounFor(loan.kind)} was approved and released`
          : `Your ${nounFor(loan.kind)} was approved`,
        `${loan.currency} ${principal}${retermed ? ', on revised terms' : ''}. ${loan.kind === 'SALARY_ADVANCE' ? 'Recovered from' : 'Deductions start with'} the ${deductionMonth} payslip${carried ? ` (moved from ${carried.from}, whose payroll was already finalized)` : ''}.${awaitingDecision ? awaitingDecisionNote(awaitingDecision) : ''}${input.activate ? '' : ' It will be released before payroll starts recovering it.'}`,
      );

      return reply.send({ data: await loanDetailFor(auth, loan.id) });
    },
  );

  app.post(
    '/:id/reject',
    { preHandler: requirePermission(PERMISSIONS.LOAN_APPROVE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const input = parseOrThrow(loanRejectSchema, request.body);

      const loan = await prisma.employeeLoan.findFirst({
        where: { id, companyId: auth.companyId },
        include: LOAN_INCLUDE,
      });
      if (!loan) throw new NotFoundError('Loan');

      await assertEmployeeInScope(auth, loan.employeeId);
      if (loan.status !== 'PENDING') {
        throw new ConflictError(`That loan is already ${loan.status.toLowerCase()}.`);
      }

      const now = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.employeeLoan.update({
          where: { id: loan.id },
          data: { status: 'REJECTED', rejectedAt: now, rejectionReason: input.reason },
        });
        // The schedule described a repayment that will never happen. Marking
        // the rows rather than deleting them keeps the application legible.
        await tx.employeeLoanInstallment.updateMany({
          where: { loanId: loan.id, status: 'SCHEDULED' },
          data: { status: 'SKIPPED', note: 'Loan was declined.' },
        });
      });

      if (loan.approvalRequestId) {
        await prisma.approvalRequest.updateMany({
          where: { id: loan.approvalRequestId, status: 'PENDING' },
          data: { status: 'REJECTED', decidedAt: now, decidedByUserId: auth.userId },
        });
        await prisma.approvalStep.updateMany({
          where: { approvalRequestId: loan.approvalRequestId, status: 'PENDING' },
          data: { status: 'REJECTED', decidedAt: now, decidedByUserId: auth.userId },
        });
        await prisma.approvalEvent.create({
          data: {
            approvalRequestId: loan.approvalRequestId,
            actorUserId: auth.userId,
            action: 'REJECT',
            fromStatus: 'PENDING',
            toStatus: 'REJECTED',
            comment: input.reason,
          },
        });
      }

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.reject',
        entityType: 'EmployeeLoan',
        entityId: loan.id,
        summary: `Declined the ${nounFor(loan.kind)} for ${employeeLabel(loan.employee)} - ${input.reason}`,
        request,
      });

      await notifyLoanHolder(
        request,
        loan,
        `Your ${nounFor(loan.kind)} request was declined`,
        input.reason,
      );

      return reply.send({ data: { id: loan.id, status: 'REJECTED' } });
    },
  );

  /** Release an approved loan so payroll starts collecting it. */
  app.post(
    '/:id/activate',
    { preHandler: requirePermission(PERMISSIONS.LOAN_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);

      const loan = await prisma.employeeLoan.findFirst({
        where: { id, companyId: auth.companyId },
        include: LOAN_INCLUDE,
      });
      if (!loan) throw new NotFoundError('Loan');

      await assertEmployeeInScope(auth, loan.employeeId);
      if (loan.status !== 'APPROVED') {
        throw new ConflictError(
          loan.status === 'ACTIVE'
            ? 'That loan is already active.'
            : `A loan in ${loan.status.toLowerCase()} cannot be released.`,
        );
      }

      // Released after the deduction month's payroll was finalized: the
      // schedule is carried forward to the first open month, on the record,
      // rather than left owed to a payroll that can no longer collect it.
      const carried = await prisma.$transaction(async (tx) => {
        await tx.employeeLoan.update({
          where: { id: loan.id },
          data: { status: 'ACTIVE', activatedAt: new Date() },
        });
        return carryForwardPastClosedMonths(tx, {
          companyId: auth.companyId,
          loanId: loan.id,
          actorId: auth.userId,
        });
      });
      const deductionMonth = carried?.to ?? day(loan.startMonth)!.slice(0, 7);
      const awaitingDecision = await advanceAwaitingDecision(prisma, {
        companyId: auth.companyId,
        loanId: loan.id,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.activate',
        entityType: 'EmployeeLoan',
        entityId: loan.id,
        summary: `Released the ${nounFor(loan.kind)} for ${employeeLabel(loan.employee)}; ${loan.kind === 'SALARY_ADVANCE' ? 'recovered from' : 'repayment starts'} ${deductionMonth}${carried ? ` (carried forward from ${carried.from}, already finalized)` : ''}`,
        after: {
          status: 'ACTIVE',
          startMonth: deductionMonth,
          carriedForwardFrom: carried?.from ?? null,
          deductionDecisionMonth: awaitingDecision,
        },
        request,
      });

      await notifyLoanHolder(
        request,
        loan,
        `Your ${nounFor(loan.kind)} has been released`,
        `${loan.currency} ${toNumber(loan.principalAmount)} - ${loan.kind === 'SALARY_ADVANCE' ? 'recovered in full from' : 'repayments start with'} the ${deductionMonth} payslip.${awaitingDecision ? awaitingDecisionNote(awaitingDecision) : ''}`,
      );

      return reply.send({ data: await loanDetailFor(auth, loan.id) });
    },
  );

  /**
   * Withdraw an application, or write off a live loan.
   *
   * Installments already collected are left exactly as they are: cancelling a
   * loan stops future deductions, it does not refund the past.
   */
  app.post('/:id/cancel', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(loanCancelSchema, request.body ?? {});

    const loan = await prisma.employeeLoan.findFirst({
      where: { id, companyId: auth.companyId },
      include: LOAN_INCLUDE,
    });
    if (!loan) throw new NotFoundError('Loan');

    const caller = await callerContext(auth);
    const isOwner = caller.employeeId !== null && caller.employeeId === loan.employeeId;

    if (loan.status === 'PENDING') {
      if (!isOwner && !caller.canManage) {
        throw new ForbiddenError('Only the applicant or a loan administrator can withdraw this.');
      }
    } else if (loan.status === 'APPROVED' || loan.status === 'ACTIVE') {
      if (!caller.canManage) {
        throw new ForbiddenError('Only a loan administrator can cancel a loan that has been agreed.');
      }
    } else {
      throw new ConflictError(`A loan in ${loan.status.toLowerCase()} cannot be cancelled.`);
    }

    await assertEmployeeInScope(auth, loan.employeeId);

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.employeeLoan.update({
        where: { id: loan.id },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      // Only what has not been collected. A PENDING_PAYROLL row belongs to a
      // run in flight and is released by that run, not from here.
      await tx.employeeLoanInstallment.updateMany({
        where: { loanId: loan.id, status: 'SCHEDULED' },
        data: { status: 'SKIPPED', note: input.reason ?? 'Loan cancelled.' },
      });
    });

    if (loan.approvalRequestId && loan.status === 'PENDING') {
      await cancelApproval(auth, loan.approvalRequestId, input.reason ?? null, request);
    }

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'loan.cancel',
      entityType: 'EmployeeLoan',
      entityId: loan.id,
      summary: `Cancelled the ${nounFor(loan.kind)} for ${employeeLabel(loan.employee)}${input.reason ? ` - ${input.reason}` : ''}`,
      before: { status: loan.status },
      after: { status: 'CANCELLED' },
      request,
    });

    return reply.send({ data: { id: loan.id, status: 'CANCELLED' } });
  });

  const installmentParams = z.object({ id: z.string().min(1), installmentId: z.string().min(1) });

  /** The loan an installment belongs to, scoped, or a 404. */
  async function scopedLoan(
    auth: Parameters<typeof assertEmployeeInScope>[0] & { companyId: string },
    loanId: string,
  ) {
    const loan = await prisma.employeeLoan.findFirst({
      where: { id: loanId, companyId: auth.companyId },
      include: { employee: { select: { firstName: true, lastName: true, displayName: true } } },
    });
    if (!loan) throw new NotFoundError('Loan');
    await assertEmployeeInScope(auth, loan.employeeId);
    return loan;
  }

  /**
   * Forgive one installment without ending the loan.
   *
   * Waived counts as settled: it is no longer owed and it is not collected. It
   * is not a payment, and is never shown as Paid. Deliberate by construction:
   * a reason is required, and it goes on the ledger and the audit trail.
   */
  app.post(
    '/:id/installments/:installmentId/waive',
    { preHandler: requirePermission(PERMISSIONS.LOAN_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = parseOrThrow(installmentParams, request.params);
      const body = parseOrThrow(loanWaiveSchema, request.body ?? {});

      await scopedLoan(auth, params.id);
      const result = await waiveInstallment({
        companyId: auth.companyId,
        loanId: params.id,
        installmentId: params.installmentId,
        reason: body.reason,
        actorId: auth.userId,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.installment.waive',
        entityType: 'EmployeeLoanInstallment',
        entityId: result.installmentId,
        summary: `Waived installment ${result.sequence} of ${result.amount} - ${body.reason}${result.loanCompleted ? '; the loan is now complete' : ''}`,
        before: { status: 'SCHEDULED' },
        after: { status: 'WAIVED', reason: body.reason },
        request,
      });

      return reply.send({
        data: { id: result.installmentId, status: 'WAIVED', loanCompleted: result.loanCompleted },
      });
    },
  );

  /**
   * Record an installment repaid outside payroll.
   *
   * The correction for a loan entered with months that were in fact already
   * repaid - and for any cash or transfer repayment. Writes a MANUAL_PAYMENT
   * to the ledger and settles the installment, so payroll will not collect it.
   */
  app.post(
    '/:id/installments/:installmentId/record-payment',
    { preHandler: [requirePermission(PERMISSIONS.LOAN_MANAGE), requireLoanCorrector()] },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = parseOrThrow(installmentParams, request.params);
      const body = parseOrThrow(loanRecordPaymentSchema, request.body ?? {});

      const loan = await scopedLoan(auth, params.id);
      const before = await prisma.employeeLoanInstallment.findFirst({
        where: { id: params.installmentId, loanId: loan.id },
        select: { sequence: true, amount: true, status: true, dueMonth: true, payrollRunId: true },
      });

      const result = await recordManualPayment({
        companyId: auth.companyId,
        loanId: loan.id,
        installmentId: params.installmentId,
        paidOn: body.paidOn,
        reference: body.reference,
        reason: body.reason,
        actorId: auth.userId,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.installment.record_payment',
        entityType: 'EmployeeLoanInstallment',
        entityId: result.installmentId,
        summary: `Recorded installment ${before?.sequence ?? '?'} of ${employeeLabel(loan.employee)}'s ${nounFor(loan.kind)} as repaid outside payroll on ${body.paidOn} - ${body.reason}${result.releasedFromRunId ? '; taken back from an unfinalized payroll run, which must be recalculated' : ''}`,
        before: before
          ? {
              status: before.status,
              dueMonth: day(before.dueMonth),
              amount: toNumber(before.amount),
              payrollRunId: before.payrollRunId,
            }
          : undefined,
        after: {
          status: 'PAID',
          paidOn: body.paidOn,
          reference: body.reference,
          reason: body.reason,
          releasedFromRunId: result.releasedFromRunId,
        },
        request,
      });

      return reply.send({
        data: {
          id: result.installmentId,
          loanCompleted: result.loanCompleted,
          runNeedsRecalculation: result.releasedFromRunId,
          loan: await loanDetailFor(auth, loan.id),
        },
      });
    },
  );

  /** Take back a manual payment recorded in error. The original entry stays. */
  app.post(
    '/:id/installments/:installmentId/reverse-payment',
    { preHandler: [requirePermission(PERMISSIONS.LOAN_MANAGE), requireLoanCorrector()] },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = parseOrThrow(installmentParams, request.params);
      const body = parseOrThrow(loanReversePaymentSchema, request.body ?? {});

      const loan = await scopedLoan(auth, params.id);
      const result = await reverseManualPayment({
        companyId: auth.companyId,
        loanId: loan.id,
        installmentId: params.installmentId,
        reason: body.reason,
        actorId: auth.userId,
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.installment.reverse_payment',
        entityType: 'EmployeeLoanInstallment',
        entityId: result.installmentId,
        summary: `Reversed a manual repayment on ${employeeLabel(loan.employee)}'s ${nounFor(loan.kind)} - ${body.reason}${result.loanReopened ? '; the loan is open again' : ''}`,
        before: { status: 'PAID' },
        after: { status: 'SCHEDULED', reason: body.reason, loanReopened: result.loanReopened },
        request,
      });

      return reply.send({ data: { id: result.installmentId, loan: await loanDetailFor(auth, loan.id) } });
    },
  );

  /**
   * Move the remaining schedule to start in another month.
   *
   * How a deduction month is changed after the request: recorded with the
   * reason, never into a month whose payroll is finalized, and the employee is
   * told the new month.
   */
  app.post(
    '/:id/reschedule',
    { preHandler: [requirePermission(PERMISSIONS.LOAN_MANAGE), requireLoanCorrector()] },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const { id } = parseOrThrow(idParamSchema, request.params);
      const body = parseOrThrow(loanRescheduleSchema, request.body ?? {});

      const loan = await scopedLoan(auth, id);
      const { moves } = await rescheduleLoan({
        companyId: auth.companyId,
        loanId: loan.id,
        startMonth: body.startMonth,
        reason: body.reason,
        actorId: auth.userId,
      });

      if (moves.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'loan.reschedule',
          entityType: 'EmployeeLoan',
          entityId: loan.id,
          summary: `Moved ${moves.length} installment(s) of ${employeeLabel(loan.employee)}'s ${nounFor(loan.kind)} to start ${body.startMonth.slice(0, 7)} - ${body.reason}`,
          before: { months: moves.map((m) => ({ sequence: m.sequence, dueMonth: m.from })) },
          after: { months: moves.map((m) => ({ sequence: m.sequence, dueMonth: m.to })), reason: body.reason },
          request,
        });
        await notifyLoanHolder(
          request,
          loan,
          `Your ${nounFor(loan.kind)} deduction month changed`,
          `${loan.kind === 'SALARY_ADVANCE' ? 'Now recovered from' : 'Deductions now start with'} the ${moves[0]!.to} payslip, instead of ${moves[0]!.from}. ${body.reason}`,
        );
      }

      return reply.send({ data: { moved: moves.length, loan: await loanDetailFor(auth, loan.id) } });
    },
  );
};

/**
 * Applies an approval decision made through the generic approvals screen.
 *
 * Called by the approval engine, which knows nothing about loans. Approving
 * moves the loan to APPROVED and no further: releasing the money is a separate
 * act, so an approver clicking Approve never starts a deduction on its own.
 */
export async function applyLoanDecision(
  loanId: string,
  status: 'APPROVED' | 'REJECTED' | 'CANCELLED',
): Promise<void> {
  const loan = await prisma.employeeLoan.findUnique({
    where: { id: loanId },
    select: { id: true, status: true, approvalRequestId: true },
  });
  if (!loan || loan.status !== 'PENDING') return;

  const now = new Date();

  if (status === 'APPROVED') {
    // Who decided is read off the approval record rather than passed in, so
    // the approval engine keeps knowing nothing about loans.
    const approval = loan.approvalRequestId
      ? await prisma.approvalRequest.findUnique({
          where: { id: loan.approvalRequestId },
          select: { decidedByUserId: true },
        })
      : null;

    await prisma.$transaction(async (tx) => {
      const updated = await tx.employeeLoan.update({
        where: { id: loanId },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          approvedByUserId: approval?.decidedByUserId ?? null,
        },
        select: { companyId: true },
      });
      // Approved after the requested month's payroll closed: carried forward,
      // on the ledger, so the approval record shows the month it will really
      // come off.
      await carryForwardPastClosedMonths(tx, {
        companyId: updated.companyId,
        loanId,
        actorId: approval?.decidedByUserId ?? null,
      });
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.employeeLoan.update({
      where: { id: loanId },
      data:
        status === 'REJECTED'
          ? { status: 'REJECTED', rejectedAt: now }
          : { status: 'CANCELLED', cancelledAt: now },
    });
    await tx.employeeLoanInstallment.updateMany({
      where: { loanId, status: 'SCHEDULED' },
      data: {
        status: 'SKIPPED',
        note: status === 'REJECTED' ? 'Loan was declined.' : 'Loan application was withdrawn.',
      },
    });
  });
}
