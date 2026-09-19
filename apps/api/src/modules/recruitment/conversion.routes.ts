import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  EMPLOYMENT_STATUS_LABELS,
  PERMISSIONS,
  candidateConvertSchema,
  idParamSchema,
  type CandidateConversionPreview,
  type EmploymentStatus,
} from '@hrms/shared';
import { prisma } from '../../core/db.js';
import { parseOrThrow } from '../../core/validate.js';
import { recordAudit } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requireAuth, requireAuthContext, requirePermission } from '../../auth/guards.js';
import {
  DETAIL_INCLUDE,
  assertReferencesExist,
  nextEmployeeNumber,
  toDetail,
} from '../employees/employees.service.js';
import { refreshCandidateStage, resolveActor } from './recruitment.service.js';

/**
 * Convert to Employee.
 *
 * The only thing in the entire recruitment module that writes to the employees
 * table, which is why it is its own file, its own grant
 * (`recruitment.convert.employee`) and its own two-step flow. Everything else
 * in recruitment could be deleted tomorrow without a single employee record
 * noticing.
 *
 * Section 16 and section 27 ask for four things, and each is enforced here
 * rather than trusted to a form:
 *
 *   1. NO AUTOMATIC DUPLICATE. `GET /preview` reports existing employees who
 *      look like this candidate - by email, and by name - and `POST` REFUSES
 *      while any exist unless the caller has explicitly acknowledged them.
 *      Two people really do share a name, so it is an overrulable refusal
 *      rather than a hard block; what it is not is silent.
 *   2. ONE CANDIDATE, ONE EMPLOYEE, EVER. `candidates.hiredEmployeeId` is
 *      unique, so a second conversion cannot produce a second employee even
 *      under a race. The check below turns that constraint into a readable
 *      message; the constraint is what actually holds.
 *   3. HR REVIEWS THE MAPPING. The preview is a PROPOSAL - assembled from the
 *      accepted offer, then the job opening, then the candidate - and the POST
 *      body is what a person confirmed, not what the candidate record said.
 *      Nothing is created from the candidate alone.
 *   4. NOTHING ELSE IS TOUCHED. No existing employee is read for writing. No
 *      login account is created: section 16 is explicit about that, and the
 *      HRMS already has a user-creation flow behind `user.manage` which HR
 *      uses deliberately afterwards. No salary, no payroll profile, no
 *      contract - the offer's figure stays on the offer.
 *
 * Employment status comes from the CANONICAL enum and defaults to PROBATION,
 * which is section 17. There is no second employment-status field anywhere in
 * recruitment; the value on the offer and the value written here are the same
 * three-member enum the employee record already uses.
 */

function dateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Splits a candidate's single name field into the two the employee record has.
 *
 * Everything before the last space is the first name, the remainder is the
 * surname, and a single word becomes a first name with the surname left for a
 * person to fill in. A guess, and openly one - which is exactly why the result
 * lands on a form HR edits rather than straight into the database.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1]!,
  };
}

export const conversionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requirePermission(PERMISSIONS.RECRUITMENT_CONVERT_EMPLOYEE));

  /**
   * The proposal, and the duplicate warning.
   *
   * Read-only. It creates nothing, and calling it twice changes nothing - it
   * exists so HR can SEE what would be created, and see who already looks like
   * this person, before anything is.
   */
  app.get('/:id/conversion-preview', async (request, reply) => {
    const auth = requireAuthContext(request);
    const { id } = parseOrThrow(idParamSchema, request.params);

    const candidate = await prisma.candidate.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        applications: {
          orderBy: { stageChangedAt: 'desc' },
          include: {
            jobOpening: {
              select: {
                id: true,
                title: true,
                departmentId: true,
                teamId: true,
                locationId: true,
                employmentType: true,
                expectedEmploymentStatus: true,
                hiringManagerId: true,
              },
            },
          },
        },
        offers: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!candidate) throw new NotFoundError('Candidate');

    /*
     * Where each suggestion comes from, in order of authority: the ACCEPTED
     * offer first, because it is what the candidate actually agreed to; the job
     * opening they were hired against second; the candidate record last. An
     * offer that was declined or expired is deliberately not consulted - it
     * describes a deal that did not happen.
     */
    const acceptedOffer = candidate.offers.find((offer) => offer.status === 'ACCEPTED') ?? null;
    const hiredApplication =
      candidate.applications.find((application) => application.stage === 'HIRED') ??
      candidate.applications.find((application) => application.stage === 'OFFER') ??
      candidate.applications[0] ??
      null;
    const opening = hiredApplication?.jobOpening ?? null;

    const { firstName, lastName } = splitName(candidate.fullName);

    const employmentStatus: EmploymentStatus =
      (acceptedOffer?.employmentStatus as EmploymentStatus | null) ??
      (opening?.expectedEmploymentStatus as EmploymentStatus | null) ??
      // Section 17's default, and the last word rather than the first: it
      // applies only when neither the offer nor the vacancy said anything.
      'PROBATION';

    const duplicates = await findDuplicates(auth.companyId, candidate.email, candidate.fullName);

    const preview: CandidateConversionPreview = {
      candidateId: candidate.id,
      suggested: {
        employeeNumber: await nextEmployeeNumber(auth.companyId),
        firstName,
        lastName,
        // The candidate's address is their PERSONAL one - it is where they
        // applied from. A work address does not exist until they have a desk,
        // so it is deliberately left for HR rather than guessed at.
        workEmail: null,
        personalEmail: candidate.email,
        phone: candidate.phone,
        departmentId: opening?.departmentId ?? null,
        teamId: opening?.teamId ?? null,
        designationId: acceptedOffer?.designationId ?? null,
        locationId: opening?.locationId ?? null,
        jobTitle: acceptedOffer?.proposedTitle ?? opening?.title ?? candidate.currentTitle,
        employmentType: acceptedOffer?.employmentType ?? opening?.employmentType ?? 'FULL_TIME',
        employmentStatus,
        hireDate: acceptedOffer?.expectedJoiningDate
          ? acceptedOffer.expectedJoiningDate.toISOString().slice(0, 10)
          : null,
        sourceOfHire: candidate.source,
        linkedinUrl: candidate.linkedinUrl,
        // Years on the candidate, months on the employee. Converted rather than
        // dropped, because the roster field is in months and re-keying it is
        // how it ends up wrong.
        priorExperienceMonths:
          candidate.experienceYears === null ? null : candidate.experienceYears * 12,
      },
      derivedFrom: {
        offerId: acceptedOffer?.id ?? null,
        jobOpeningId: opening?.id ?? null,
      },
      duplicates,
      alreadyConvertedEmployeeId: candidate.hiredEmployeeId,
    };

    return reply.send({ data: preview });
  });

  /**
   * Creating the employee.
   *
   * The body is what HR confirmed on the review form, not what the candidate
   * record holds - so every value written here has been looked at by a person.
   * The candidate row is updated in the SAME transaction as the employee is
   * created, because an employee created without the back-link is a duplicate
   * waiting to be made on the next attempt.
   */
  app.post('/:id/convert', async (request, reply) => {
    const auth = requireAuthContext(request);
    const actor = await resolveActor(auth);
    const { id } = parseOrThrow(idParamSchema, request.params);
    const input = parseOrThrow(candidateConvertSchema, request.body);

    const candidate = await prisma.candidate.findFirst({
      where: { id, companyId: auth.companyId },
      select: {
        id: true,
        fullName: true,
        reference: true,
        email: true,
        hiredEmployeeId: true,
        applications: { select: { id: true, stage: true, jobOpeningId: true } },
      },
    });
    if (!candidate) throw new NotFoundError('Candidate');

    /*
     * Already converted. The unique index on hiredEmployeeId is what actually
     * prevents a second employee; this turns it into a message that names the
     * record rather than a constraint violation.
     */
    if (candidate.hiredEmployeeId) {
      const existing = await prisma.employee.findUnique({
        where: { id: candidate.hiredEmployeeId },
        select: { employeeNumber: true, firstName: true, lastName: true },
      });
      throw new ConflictError(
        existing
          ? `${candidate.fullName} has already been converted to ${existing.firstName} ${existing.lastName} (${existing.employeeNumber}).`
          : `${candidate.fullName} has already been converted to an employee.`,
      );
    }

    /*
     * The duplicate check, re-run at the moment of writing rather than trusted
     * from the preview. A preview taken ten minutes ago says nothing about the
     * employee somebody else created five minutes ago.
     */
    const duplicates = await findDuplicates(
      auth.companyId,
      input.workEmail ?? input.personalEmail ?? candidate.email,
      `${input.firstName} ${input.lastName}`.trim(),
    );

    if (duplicates.length > 0 && !input.acknowledgeDuplicates) {
      throw new ConflictError(
        `${duplicates.map((d) => `${d.fullName} (${d.employeeNumber})`).join(', ')} already ${duplicates.length === 1 ? 'looks' : 'look'} like this person. Check before creating a second employee record.`,
        );
    }

    await assertReferencesExist(auth.companyId, input);

    if (input.employmentStatus === 'PERMANENT') {
      /*
       * The existing employment-status rule, applied here rather than
       * re-invented: PERMANENT means somebody was confirmed, and confirming
       * somebody means saying when. A new hire has no confirmation date, so
       * this is a genuine refusal rather than a formality - a permanent hire
       * with no confirmation date is the record the employee module already
       * refuses to produce, and recruitment must not become a back door to it.
       */
      throw new ValidationError({
        employmentStatus: [
          'A new hire cannot start as Permanent - that status needs a confirmation date. Start them on Probation or as an Internee, and confirm them from their employee record.',
        ],
      });
    }

    const employeeNumber = input.employeeNumber ?? (await nextEmployeeNumber(auth.companyId));

    const clash = await prisma.employee.findFirst({
      where: { companyId: auth.companyId, employeeNumber },
      select: { id: true },
    });
    if (clash) {
      throw new ValidationError({
        employeeNumber: [`Employee number ${employeeNumber} is already in use.`],
      });
    }

    const employeeData: Prisma.EmployeeUncheckedCreateInput = {
      companyId: auth.companyId,
      employeeNumber,
      firstName: input.firstName,
      lastName: input.lastName,
      workEmail: input.workEmail,
      personalEmail: input.personalEmail,
      phone: input.phone,
      departmentId: input.departmentId,
      teamId: input.teamId,
      designationId: input.designationId,
      locationId: input.locationId,
      managerId: input.managerId,
      jobTitle: input.jobTitle,
      employmentType: input.employmentType,
      employmentStatus: input.employmentStatus,
      status: 'ACTIVE',
      hireDate: dateColumn(input.hireDate),
      sourceOfHire: input.sourceOfHire,
      linkedinUrl: input.linkedinUrl,
      priorExperienceMonths: input.priorExperienceMonths ?? null,
      /*
       * No userId. Section 16: an account is NOT created automatically. The
       * HRMS already has a user-creation flow behind `user.manage`, and HR
       * uses it deliberately afterwards if the new joiner needs a login.
       */
    };

    const { employee } = await prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: employeeData,
        include: DETAIL_INCLUDE,
      });

      // The back-link, in the same transaction. An employee created without it
      // is a duplicate waiting to be made on the next attempt.
      await tx.candidate.update({
        where: { id: candidate.id },
        data: { hiredEmployeeId: created.id, hiredAt: new Date(), stage: 'HIRED' },
      });

      /*
       * The application they were hired against moves to HIRED, and only one:
       * somebody hired for the Unity role is not thereby hired for the Design
       * role they also applied for. The others are left exactly as they are for
       * HR to close off deliberately.
       */
      const target =
        candidate.applications.find((a) => a.stage === 'OFFER') ??
        candidate.applications.find((a) => a.stage === 'SELECTED') ??
        null;

      if (target) {
        await tx.candidateApplication.update({
          where: { id: target.id },
          data: { stage: 'HIRED', stageChangedAt: new Date(), stageChangedBy: auth.userId },
        });
      }

      return { employee: created };
    });

    await refreshCandidateStage(candidate.id);

    await recordAudit({
      companyId: auth.companyId,
      actorId: auth.userId,
      action: 'candidate.converted_to_employee',
      entityType: 'Employee',
      entityId: employee.id,
      summary: `Converted candidate ${candidate.fullName} (${candidate.reference}) into employee ${employee.firstName} ${employee.lastName} (${employeeNumber}), starting on ${EMPLOYMENT_STATUS_LABELS[input.employmentStatus]}`,
      after: {
        candidateId: candidate.id,
        employeeId: employee.id,
        employeeNumber,
        employmentType: input.employmentType,
        employmentStatus: input.employmentStatus,
        hireDate: input.hireDate,
        duplicatesAcknowledged: duplicates.length > 0,
        // Recorded because "no login was created" is a fact somebody will ask
        // about later, and an absence is not otherwise visible in a log.
        loginCreated: false,
      },
      request,
    });

    return reply.code(201).send({
      data: {
        employee: toDetail(employee, actor.auth.permissions.has(PERMISSIONS.EMPLOYEE_SENSITIVE_READ)),
        candidateId: candidate.id,
      },
    });
  });
};

/**
 * Existing employees who look like this person.
 *
 * Two tests, and they are different kinds of evidence. An EMAIL match is close
 * to proof - addresses are unique to a person - and a NAME match is a prompt to
 * look, because plenty of companies employ two people called Muhammad Ali. Both
 * are reported, labelled with which matched, so the person deciding can weigh
 * them rather than being handed an undifferentiated "possible duplicate".
 *
 * Terminated and resigned employees are INCLUDED. Somebody who worked here
 * before and is coming back is exactly the case where a second record is a
 * disaster - two histories for one person - and excluding them would hide the
 * only match that really matters.
 */
async function findDuplicates(
  companyId: string,
  email: string | null,
  fullName: string,
): Promise<CandidateConversionPreview['duplicates']> {
  const normalisedEmail = email?.trim().toLowerCase() ?? null;
  const { firstName, lastName } = splitName(fullName);

  const byEmail = normalisedEmail
    ? await prisma.employee.findMany({
        where: {
          companyId,
          OR: [
            { workEmail: { equals: normalisedEmail, mode: 'insensitive' } },
            { personalEmail: { equals: normalisedEmail, mode: 'insensitive' } },
          ],
        },
        select: { id: true, employeeNumber: true, firstName: true, lastName: true, workEmail: true },
      })
    : [];

  const byName =
    firstName && lastName
      ? await prisma.employee.findMany({
          where: {
            companyId,
            firstName: { equals: firstName, mode: 'insensitive' },
            lastName: { equals: lastName, mode: 'insensitive' },
          },
          select: {
            id: true,
            employeeNumber: true,
            firstName: true,
            lastName: true,
            workEmail: true,
          },
        })
      : [];

  const seen = new Set<string>();
  const duplicates: CandidateConversionPreview['duplicates'] = [];

  for (const [rows, matchedOn] of [
    [byEmail, 'EMAIL'],
    [byName, 'NAME'],
  ] as const) {
    for (const row of rows) {
      // An employee matching on both is reported once, as the stronger of the
      // two - which is why the email pass runs first.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      duplicates.push({
        employeeId: row.id,
        employeeNumber: row.employeeNumber,
        fullName: `${row.firstName} ${row.lastName}`.trim(),
        workEmail: row.workEmail,
        matchedOn,
      });
    }
  }

  return duplicates;
}
