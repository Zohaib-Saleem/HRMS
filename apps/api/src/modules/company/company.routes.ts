import type { FastifyPluginAsync } from 'fastify';
import {
  ATTENDANCE_RULE_DEFAULTS,
  PERMISSIONS,
  type AttendancePayrollIntegrationView,
  type AttendanceRuleValues,
  type AttendanceRulesView,
  attendancePolicySchema,
  attendanceRulesSchema,
  updateCompanySchema,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { diff, recordAudit } from '../../core/audit.js';
import { ForbiddenError, ValidationError } from '../../core/errors.js';
import {
  requireAnyPermission,
  requireAuthContext,
  requirePermission,
} from '../../auth/guards.js';
import { hasFullScope } from '../../auth/scope.js';
import type { AuthContext } from '../../auth/session.js';

/**
 * Company fields that describe how attendance is POLICED rather than how the
 * company presents itself.
 *
 * Every signed-in user holds `company.read` - they need the name, timezone,
 * currency and date format to render anything at all. These particular fields
 * are different: together they tell an employee which networks bypass the
 * check-in restriction, how far from a location a punch is still accepted, and
 * exactly how much lateness goes unrecorded. That is a description of the
 * control, which is useful only to someone trying to work around it. They are
 * returned only to a caller who could change them anyway.
 */
const RESTRICTED_COMPANY_FIELDS = [
  'allowedCheckInCidrs',
  'ipRestrictionEnabled',
  'locationRestrictionEnabled',
  'defaultGeofenceRadiusM',
  'graceMinutes',
  'earlyLeaveGraceMinutes',
  'halfDayMinutes',
  'fullDayMinutes',
  'overtimeEnabled',
  'overtimeAfterMinutes',
  'overtimeDailyCapMinutes',
] as const;

function mayReadRestrictedConfig(auth: AuthContext): boolean {
  return auth.permissions.has(PERMISSIONS.COMPANY_MANAGE);
}

function redactCompany<T extends Record<string, unknown>>(company: T, auth: AuthContext): T {
  if (mayReadRestrictedConfig(auth)) return company;
  const safe = { ...company };
  for (const field of RESTRICTED_COMPANY_FIELDS) delete safe[field];
  return safe;
}

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });
      // Non-administrators get the profile without the enforcement settings.
      return reply.send({ data: redactCompany(company as unknown as Record<string, unknown>, auth) });
    },
  );

  app.patch(
    '/',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(updateCompanySchema, request.body);

      const before = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });
      const after = await prisma.company.update({ where: { id: auth.companyId }, data: input });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        input as unknown as Record<string, unknown>,
      );

      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.update',
          entityType: 'Company',
          entityId: auth.companyId,
          summary: `Updated company settings (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: after });
    },
  );

  /**
   * The attendance policy, saved as its own decision.
   *
   * Kept off the company profile form deliberately: these values change how
   * worked time is scored, so they get their own endpoint, their own permission
   * check and their own audit entry rather than riding along with an address
   * change. Read back through GET /company, which returns the whole row.
   */
  app.patch(
    '/attendance-policy',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_MANAGE) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendancePolicySchema, request.body);

      const before = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } });

      // The check-in restriction fields are optional in the payload: a client
      // that does not send them keeps whatever is stored. Merging here rather
      // than defaulting in the schema means an older client cannot switch a
      // security control off simply by not knowing about it.
      const data = {
        ...input,
        ipRestrictionEnabled: input.ipRestrictionEnabled ?? before.ipRestrictionEnabled,
        allowedCheckInCidrs: input.allowedCheckInCidrs ?? before.allowedCheckInCidrs,
      };

      // Checked against the merged result, so enabling the restriction while
      // relying on an already-configured list is allowed, and enabling it with
      // nothing configured is not.
      if (data.ipRestrictionEnabled && data.allowedCheckInCidrs.length === 0) {
        throw new ValidationError({
          allowedCheckInCidrs: [
            'Add at least one network before turning this on - an empty list refuses every check-in.',
          ],
        });
      }

      const after = await prisma.company.update({ where: { id: auth.companyId }, data });

      const changes = diff(
        before as unknown as Record<string, unknown>,
        data as unknown as Record<string, unknown>,
      );

      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.attendance_policy.update',
          entityType: 'Company',
          entityId: auth.companyId,
          summary: `Updated the attendance policy (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      return reply.send({ data: after });
    },
  );

  // --- attendance rules ----------------------------------------------------
  //
  // The same Company row the attendance policy above writes to, behind a
  // narrower gate. `settings.manage` is Super Admin's; `attendance.rules.manage`
  // exists so HR Admin can be granted these explicitly, on their own, without
  // being handed every other system setting.

  const RULE_FIELDS = {
    defaultShiftStart: true,
    defaultShiftEnd: true,
    defaultBreakMinutes: true,
    overtimeEnabled: true,
    overtimeFromShiftEnd: true,
    overtimeCountsEarlyArrival: true,
    overtimeReducedByLateArrival: true,
    overtimeDailyCapMinutes: true,
    lateTrackingEnabled: true,
    graceMinutes: true,
    lateThresholdMinutes: true,
    earlyDepartureTrackingEnabled: true,
    earlyLeaveGraceMinutes: true,
    earlyLeaveThresholdMinutes: true,
    fullDayToleranceMinutes: true,
    irregularCheckInEnabled: true,
    irregularCheckInCutoff: true,
    irregularCheckInMode: true,
    irregularAfterShiftStartMinutes: true,
    breakIncludedInWindow: true,
    overtimeMinimumMinutes: true,
    overtimeRoundingMinutes: true,
    overtimeWeeklyCapMinutes: true,
    overtimeMonthlyCapMinutes: true,
    missingCheckOutStatus: true,
    missingCheckInStatus: true,
    weekendWorkRule: true,
    holidayWorkRule: true,
    timezone: true,
    weekendDays: true,
    halfDayMinutes: true,
    fullDayMinutes: true,
    overtimeAfterMinutes: true,
  } as const;

  /** Whoever may change the rules: Super Admin, or HR granted them explicitly. */
  const canManageRules = (auth: AuthContext): boolean =>
    auth.permissions.has(PERMISSIONS.SETTINGS_MANAGE) ||
    auth.permissions.has(PERMISSIONS.ATTENDANCE_RULES_MANAGE);

  /**
   * The pay-side switches shown beside the attendance rules they depend on.
   *
   * Read from payroll settings, never copied: "does lateness cost money?" is
   * one fact, and two screens storing their own answer to it is how a company
   * ends up deducting for something it switched off.
   */
  const payrollIntegrationFor = async (
    companyId: string,
  ): Promise<AttendancePayrollIntegrationView | null> => {
    const settings = await prisma.payrollSettings.findUnique({
      where: { companyId },
      select: {
        deductUnpaidAbsence: true,
        deductUnpaidLeave: true,
        lateDeductionMode: true,
        earlyLeaveDeductionMode: true,
        overtimeMode: true,
        requireApprovedOvertime: true,
        overtimeMultiplier: true,
        overtimeCapMinutes: true,
      },
    });
    if (!settings) return null;
    return {
      deductUnpaidAbsence: settings.deductUnpaidAbsence,
      deductUnpaidLeave: settings.deductUnpaidLeave,
      lateDeductionEnabled: settings.lateDeductionMode !== 'NONE',
      earlyLeaveDeductionEnabled: settings.earlyLeaveDeductionMode !== 'NONE',
      overtimePaid: settings.overtimeMode !== 'NONE',
      requireApprovedOvertime: settings.requireApprovedOvertime,
      overtimeMultiplier: Number(settings.overtimeMultiplier),
      overtimeCapMinutes: settings.overtimeCapMinutes,
    };
  };

  const ruleView = (
    row: Record<string, unknown>,
    canManage: boolean,
    payrollIntegration: AttendancePayrollIntegrationView | null,
  ): AttendanceRulesView =>
    ({
      ...row,
      weekendDays: row.weekendDays as AttendanceRuleValues['weekendDays'],
      // The shipped values, so "reset to default" on the screen offers the
      // number a new company actually gets rather than one typed twice.
      defaults: ATTENDANCE_RULE_DEFAULTS,
      payrollIntegration,
      canManage,
    }) as AttendanceRulesView;

  /** Readable by anyone who may read the company; writable behind the gate above. */
  app.get(
    '/attendance-rules',
    { preHandler: requirePermission(PERMISSIONS.COMPANY_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const [row, payrollIntegration] = await Promise.all([
        prisma.company.findUniqueOrThrow({
          where: { id: auth.companyId },
          select: RULE_FIELDS,
        }),
        payrollIntegrationFor(auth.companyId),
      ]);

      return reply.send({ data: ruleView(row, canManageRules(auth), payrollIntegration) });
    },
  );

  app.patch(
    '/attendance-rules',
    {
      preHandler: requireAnyPermission(
        PERMISSIONS.SETTINGS_MANAGE,
        PERMISSIONS.ATTENDANCE_RULES_MANAGE,
      ),
    },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const input = parseOrThrow(attendanceRulesSchema, request.body);

      const before = await prisma.company.findUniqueOrThrow({
        where: { id: auth.companyId },
        select: RULE_FIELDS,
      });

      /**
       * A rule the payload did not mention keeps the value it has.
       *
       * The newer fields are optional so an older client can still save, and
       * `undefined` reaching Prisma would be read as "leave alone" anyway -
       * this makes that explicit rather than incidental, and keeps the diff
       * below honest about what actually changed.
       */
      const changes = diff(
        before as unknown as Record<string, unknown>,
        Object.fromEntries(
          Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined),
        ),
      );

      const after = await prisma.company.update({
        where: { id: auth.companyId },
        data: input,
        select: RULE_FIELDS,
      });

      // Every change is recorded with its old and new value. Nothing here is a
      // credential, and `recordAudit` redacts by key regardless.
      if (changes.changed.length > 0) {
        await recordAudit({
          companyId: auth.companyId,
          actorId: auth.userId,
          action: 'company.attendance_rules.update',
          entityType: 'Company',
          entityId: auth.companyId,
          summary: `Updated attendance rules (${changes.changed.join(', ')})`,
          before: changes.before,
          after: changes.after,
          request,
        });
      }

      const payrollIntegration = await payrollIntegrationFor(auth.companyId);
      return reply.send({ data: ruleView(after, true, payrollIntegration) });
    },
  );

  /**
   * KPI counters for the administrative dashboard.
   *
   * Company-wide aggregates, so this needs company-wide SIGHT and not merely
   * the `company.read` permission every signed-in user holds. Permission
   * answers "may you read company things?"; scope answers "how much of the
   * company?" - and this endpoint previously asked only the first question,
   * handing headcount, active-account count, absence levels and the hiring rate
   * to an employee whose scope is OWN. In a small company "on leave: 1" plus a
   * visibly absent colleague identifies that colleague.
   *
   * Personal dashboard figures come from /me/dashboard instead.
   */
  app.get(
    '/stats',
    { preHandler: requirePermission(PERMISSIONS.EMPLOYEE_READ) },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      if (!hasFullScope(auth)) {
        throw new ForbiddenError('You do not have permission to view company-wide statistics.');
      }
      const companyId = auth.companyId;

      const [employees, activeEmployees, onLeave, departments, teams, activeUsers, newThisMonth] =
        await Promise.all([
          prisma.employee.count({ where: { companyId } }),
          prisma.employee.count({ where: { companyId, status: 'ACTIVE' } }),
          prisma.employee.count({ where: { companyId, status: 'ON_LEAVE' } }),
          prisma.department.count({ where: { companyId, isActive: true } }),
          prisma.team.count({ where: { companyId, isActive: true } }),
          prisma.user.count({ where: { companyId, status: 'ACTIVE' } }),
          prisma.employee.count({
            where: {
              companyId,
              hireDate: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
            },
          }),
        ]);

      return reply.send({
        data: { employees, activeEmployees, onLeave, departments, teams, activeUsers, newThisMonth },
      });
    },
  );

};
