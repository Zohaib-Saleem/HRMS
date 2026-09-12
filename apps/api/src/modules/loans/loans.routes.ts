import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PERMISSIONS,
  idParamSchema,
  loanApplicationSchema,
  loanCancelSchema,
  loanCreateSchema,
  loanDecisionSchema,
  loanQuerySchema,
  loanRejectSchema,
  monthlyDeductionFor,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { buildMeta, toSkipTake } from '../../core/pagination.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuthContext, requirePermission } from '../../auth/guards.js';
import { assertEmployeeInScope, employeeScopeFilter } from '../../auth/scope.js';
import {
  assertApproverChainUsable,
  cancel as cancelApproval,
  createApprovalRequest,
  notifyApprover,
  resolveDefaultApprovers,
} from '../../core/approvals/approval.service.js';
import { callerEmployeeOrThrow } from '../time/helpers.js';
import { evaluateLoanEligibility } from './loan-eligibility.service.js';
import { currentLoanPolicy } from './loan-policy.service.js';
import {
  LOAN_INCLUDE,
  completeIfSettled,
  day,
  scheduleRows,
  toLoanDetail,
  toLoanRecord,
  toMonthStart,
  toNumber,
} from './loans.service.js';

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
  };
}

/** Rejects a schedule that would clash with a loan the employee is still repaying. */
async function assertNoActiveLoan(employeeId: string, excludeLoanId?: string): Promise<void> {
  const existing = await prisma.employeeLoan.findFirst({
    where: {
      employeeId,
      status: { in: ['PENDING', 'APPROVED', 'ACTIVE'] },
      ...(excludeLoanId ? { NOT: { id: excludeLoanId } } : {}),
    },
    select: { id: true, status: true },
  });

  if (existing) {
    throw new ValidationError({
      principalAmount: [
        `That employee already has a loan in ${existing.status.toLowerCase()}. Settle or cancel it before starting another.`,
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
  override?: { by: string; reason: string | null; request: FastifyRequest } | null;
}): Promise<void> {
  const result = await evaluateLoanEligibility({
    companyId: input.companyId,
    employeeId: input.employeeId,
    requestedAmount: input.principalAmount,
    requestedInstallments: input.installmentCount,
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
    const [total, rows] = await Promise.all([
      prisma.employeeLoan.count({ where }),
      prisma.employeeLoan.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }],
        include: LOAN_INCLUDE,
      }),
    ]);

    return reply.send({
      data: rows.map((row) => toLoanRecord(row, caller)),
      meta: buildMeta(query.page, query.limit, total),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const row = await prisma.employeeLoan.findFirst({
      where: { id, companyId: auth.companyId },
      include: LOAN_INCLUDE,
    });
    if (!row) throw new NotFoundError('Loan');

    await assertEmployeeInScope(auth, row.employeeId);

    return reply.send({ data: toLoanDetail(row, await callerContext(auth)) });
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

      await assertNoActiveLoan(input.employeeId);

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

        return loan;
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.create',
        entityType: 'EmployeeLoan',
        entityId: created.id,
        summary: `Created a ${currency} ${input.principalAmount} loan for ${employeeLabel(employee)} over ${input.installmentCount} installment(s) from ${input.startMonth}`,
        after: {
          principalAmount: input.principalAmount,
          installmentCount: input.installmentCount,
          startMonth: input.startMonth,
          status: created.status,
        },
        request,
      });

      const full = await prisma.employeeLoan.findUniqueOrThrow({
        where: { id: created.id },
        include: LOAN_INCLUDE,
      });

      return reply.status(201).send({ data: toLoanDetail(full, await callerContext(auth)) });
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
      await assertNoActiveLoan(self.id);

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
      });

      const company = await prisma.company.findUniqueOrThrow({
        where: { id: auth.companyId },
        select: { currency: true },
      });

      const approvers = await resolveDefaultApprovers(auth.companyId, self.id);
      assertApproverChainUsable(approvers, self.id);

      const monthly = monthlyDeductionFor(input.principalAmount, input.installmentCount);

      const { created, approval } = await prisma.$transaction(async (tx) => {
        const loan = await tx.employeeLoan.create({
          data: {
            companyId: auth.companyId,
            employeeId: self.id,
            principalAmount: input.principalAmount,
            currency: company.currency,
            installmentCount: input.installmentCount,
            monthlyDeduction: monthly,
            startMonth: toMonthStart(input.startMonth),
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
            startMonth: input.startMonth,
          }),
        });

        const approval = await createApprovalRequest({
          companyId: auth.companyId,
          subjectType: 'LOAN_REQUEST',
          subjectId: loan.id,
          requesterEmployeeId: self.id,
          requesterUserId: auth.userId,
          title: `Loan: ${company.currency} ${input.principalAmount} over ${input.installmentCount} month${input.installmentCount === 1 ? '' : 's'}`,
          summary: input.purpose,
          approverEmployeeIds: approvers,
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

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'approval.submit',
        entityType: 'ApprovalRequest',
        entityId: approval.id,
        summary: `Submitted for approval: loan of ${company.currency} ${input.principalAmount}`,
        after: { subjectType: 'LOAN_REQUEST', subjectId: created.id, steps: approvers.length },
        request,
      });
      await notifyApprover(approval.id, 1, request);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.apply',
        entityType: 'EmployeeLoan',
        entityId: created.id,
        summary: `Applied for a ${company.currency} ${input.principalAmount} loan over ${input.installmentCount} installment(s)`,
        after: {
          principalAmount: input.principalAmount,
          installmentCount: input.installmentCount,
          startMonth: input.startMonth,
        },
        request,
      });

      return reply.status(201).send({
        data: { id: created.id, approvalRequestId: approval.id, monthlyDeduction: monthly },
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
      const startMonth = input.startMonth ?? day(loan.startMonth)!;
      const retermed =
        principal !== toNumber(loan.principalAmount) ||
        installments !== loan.installmentCount ||
        startMonth !== day(loan.startMonth);

      const now = new Date();

      await prisma.$transaction(async (tx) => {
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
        summary: `Approved a ${loan.currency} ${principal} loan for ${employeeLabel(loan.employee)}${input.activate ? ' and released it' : ''}${retermed ? ' on revised terms' : ''}`,
        before: {
          principalAmount: toNumber(loan.principalAmount),
          installmentCount: loan.installmentCount,
          startMonth: day(loan.startMonth),
        },
        after: {
          principalAmount: principal,
          installmentCount: installments,
          startMonth,
          status: input.activate ? 'ACTIVE' : 'APPROVED',
        },
        request,
      });

      const updated = await prisma.employeeLoan.findUniqueOrThrow({
        where: { id: loan.id },
        include: LOAN_INCLUDE,
      });
      return reply.send({ data: toLoanDetail(updated, await callerContext(auth)) });
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
        summary: `Declined the loan for ${employeeLabel(loan.employee)} - ${input.reason}`,
        request,
      });

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

      await prisma.employeeLoan.update({
        where: { id: loan.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.activate',
        entityType: 'EmployeeLoan',
        entityId: loan.id,
        summary: `Released the loan for ${employeeLabel(loan.employee)}; repayment starts ${day(loan.startMonth)}`,
        request,
      });

      const updated = await prisma.employeeLoan.findUniqueOrThrow({
        where: { id: loan.id },
        include: LOAN_INCLUDE,
      });
      return reply.send({ data: toLoanDetail(updated, await callerContext(auth)) });
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
      summary: `Cancelled the loan for ${employeeLabel(loan.employee)}${input.reason ? ` - ${input.reason}` : ''}`,
      before: { status: loan.status },
      after: { status: 'CANCELLED' },
      request,
    });

    return reply.send({ data: { id: loan.id, status: 'CANCELLED' } });
  });

  /**
   * Forgive one installment without ending the loan.
   *
   * Waived counts as settled: it is no longer owed and it is not collected.
   * That is why the balance treats it alongside PAID rather than pretending
   * the money is still coming.
   */
  app.post(
    '/:id/installments/:installmentId/waive',
    { preHandler: requirePermission(PERMISSIONS.LOAN_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const params = parseOrThrow(
        z.object({ id: z.string().min(1), installmentId: z.string().min(1) }),
        request.params,
      );
      const body = parseOrThrow(
        z.object({ note: z.string().trim().max(500).optional() }),
        request.body ?? {},
      );

      const installment = await prisma.employeeLoanInstallment.findFirst({
        where: {
          id: params.installmentId,
          loanId: params.id,
          companyId: auth.companyId,
        },
        include: { loan: { select: { employeeId: true, status: true } } },
      });
      if (!installment) throw new NotFoundError('Installment');

      await assertEmployeeInScope(auth, installment.loan.employeeId);

      if (installment.status !== 'SCHEDULED') {
        throw new ConflictError(
          installment.status === 'PENDING_PAYROLL'
            ? 'That installment is in a payroll run that has not been finalized. Recalculate or cancel the run first.'
            : `That installment is already ${installment.status.toLowerCase()}.`,
        );
      }

      await prisma.employeeLoanInstallment.update({
        where: { id: installment.id },
        data: { status: 'WAIVED', note: body.note ?? null },
      });

      const completed = await completeIfSettled(params.id);

      await recordAudit({
        companyId: auth.companyId,
        actorId: auth.userId,
        action: 'loan.installment.waive',
        entityType: 'EmployeeLoanInstallment',
        entityId: installment.id,
        summary: `Waived installment ${installment.sequence} of ${toNumber(installment.amount)}${completed ? '; the loan is now complete' : ''}`,
        after: { note: body.note ?? null },
        request,
      });

      return reply.send({ data: { id: installment.id, status: 'WAIVED', loanCompleted: completed } });
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

    await prisma.employeeLoan.update({
      where: { id: loanId },
      data: {
        status: 'APPROVED',
        approvedAt: now,
        approvedByUserId: approval?.decidedByUserId ?? null,
      },
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
