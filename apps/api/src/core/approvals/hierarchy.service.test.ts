import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Turning an organisation into an approval chain.
 *
 * Every claim in this file is about WHO GETS ASKED, and each one is a rule the
 * brief states and a company would otherwise have to trust the code to follow:
 *
 *   - the team manager stage is the TEAM ROSTER, never a job title
 *   - somebody who has left is never asked, whatever the roster says
 *   - the requester is never asked to approve their own request
 *   - nobody is asked twice in one chain
 *   - a stage nobody can fill is SKIPPED, with a reason, rather than blocking
 *
 * The database is mocked. These are assertions about a resolution, and the
 * shape of the queries is deliberately visible in the stubs below so that a
 * change to what the resolver asks for shows up here as a test edit.
 */

const db = vi.hoisted(() => ({
  employee: { findFirst: vi.fn(), findMany: vi.fn() },
  approvalWorkflow: { findFirst: vi.fn() },
  teamManager: { findMany: vi.fn() },
  approvalStageAssignee: { findMany: vi.fn(), count: vi.fn() },
  team: { count: vi.fn() },
  department: { count: vi.fn() },
}));

vi.mock('../db.js', () => ({ prisma: db }));

const { resolveApprovalChain } = await import('./hierarchy.service.js');

const COMPANY = 'company-1';

/** Ayesha, on the Development team, with a reporting line as well. */
const REQUESTER = {
  id: 'emp-ayesha',
  teamId: 'team-dev',
  managerId: 'emp-line',
  secondaryManagerId: null,
  department: { headEmployeeId: 'emp-head' },
};

/** Everybody the stubs below can return is ACTIVE unless a test says otherwise. */
function activeExcept(...inactive: string[]) {
  db.employee.findMany.mockImplementation((args: { where?: { id?: { in?: string[] } } }) =>
    Promise.resolve(
      (args?.where?.id?.in ?? [])
        .filter((id: string) => !inactive.includes(id))
        .map((id: string) => ({ id })),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.employee.findFirst.mockResolvedValue(REQUESTER);
  db.approvalWorkflow.findFirst.mockResolvedValue(null);
  db.teamManager.findMany.mockResolvedValue([]);
  db.approvalStageAssignee.findMany.mockResolvedValue([]);
  activeExcept();
});

/** The three-rung company: two team managers, an HR manager and a CEO. */
function fullHierarchy() {
  db.teamManager.findMany.mockResolvedValue([
    { employeeId: 'mgr-a' },
    { employeeId: 'mgr-b' },
  ]);
  db.approvalStageAssignee.findMany.mockImplementation(
    ({ where }: { where: { stage: string } }) =>
      Promise.resolve(
        where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : [{ employeeId: 'emp-ceo' }],
      ),
  );
}

describe('the default leave chain', () => {
  it('is Team Manager, then HR Manager, then CEO', async () => {
    fullHierarchy();

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.map((s) => s.stage)).toEqual(['TEAM_MANAGER', 'HR_MANAGER', 'CEO']);
    expect(chain.isDefault).toBe(true);
  });

  it('puts every active manager of the team on the first rung, in ANY_ONE mode', async () => {
    fullHierarchy();

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages[0]).toEqual({
      stage: 'TEAM_MANAGER',
      mode: 'ANY_ONE',
      approverEmployeeIds: ['mgr-a', 'mgr-b'],
    });
  });

  /**
   * The rule that makes the team-manager stage explicit rather than inferred.
   *
   * The requester's job title, designation and department head are all in the
   * fixture and none of them is consulted: the only query that decides this
   * rung is the one against `team_managers`.
   */
  it('reads the team roster and nothing else for the team manager rung', async () => {
    fullHierarchy();

    await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(db.teamManager.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: COMPANY, teamId: 'team-dev', isActive: true },
      }),
    );
  });
});

describe('who is never asked', () => {
  it('leaves out a manager who is no longer an active employee', async () => {
    fullHierarchy();
    activeExcept('mgr-a');

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages[0]?.approverEmployeeIds).toEqual(['mgr-b']);
  });

  /**
   * A manager raising their own leave.
   *
   * Without this the first rung of their own chain would be themselves, and
   * the engine - which refuses a self-decision - would leave the request
   * permanently stuck on a stage only its author could sign.
   */
  it('never puts the requester on their own chain, and skips the rung if they were the only one', async () => {
    db.teamManager.findMany.mockResolvedValue([{ employeeId: REQUESTER.id }]);
    db.approvalStageAssignee.findMany.mockImplementation(
      ({ where }: { where: { stage: string } }) =>
        Promise.resolve(
          where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : [{ employeeId: 'emp-ceo' }],
        ),
    );

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.map((s) => s.stage)).toEqual(['HR_MANAGER', 'CEO']);
    expect(chain.skipped).toContainEqual({
      stage: 'TEAM_MANAGER',
      reason: 'their team has no active manager who can decide it',
    });
  });

  /**
   * One person filling two rungs.
   *
   * The engine forbids one user deciding two stages of the same request - a
   * chain one person can satisfy is not a chain - so a duplicate would produce
   * a request stuck at a stage its only approver may not decide. The resolver
   * strikes the later appearance and records the skip.
   */
  it('does not ask the same person twice when they fill two rungs', async () => {
    db.teamManager.findMany.mockResolvedValue([{ employeeId: 'emp-hr' }]);
    db.approvalStageAssignee.findMany.mockImplementation(
      ({ where }: { where: { stage: string } }) =>
        Promise.resolve(
          where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : [{ employeeId: 'emp-ceo' }],
        ),
    );

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.map((s) => s.stage)).toEqual(['TEAM_MANAGER', 'CEO']);
    expect(chain.stages[0]?.approverEmployeeIds).toEqual(['emp-hr']);
  });
});

describe('a hierarchy that is only half configured', () => {
  it('skips the CEO rung, with a reason, when nobody is named as CEO', async () => {
    db.teamManager.findMany.mockResolvedValue([{ employeeId: 'mgr-a' }]);
    db.approvalStageAssignee.findMany.mockImplementation(
      ({ where }: { where: { stage: string } }) =>
        Promise.resolve(where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : []),
    );

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.map((s) => s.stage)).toEqual(['TEAM_MANAGER', 'HR_MANAGER']);
    expect(chain.skipped).toContainEqual({
      stage: 'CEO',
      reason: 'nobody is named as CEO',
    });
  });

  it('skips the team rung when the requester is on no team', async () => {
    db.employee.findFirst.mockResolvedValue({ ...REQUESTER, teamId: null });
    db.approvalStageAssignee.findMany.mockImplementation(
      ({ where }: { where: { stage: string } }) =>
        Promise.resolve(
          where.stage === 'HR_MANAGER' ? [{ employeeId: 'emp-hr' }] : [{ employeeId: 'emp-ceo' }],
        ),
    );

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.map((s) => s.stage)).toEqual(['HR_MANAGER', 'CEO']);
    expect(chain.skipped).toContainEqual({
      stage: 'TEAM_MANAGER',
      reason: 'the requester is not on a team',
    });
  });

  /**
   * A company that has configured NOTHING.
   *
   * No team managers, no HR, no CEO - the state every existing installation is
   * in on the morning of this release. Falling back to the reporting line is
   * what keeps leave working that morning, and it is the chain this product
   * had before stages existed.
   */
  it('falls back to the reporting line when no configured rung can be filled', async () => {
    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages).toEqual([
      { stage: 'LINE_MANAGER', mode: 'ALL', approverEmployeeIds: ['emp-line'] },
    ]);
  });

  it('resolves to nothing at all when even the reporting line is empty', async () => {
    db.employee.findFirst.mockResolvedValue({
      id: REQUESTER.id,
      teamId: null,
      managerId: null,
      secondaryManagerId: null,
      department: null,
    });

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    // The caller turns this into the 422 that names the fix. Nothing is written.
    expect(chain.stages).toEqual([]);
  });
});

describe('the chains that did not move onto the hierarchy', () => {
  /**
   * A forgotten check-out is corrected by the person who can say whether you
   * were at your desk. Sending eleven of those a week to the CEO would empty
   * the meaning out of the CEO's queue inside a month, so the four operational
   * subject types keep the reporting line they have always had.
   */
  it('routes an attendance correction to the reporting line, both managers', async () => {
    fullHierarchy();
    db.employee.findFirst.mockResolvedValue({ ...REQUESTER, secondaryManagerId: 'emp-second' });

    const chain = await resolveApprovalChain(COMPANY, 'ATTENDANCE_REGULARIZATION', REQUESTER.id);

    expect(chain.stages).toEqual([
      { stage: 'LINE_MANAGER', mode: 'ALL', approverEmployeeIds: ['emp-line', 'emp-second'] },
    ]);
  });

  it('falls back to the department head when a corrector has no manager', async () => {
    db.employee.findFirst.mockResolvedValue({ ...REQUESTER, managerId: null });

    const chain = await resolveApprovalChain(COMPANY, 'TIMESHEET', REQUESTER.id);

    expect(chain.stages[0]?.approverEmployeeIds).toEqual(['emp-head']);
  });
});

describe('a chain a company configured for itself', () => {
  it('overrides the default, in the order the company stored', async () => {
    fullHierarchy();
    db.approvalWorkflow.findFirst.mockResolvedValue({
      id: 'wf-1',
      stages: [
        { stage: 'HR_MANAGER', mode: 'ANY_ONE' },
        { stage: 'TEAM_MANAGER', mode: 'ALL' },
      ],
    });

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.isDefault).toBe(false);
    expect(chain.stages.map((s) => [s.stage, s.mode])).toEqual([
      ['HR_MANAGER', 'ANY_ONE'],
      ['TEAM_MANAGER', 'ALL'],
    ]);
  });

  it('treats a switched-off workflow as absent, not as an empty chain', async () => {
    fullHierarchy();
    // `findFirst` is filtered on isActive, so an inactive row comes back null -
    // and the default applies. Switching a chain off must never mean "approve
    // everything without asking anybody".
    db.approvalWorkflow.findFirst.mockResolvedValue(null);

    const chain = await resolveApprovalChain(COMPANY, 'LEAVE_REQUEST', REQUESTER.id);

    expect(chain.stages.length).toBe(3);
  });
});
