import type { FastifyRequest } from 'fastify';
import { PERMISSIONS } from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, ForbiddenError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../auth/session.js';
import { periodsOverlap, setMapping } from '../attendance-device/mapping.service.js';

/**
 * The PunchCode on the employee form.
 *
 * There is no punch-code column on the employee. A punch code is a device
 * mapping - `AttendanceDeviceUserMapping`, one row per (device, PIN, period) -
 * because a PIN belongs to a terminal, gets reused when somebody leaves, and
 * decides whose attendance a punch becomes. Storing a second copy on the
 * employee row would give two answers to that question.
 *
 * So this module is a thin bridge: the create/edit form collects one PIN, and
 * this writes it through `setMapping`, the same service the Device User
 * Mapping screen uses. Every rule that makes attribution safe therefore still
 * holds - periods that cannot overlap, raw punches whose only writable column
 * is the attribution, and a correction that moves the future, not the past.
 *
 * What the form deliberately does NOT offer is an effective date or a
 * takeover. Handing a PIN from one employee to another is a dated decision
 * with consequences for two people's attendance; it stays on the screen built
 * for it, and this refuses the clash by name instead.
 */

/** Empty and null both mean "this person punches under no PIN". */
const blank = (value: string | null | undefined) => value === null || value === undefined || value.trim() === '';

const displayName = (e: { firstName: string; lastName: string; displayName: string | null }) =>
  e.displayName ?? `${e.firstName} ${e.lastName}`.trim();

export interface PunchCodeInput {
  /** Absent means "leave the mapping alone". Null or empty means "close it". */
  punchCode?: string | null;
  punchDeviceId?: string | null;
}

/**
 * True when the payload names a code to set.
 *
 * Deliberately NOT true for a blank one. Create always carries the key - the
 * schema fills an omitted optional with null - and treating that as a request
 * would make every employee created by a role without `device.manage` fail on
 * a field nobody filled in. A blank is handled by `applyPunchCode`, which
 * first checks whether there is anything to clear.
 */
export function carriesPunchCode(input: PunchCodeInput): boolean {
  return !blank(input.punchCode);
}

/**
 * Which terminal the code belongs to.
 *
 * One device is the usual case and naming it every time would be noise, so it
 * is inferred then. Several devices is not a case to guess at: the same PIN on
 * two terminals is two different people often enough that picking one here
 * would be how attendance quietly lands on the wrong record.
 */
async function resolveDeviceId(companyId: string, punchDeviceId: string | null | undefined): Promise<string> {
  if (!blank(punchDeviceId)) {
    const device = await prisma.attendanceDevice.findFirst({
      where: { id: punchDeviceId!, companyId },
      select: { id: true },
    });
    if (!device) throw new ValidationError({ punchDeviceId: ['That attendance device does not exist.'] });
    return device.id;
  }

  const devices = await prisma.attendanceDevice.findMany({
    where: { companyId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  if (devices.length === 0) {
    throw new ValidationError({
      punchCode: [
        'No attendance device is configured yet, so there is nothing to map a punch code to. Add the device under Settings -> Attendance first.',
      ],
    });
  }
  if (devices.length > 1) {
    throw new ValidationError({
      punchDeviceId: [
        `Choose which device this punch code belongs to (${devices.map((d) => d.name).join(', ')}).`,
      ],
    });
  }
  return devices[0]!.id;
}

export interface PunchCodeOutcome {
  deviceId: string;
  /** What the employee punches under now, or null when the mapping was closed. */
  punchCode: string | null;
  /** Punches the existing re-attribution moved onto this employee. */
  reattributedPunches: number;
  affectedDays: number;
  /** For the route's own audit summary. */
  summary: string;
}

/**
 * Everything that can refuse a punch code, checked before anything is written.
 *
 * Split out so the CREATE path can ask the question before the employee row
 * exists: an HR user who types a PIN that belongs to somebody else should get
 * the clash, not a half-made employee plus an error.
 *
 * `employeeId` is null on create - nobody holds the code yet, so every active
 * holder is somebody else.
 */
export async function assertPunchCodeAssignable(
  auth: AuthContext,
  employeeId: string | null,
  input: PunchCodeInput,
): Promise<{ deviceId: string; code: string | null }> {
  /*
   * Setting a punch code is a device change wearing an employee form's
   * clothes, and it is gated as one. HR Admin and Super Admin both hold
   * `device.manage` already, so this changes nothing for the people who do
   * the job - it stops a role granted only `employee.manage` from silently
   * moving attendance around through the back door.
   */
  if (!auth.permissions.has(PERMISSIONS.DEVICE_MANAGE)) {
    throw new ForbiddenError('You do not have permission to set an attendance punch code.');
  }

  const deviceId = await resolveDeviceId(auth.companyId, input.punchDeviceId);
  const code = blank(input.punchCode) ? null : input.punchCode!.trim();
  if (code === null) return { deviceId, code };

  const holders = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId: auth.companyId, deviceId, deviceUserId: code, isActive: true },
    select: {
      employeeId: true,
      effectiveFrom: true,
      effectiveTo: true,
      employee: {
        select: { firstName: true, lastName: true, displayName: true, employeeNumber: true },
      },
    },
  });

  const openPeriod = { effectiveFrom: null, effectiveTo: null };
  const taken = holders.find((h) => h.employeeId !== employeeId && periodsOverlap(h, openPeriod));
  if (taken) {
    /*
     * Named, never silently replaced. The other mapping is left exactly as it
     * is: taking a PIN over is a dated decision about two people's attendance,
     * and the screen built for it asks for the date and the confirmation.
     */
    throw new ConflictError(
      `Punch Code ${code} is already assigned to another employee (${displayName(taken.employee)}, ${taken.employee.employeeNumber}). ` +
        'To hand it over, use Settings -> Attendance -> Device User Mapping, which asks for the date the handover takes effect.',
    );
  }

  return { deviceId, code };
}

/**
 * Applies the form's punch code to the device mapping.
 *
 * Returns null when the payload had nothing to say about it, which is what a
 * PATCH that only moves somebody's team looks like.
 */
export async function applyPunchCode({
  auth,
  employeeId,
  input,
  request,
}: {
  auth: AuthContext;
  employeeId: string;
  input: PunchCodeInput;
  request?: FastifyRequest;
}): Promise<PunchCodeOutcome | null> {
  // Absent means "leave the mapping alone" - a PATCH that only moves somebody's
  // team, or any caller that has never heard of punch codes.
  if (input.punchCode === undefined) return null;

  /*
   * A blank field on somebody who punches under no PIN is not a request. It is
   * what the form holds for most of the company, and demanding `device.manage`
   * to do nothing with it would break employee editing for every role that has
   * no business with attendance.
   */
  if (blank(input.punchCode)) {
    const held = await prisma.attendanceDeviceUserMapping.count({
      where: { companyId: auth.companyId, employeeId, isActive: true },
    });
    if (held === 0) return null;
  }

  const { deviceId, code } = await assertPunchCodeAssignable(auth, employeeId, input);

  const mine = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId: auth.companyId, deviceId, employeeId, isActive: true },
    select: { id: true, deviceUserId: true },
  });

  /* ---------------------------------------------------------- clearing it */
  if (code === null) {
    if (mine.length === 0) return null;

    await prisma.attendanceDeviceUserMapping.updateMany({
      where: { id: { in: mine.map((m) => m.id) } },
      data: { isActive: false },
    });

    const summary = `Cleared PunchCode ${mine.map((m) => m.deviceUserId).join(', ')}`;
    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'device.mapping.update',
      entityType: 'AttendanceDeviceUserMapping',
      entityId: mine[0]!.id,
      summary: `${summary} - set from the employee form. Historical punches keep the employee they were attributed to.`,
      before: { deviceUserIds: mine.map((m) => m.deviceUserId), isActive: true },
      after: { isActive: false },
      request,
    });

    return { deviceId, punchCode: null, reattributedPunches: 0, affectedDays: 0, summary };
  }

  /* ------------------------------------------------------- nothing to do */
  if (mine.some((m) => m.deviceUserId === code)) return null;

  /*
   * Changing somebody's own PIN closes the old mapping rather than editing it.
   * The punches already attributed under the old code stay theirs - they were
   * this person's punches and still are - and the new code starts attributing
   * from here.
   */
  const replaced = mine.filter((m) => m.deviceUserId !== code);
  if (replaced.length > 0) {
    await prisma.attendanceDeviceUserMapping.updateMany({
      where: { id: { in: replaced.map((m) => m.id) } },
      data: { isActive: false },
    });
  }

  const result = await setMapping({
    companyId: auth.companyId,
    deviceId,
    deviceUserId: code,
    employeeId,
    isActive: true,
    // Open-ended, which is what "this is their punch code" means. The unmapped
    // punches already sitting under this PIN are the whole point: they are the
    // rows the Device Punches page shows as Unmapped today.
    effectiveFrom: null,
    effectiveTo: null,
    closeConflicting: false,
  });

  await recordAudit({
    companyId: auth.companyId,
    actorId: auth.userId,
    action: result.before ? 'device.mapping.correct' : 'device.mapping.set',
    entityType: 'AttendanceDeviceUserMapping',
    entityId: result.id,
    summary: `${result.summary} - set from the employee form${
      replaced.length ? `, replacing PunchCode ${replaced.map((m) => m.deviceUserId).join(', ')}` : ''
    }`,
    before: result.before ?? undefined,
    after: result.after,
    request,
  });

  return {
    deviceId,
    punchCode: code,
    reattributedPunches: result.reattributedPunches,
    affectedDays: result.affectedDays,
    summary: result.summary,
  };
}

/** The active punch code(s) an employee punches under, for the edit form. */
export async function punchCodesForEmployee(
  companyId: string,
  employeeId: string,
): Promise<{ deviceId: string; punchCode: string }[]> {
  const rows = await prisma.attendanceDeviceUserMapping.findMany({
    where: { companyId, employeeId, isActive: true },
    select: { deviceId: true, deviceUserId: true },
    orderBy: { deviceUserId: 'asc' },
  });
  return rows.map((r) => ({ deviceId: r.deviceId, punchCode: r.deviceUserId }));
}
