/**
 * Restores the preconditions the Phase 5 audit suite expects.
 *
 * The suite exercises two deliberately one-shot operations: approving an
 * attendance correction, and approving a shift change. Both are idempotent by
 * design, so a second run against the leftovers of the first would report "no
 * change" and look like a failure when the code is behaving exactly as
 * intended.
 *
 * This removes only the rows a previous audit run created, matched on the
 * marker text the suite writes into every request it raises. It never touches
 * seeded or hand-entered data, and it is not a database reset.
 *
 * It also selects the approval chain shape the suites need, because Phase 3 and
 * Phase 4 want different ones and neither can set it up through the API:
 *
 *   node scripts/reset-audit-fixtures.mjs              one-step chain (Phase 4/5)
 *   node scripts/reset-audit-fixtures.mjs --two-step   two-step chain (Phase 3)
 *
 * Phase 3 exercises a manager-then-admin chain, which exists only when the
 * demo employee has a second approver. Phase 4 asserts that one approval
 * finishes a leave request, which is only true with a single approver. The
 * employee PATCH route replaces the whole record, so a shell suite cannot flip
 * this one field without risking the rest of the person - hence doing it here.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TWO_STEP = process.argv.includes('--two-step');

/** Requests the suites raise carry one of these markers in their reason. */
const MARKERS = ['Phase 5:', 'Audit:'];
const FIXTURE_ATTENDANCE_DATE = new Date(Date.UTC(2026, 7, 19)); // 19 Aug 2026
const FIXTURE_SHIFT_FROM = new Date(Date.UTC(2026, 9, 1)); // 1 Oct 2026

async function main() {
  const removed = {};

  const regularizations = await prisma.attendanceRegularizationRequest.findMany({
    where: { OR: MARKERS.map((m) => ({ reason: { startsWith: m } })) },
    select: { id: true, approvalRequestId: true },
  });
  const shiftChanges = await prisma.shiftChangeRequest.findMany({
    where: { OR: MARKERS.map((m) => ({ reason: { startsWith: m } })) },
    select: { id: true, approvalRequestId: true },
  });

  const approvalIds = [...regularizations, ...shiftChanges]
    .map((r) => r.approvalRequestId)
    .filter((id) => id !== null);

  removed.regularizations = (
    await prisma.attendanceRegularizationRequest.deleteMany({
      where: { id: { in: regularizations.map((r) => r.id) } },
    })
  ).count;

  removed.shiftChangeRequests = (
    await prisma.shiftChangeRequest.deleteMany({
      where: { id: { in: shiftChanges.map((r) => r.id) } },
    })
  ).count;

  // Approval steps and decisions cascade from the request.
  removed.approvals = (
    await prisma.approvalRequest.deleteMany({ where: { id: { in: approvalIds } } })
  ).count;

  // The record the approved correction wrote through, and the assignment the
  // approved shift change created.
  removed.attendanceRecords = (
    await prisma.attendanceRecord.deleteMany({
      where: { date: FIXTURE_ATTENDANCE_DATE, source: 'ADMIN' },
    })
  ).count;

  removed.shiftAssignments = (
    await prisma.employeeShiftAssignment.deleteMany({
      where: { effectiveFrom: FIXTURE_SHIFT_FROM },
    })
  ).count;

  // The Phase 4 suite books a five-day leave request and has it approved.
  // Approved leave cannot be withdrawn through the API - correctly, since a
  // decision that can be silently undone is not a decision - so the suite
  // cannot tidy up after itself, and a second run collides with the first.
  // Only requests carrying an audit marker in their reason are removed.
  const auditLeave = await prisma.leaveRequest.findMany({
    where: {
      OR: [{ reason: { startsWith: 'Audit:' } }, { reason: { startsWith: 'Policy audit:' } }],
    },
    select: { id: true, approvalRequestId: true },
  });

  removed.leaveRequests = (
    await prisma.leaveRequest.deleteMany({ where: { id: { in: auditLeave.map((r) => r.id) } } })
  ).count;

  removed.leaveApprovals = (
    await prisma.approvalRequest.deleteMany({
      where: {
        id: { in: auditLeave.map((r) => r.approvalRequestId).filter((id) => id !== null) },
      },
    })
  ).count;

  // The suite checks in as the demo employee, and check-in is deliberately
  // once per day. Clearing today's self-captured record for the demo accounts
  // lets the capture path be exercised again; nothing else is touched.
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  removed.todaysDemoCheckIns = (
    await prisma.attendanceRecord.deleteMany({
      where: {
        date: todayUtc,
        source: 'SELF',
        employee: {
          user: {
            email: { in: ['admin@hrms.local', 'manager@hrms.local', 'employee@hrms.local'] },
          },
        },
      },
    })
  ).count;

  // Re-open any assignment the approved change closed off.
  removed.reopenedAssignments = (
    await prisma.employeeShiftAssignment.updateMany({
      where: { effectiveTo: new Date(Date.UTC(2026, 8, 30)) },
      data: { effectiveTo: null },
    })
  ).count;

  // Timesheets the Phase 3 suite creates for a fixed period; a second run
  // would collide with the first.
  const auditTimesheets = await prisma.timesheet.findMany({
    where: { periodStart: new Date(Date.UTC(2026, 5, 1)) },
    select: { id: true, approvalRequestId: true },
  });
  removed.timesheets = (
    await prisma.timesheet.deleteMany({ where: { id: { in: auditTimesheets.map((t) => t.id) } } })
  ).count;
  removed.timesheetApprovals = (
    await prisma.approvalRequest.deleteMany({
      where: {
        id: { in: auditTimesheets.map((t) => t.approvalRequestId).filter((id) => id !== null) },
      },
    })
  ).count;

  // The approval chain shape.
  const employee = await prisma.employee.findFirst({
    where: { user: { email: 'employee@hrms.local' } },
    select: { id: true },
  });
  const secondApprover = await prisma.employee.findFirst({
    where: { user: { email: 'admin@hrms.local' } },
    select: { id: true },
  });

  if (employee && secondApprover) {
    await prisma.employee.update({
      where: { id: employee.id },
      data: { secondaryManagerId: TWO_STEP ? secondApprover.id : null },
    });
    removed.chain = TWO_STEP ? 'two-step (manager then admin)' : 'one-step (manager only)';
  }

  console.log('audit fixtures reset:', JSON.stringify(removed));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
