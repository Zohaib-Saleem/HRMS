import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type Permission } from '@hrms/shared';

/**
 * Convert to Employee: the only thing in recruitment that writes to the
 * employees table.
 *
 * Four claims, one per rule section 16 and section 27 ask for:
 *
 *   1. NO AUTOMATIC DUPLICATE. Somebody who looks like this person - by email,
 *      or by name - is reported, and the conversion is REFUSED until a human
 *      has acknowledged them. Overrulable, because two people really do share a
 *      name; never silent, because the alternative is two histories for one
 *      person;
 *   2. ONE CANDIDATE, ONE EMPLOYEE, EVER. A second attempt is refused by name;
 *   3. HR REVIEWS THE MAPPING. The preview is a PROPOSAL, assembled from the
 *      accepted offer, then the vacancy, then the candidate record - and what
 *      is written is the body a person confirmed, not what the candidate said;
 *   4. NOTHING ELSE IS TOUCHED. No login account is created. No salary, no
 *      payroll profile, no contract. The offer's figure stays on the offer.
 */

const kit = await vi.hoisted(async () => import('./recruitment.test-kit.js'));
const db = kit.recruitmentDb();

vi.mock('../../core/db.js', () => ({ prisma: db }));

const { conversionRoutes } = await import('./conversion.routes.js');
const { HR, NOW, appAs, auditActions, useRecruitmentDb, wirePeople } = kit;

const PREFIX = '/recruitment/candidates';

/** Everything HR holds except the convert grant. */
const WITHOUT_CONVERT: Permission[] = [
  PERMISSIONS.RECRUITMENT_READ,
  PERMISSIONS.RECRUITMENT_MANAGE,
  PERMISSIONS.CANDIDATE_READ,
  PERMISSIONS.CANDIDATE_MANAGE,
  PERMISSIONS.RECRUITMENT_OFFER_MANAGE,
  PERMISSIONS.EMPLOYEE_MANAGE,
];

/** What HR confirmed on the review form. */
const CONFIRMED = {
  firstName: 'Muhammad',
  lastName: 'Ali',
  personalEmail: 'muhammad.ali@example.com',
  jobTitle: 'Senior Unity Developer',
  employmentType: 'FULL_TIME',
  employmentStatus: 'PROBATION',
  hireDate: '2026-10-01',
};

/** The candidate as the conversion endpoint selects it. */
function candidateForConvert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cand-1',
    fullName: 'Muhammad Ali',
    reference: 'CAN-0001',
    email: 'muhammad.ali@example.com',
    hiredEmployeeId: null,
    applications: [{ id: 'app-1', stage: 'OFFER', jobOpeningId: 'job-1' }],
    ...overrides,
  };
}

/** An employee row as `toDetail` reads it. Empty where the detail is a list. */
function createdEmployee(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emp-new',
    employeeNumber: 'EMP-0001',
    firstName: 'Muhammad',
    lastName: 'Ali',
    middleName: null,
    displayName: null,
    workEmail: null,
    personalEmail: 'muhammad.ali@example.com',
    phone: null,
    personalPhone: null,
    jobTitle: 'Senior Unity Developer',
    photoUrl: null,
    photoObjectKey: null,
    photoUpdatedAt: null,
    status: 'ACTIVE',
    employmentType: 'FULL_TIME',
    employmentStatus: 'PROBATION',
    hireDate: new Date('2026-10-01T00:00:00.000Z'),
    confirmationDate: null,
    nextIncrementDueDate: null,
    terminationDate: null,
    resignationDate: null,
    sourceOfHire: 'Referral',
    linkedinUrl: null,
    priorExperienceMonths: 60,
    dateOfBirth: null,
    gender: null,
    maritalStatus: null,
    nationality: null,
    bloodGroup: null,
    presentAddress: null,
    permanentAddress: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    emergencyContactRelationship: null,
    nationalId: null,
    passportNumber: null,
    passportExpiry: null,
    visaNumber: null,
    visaExpiry: null,
    bankAccountNumber: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    designation: null,
    department: null,
    team: null,
    location: null,
    manager: null,
    secondaryManager: null,
    user: null,
    workExperience: [],
    education: [],
    reports: [],
    ...overrides,
  };
}

/** An existing member of staff who looks like the candidate. */
const LOOKALIKE = {
  id: 'emp-old',
  employeeNumber: 'EMP-0042',
  firstName: 'Muhammad',
  lastName: 'Ali',
  workEmail: 'muhammad.ali@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  useRecruitmentDb(db);
  wirePeople(db);
  db.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  db.employee.create.mockResolvedValue(createdEmployee());
  db.candidate.update.mockResolvedValue({ id: 'cand-1' });
  db.candidateApplication.update.mockResolvedValue({ id: 'app-1' });
  db.candidateApplication.findMany.mockResolvedValue([{ stage: 'HIRED' }]);
  db.candidate.findUnique.mockResolvedValue({ stage: 'OFFER' });
});

describe('the proposal', () => {
  it('prefers the accepted offer, then the vacancy, then the candidate', async () => {
    db.candidate.findFirst.mockResolvedValue({
      ...candidateForConvert(),
      phone: '+92 300 1234567',
      currentTitle: 'Unity Developer',
      source: 'Referral',
      linkedinUrl: null,
      experienceYears: 5,
      applications: [
        {
          stage: 'HIRED',
          jobOpening: {
            id: 'job-1',
            title: 'Senior Unity Developer',
            departmentId: 'dept-dev',
            teamId: null,
            locationId: 'loc-lhr',
            employmentType: 'FULL_TIME',
            expectedEmploymentStatus: 'INTERNEE',
            hiringManagerId: 'emp-ahmed',
          },
        },
      ],
      offers: [
        {
          id: 'offer-1',
          status: 'ACCEPTED',
          designationId: 'desig-1',
          proposedTitle: 'Senior Unity Engineer',
          employmentType: 'FULL_TIME',
          employmentStatus: 'PROBATION',
          expectedJoiningDate: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1/conversion-preview` })
      .then((r) => r.json());

    const suggested = body.data.suggested;
    // The offer is what the candidate actually agreed to, so it outranks the
    // vacancy on every field the two both carry.
    expect(suggested.jobTitle).toBe('Senior Unity Engineer');
    expect(suggested.employmentStatus).toBe('PROBATION');
    expect(suggested.designationId).toBe('desig-1');
    // And the vacancy fills in what the offer says nothing about.
    expect(suggested.departmentId).toBe('dept-dev');
    expect(suggested.locationId).toBe('loc-lhr');
    // A candidate's address is their PERSONAL one. A work address does not
    // exist until they have a desk.
    expect(suggested.workEmail).toBeNull();
    expect(suggested.personalEmail).toBe('muhammad.ali@example.com');
    // Years on the candidate, months on the employee. Converted, not dropped.
    expect(suggested.priorExperienceMonths).toBe(60);
    expect(body.data.derivedFrom).toEqual({ offerId: 'offer-1', jobOpeningId: 'job-1' });
  });

  it('falls back to probation when neither the offer nor the vacancy said', async () => {
    db.candidate.findFirst.mockResolvedValue({
      ...candidateForConvert(),
      phone: null,
      currentTitle: null,
      source: null,
      linkedinUrl: null,
      experienceYears: null,
      applications: [],
      offers: [],
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1/conversion-preview` })
      .then((r) => r.json());

    expect(body.data.suggested.employmentStatus).toBe('PROBATION');
    expect(body.data.suggested.employmentType).toBe('FULL_TIME');
  });

  it('reports who already looks like this person, and how they matched', async () => {
    db.candidate.findFirst.mockResolvedValue({
      ...candidateForConvert(),
      phone: null,
      currentTitle: null,
      source: null,
      linkedinUrl: null,
      experienceYears: null,
      applications: [],
      offers: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.employee.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.employeeNumber) return [];
      if (args?.where?.OR) return [LOOKALIKE];
      if (args?.where?.firstName) return [LOOKALIKE, { ...LOOKALIKE, id: 'emp-other', employeeNumber: 'EMP-0050' }];
      return [];
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const body = await app
      .inject({ method: 'GET', url: `${PREFIX}/cand-1/conversion-preview` })
      .then((r) => r.json());

    // An email match is close to proof; a name match is a prompt to look. Both
    // are reported, labelled, and the stronger one wins for somebody matching
    // on both.
    expect(body.data.duplicates).toEqual([
      {
        employeeId: 'emp-old',
        employeeNumber: 'EMP-0042',
        fullName: 'Muhammad Ali',
        workEmail: 'muhammad.ali@example.com',
        matchedOn: 'EMAIL',
      },
      {
        employeeId: 'emp-other',
        employeeNumber: 'EMP-0050',
        fullName: 'Muhammad Ali',
        workEmail: 'muhammad.ali@example.com',
        matchedOn: 'NAME',
      },
    ]);
  });

  it('creates nothing', async () => {
    db.candidate.findFirst.mockResolvedValue({
      ...candidateForConvert(),
      phone: null,
      currentTitle: null,
      source: null,
      linkedinUrl: null,
      experienceYears: null,
      applications: [],
      offers: [],
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({ method: 'GET', url: `${PREFIX}/cand-1/conversion-preview` });

    expect(db.employee.create).not.toHaveBeenCalled();
    expect(db.candidate.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('creating the employee', () => {
  beforeEach(() => {
    db.candidate.findFirst.mockResolvedValue(candidateForConvert());
  });

  it('is closed to everybody but the convert grant', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: WITHOUT_CONVERT });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    expect(response.statusCode).toBe(403);
    expect(db.employee.create).not.toHaveBeenCalled();
  });

  it('writes what HR confirmed, and no login account', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    expect(response.statusCode).toBe(201);
    const data = db.employee.create.mock.calls[0]?.[0]?.data;
    expect(data.firstName).toBe('Muhammad');
    expect(data.employmentStatus).toBe('PROBATION');
    expect(data.status).toBe('ACTIVE');
    expect(data.hireDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // Section 16: an account is not created automatically. HR uses the
    // user-creation flow behind `user.manage` deliberately, afterwards.
    expect(data).not.toHaveProperty('userId');
    expect(data).not.toHaveProperty('password');
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('links the candidate back and moves only the application they were offered', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    // The back-link, in the same transaction as the employee. An employee
    // created without it is a duplicate waiting to be made on the next attempt.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const linked = db.candidate.update.mock.calls[0]?.[0];
    expect(linked.where).toEqual({ id: 'cand-1' });
    expect(linked.data.hiredEmployeeId).toBe('emp-new');
    expect(linked.data.stage).toBe('HIRED');

    // One application, not all of them: somebody hired for the Unity role is
    // not thereby hired for the Design role they also applied for.
    expect(db.candidateApplication.update).toHaveBeenCalledTimes(1);
    expect(db.candidateApplication.update.mock.calls[0]?.[0]?.where).toEqual({ id: 'app-1' });
  });

  it('leaves the other applications for HR to close off', async () => {
    db.candidate.findFirst.mockResolvedValue(
      candidateForConvert({
        applications: [
          { id: 'app-1', stage: 'OFFER', jobOpeningId: 'job-1' },
          { id: 'app-2', stage: 'INTERVIEW', jobOpeningId: 'job-2' },
        ],
      }),
    );

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    expect(db.candidateApplication.update).toHaveBeenCalledTimes(1);
    expect(db.candidateApplication.update.mock.calls[0]?.[0]?.where).toEqual({ id: 'app-1' });
  });

  it('refuses a second conversion, naming the employee they became', async () => {
    db.candidate.findFirst.mockResolvedValue(
      candidateForConvert({ hiredEmployeeId: 'emp-old' }),
    );
    db.employee.findUnique.mockResolvedValue({
      employeeNumber: 'EMP-0042',
      firstName: 'Muhammad',
      lastName: 'Ali',
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('EMP-0042');
    expect(db.employee.create).not.toHaveBeenCalled();
  });

  it('refuses while a lookalike is unacknowledged, and proceeds once it is', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.employee.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.employeeNumber) return [];
      if (args?.where?.OR || args?.where?.firstName) return [LOOKALIKE];
      return [];
    });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });

    const refused = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('EMP-0042');
    expect(db.employee.create).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: { ...CONFIRMED, acknowledgeDuplicates: true },
    });
    expect(allowed.statusCode).toBe(201);
    expect(db.employee.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create.mock.calls[0]?.[0]?.data.after.duplicatesAcknowledged).toBe(true);
  });

  /*
   * The duplicate check is re-run at the moment of writing rather than trusted
   * from the preview: a preview taken ten minutes ago says nothing about the
   * employee somebody else created five minutes ago.
   */
  it('re-runs the duplicate check at the moment of writing', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    const lookups = db.employee.findMany.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0]?.where?.OR || call[0]?.where?.firstName,
    );
    expect(lookups.length).toBeGreaterThan(0);
  });

  /*
   * PERMANENT means somebody was confirmed, and confirming somebody means
   * saying when. The employee module already refuses a permanent record with no
   * confirmation date; recruitment must not become a back door to one.
   */
  it('refuses a new hire who starts as permanent', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: { ...CONFIRMED, employmentStatus: 'PERMANENT' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.employmentStatus).toBeDefined();
    expect(db.employee.create).not.toHaveBeenCalled();
  });

  it('refuses an employee number somebody already has', async () => {
    db.employee.findFirst.mockResolvedValue({ id: 'emp-old' });

    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    const response = await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: { ...CONFIRMED, employeeNumber: 'EMP-0042' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.employeeNumber).toBeDefined();
    expect(db.employee.create).not.toHaveBeenCalled();
  });

  it('records the conversion, including that no login was created', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    expect(auditActions(db)).toEqual(['candidate.converted_to_employee']);
    const after = db.auditLog.create.mock.calls[0]?.[0]?.data.after;
    expect(after.loginCreated).toBe(false);
    expect(after.candidateId).toBe('cand-1');
    expect(after.employeeId).toBe('emp-new');
  });

  /** No salary, no payroll profile, no contract. The offer's figure stays put. */
  it('writes nothing about money', async () => {
    const app = await appAs(conversionRoutes, { prefix: PREFIX, permissions: HR });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/cand-1/convert`,
      payload: CONFIRMED,
    });

    const data = db.employee.create.mock.calls[0]?.[0]?.data;
    for (const key of ['salary', 'grossSalary', 'basicSalary', 'payrollProfile', 'contract']) {
      expect(data).not.toHaveProperty(key);
    }
    expect(db.offer.update).not.toHaveBeenCalled();
  });
});
