import { describe, expect, it } from 'vitest';
import {
  buildPushContent,
  pushCategory,
  PUSH_TEST_ENTITY,
  type PushApprovalContext,
  type PushSourceNotification,
} from './push-content.js';

/**
 * What a browser push puts on a lock screen.
 *
 * The in-app message is read after signing in; a push is read by whoever is
 * near the phone. These pin the allow-list: the notification kinds that get a
 * summarised body say exactly what they are allowed to, and the sensitive
 * ones - money, medical, case subjects, candidates, free-text reasons - never
 * reach the payload however the in-app text is worded.
 */

function note(overrides: Partial<PushSourceNotification>): PushSourceNotification {
  return {
    id: 'n-1',
    type: 'SYSTEM',
    title: 'Something happened',
    message: 'Details that may be private.',
    entityType: null,
    entityId: null,
    ...overrides,
  };
}

const approval = (overrides: Partial<PushApprovalContext>): PushApprovalContext => ({
  subjectType: 'LEAVE_REQUEST',
  title: 'Casual Leave: 2026-10-06 to 2026-10-06 (1 day)',
  summary: null,
  requesterName: 'Hira Javed',
  ...overrides,
});

const CORRECTION_SUMMARY = [
  'Employee: Hassan Ali',
  'Date: 5 Oct 2026',
  'Correction: Check-out',
  'Current: Missing',
  'Requested: 06:02 PM',
  'Reason: Doctor appointment for my chronic condition',
].join('\n');

describe('the push an approver receives', () => {
  it('names the employee, the day and the requested time of an attendance correction - not the reason', () => {
    const push = buildPushContent(
      note({ type: 'APPROVAL_REQUESTED', title: 'Attendance Correction Request', message: CORRECTION_SUMMARY, entityType: 'ApprovalRequest', entityId: 'a-1' }),
      approval({ subjectType: 'ATTENDANCE_REGULARIZATION', summary: CORRECTION_SUMMARY, requesterName: 'Hassan Ali' }),
    );

    expect(push).toMatchObject({
      category: 'ATTENDANCE',
      title: 'Attendance Correction Requires Review',
      body: 'Hassan Ali — 5 Oct 2026 — Check-out correction requested for 06:02 PM.',
      tag: 'ApprovalRequest:a-1',
    });
    expect(JSON.stringify(push)).not.toMatch(/Doctor|chronic|Reason/);
  });

  it('says who asked for which leave', () => {
    const push = buildPushContent(
      note({ type: 'APPROVAL_REQUESTED', title: 'Approval needed', entityType: 'ApprovalRequest', entityId: 'a-2' }),
      approval({}),
    );
    expect(push).toMatchObject({
      category: 'LEAVE',
      title: 'Leave Approval Required',
      body: 'Hira Javed requested Casual Leave: 2026-10-06 to 2026-10-06 (1 day).',
    });
  });

  it('never carries the amount of a salary advance or a loan', () => {
    const push = buildPushContent(
      note({ type: 'APPROVAL_REQUESTED', title: 'Approval needed', message: 'Salary advance: PKR 50000, recovered from 2026-11 pay', entityType: 'ApprovalRequest', entityId: 'a-3' }),
      approval({ subjectType: 'LOAN_REQUEST', title: 'Salary advance: PKR 50000, recovered from 2026-11 pay', summary: 'Medical bills for my mother' }),
    );
    expect(push).toMatchObject({ category: 'PAYROLL', body: 'Hira Javed submitted a salary advance request.' });
    expect(JSON.stringify(push)).not.toMatch(/50000|PKR|Medical|mother/);
  });

  it("does not push the approver's comment back to the requester", () => {
    const push = buildPushContent(
      note({ type: 'APPROVAL_REJECTED', title: 'Request rejected', message: 'Casual Leave - you were warned about this already', entityType: 'ApprovalRequest', entityId: 'a-2' }),
      approval({}),
    );
    expect(push?.body).toBe('Casual Leave: 2026-10-06 to 2026-10-06 (1 day) — rejected.');
    expect(push?.body).not.toMatch(/warned/);
  });

  it('keeps a loan decision free of figures too', () => {
    const push = buildPushContent(
      note({ type: 'APPROVAL_APPROVED', title: 'Request approved', entityType: 'ApprovalRequest', entityId: 'a-3' }),
      approval({ subjectType: 'LOAN_REQUEST', title: 'Loan: PKR 200000 over 10 months' }),
    );
    expect(push?.body).toBe('The loan request was approved.');
  });
});

describe('sensitive kinds get a generic body', () => {
  it.each([
    ['a medical claim', note({ type: 'APPROVAL_REQUESTED', title: 'Medical claim to review', message: 'Hassan Ali - PKR 12,000 - chemotherapy', entityType: 'MedicalClaim', entityId: 'm-1' }), 'Medical claim update'],
    ['a payslip', note({ title: 'Your payslip is ready', message: 'Net pay PKR 180,000', entityType: 'Payslip', entityId: 'p-1' }), 'Your payslip is ready'],
    ['a released advance', note({ title: 'Your salary advance has been released', message: 'PKR 50000 - recovered in full', entityType: 'EmployeeLoan', entityId: 'l-1' }), 'Your salary advance has been released'],
    ['a payroll run', note({ type: 'APPROVAL_REQUESTED', title: 'Payroll run ready for approval', message: 'October: net 9,400,000', entityType: 'PayrollRun', entityId: 'r-1' }), 'Payroll run ready for approval'],
  ])('%s', (_label, source, title) => {
    const push = buildPushContent(source);
    expect(push?.title).toBe(title);
    expect(push?.body).toBe('Open HRMS to view it.');
    expect(push?.category).toBe(source.entityType === 'MedicalClaim' ? 'GENERAL' : 'PAYROLL');
  });

  it('keeps a case subject in the app - the title says which case and what happened', () => {
    const push = buildPushContent(
      note({ type: 'CASE_UPDATE', title: 'Case CASE-2026-000016 assigned to you', message: 'Harassment complaint against my manager - high priority', entityType: 'CaseDesk', entityId: 'c-1' }),
    );
    expect(push).toMatchObject({ category: 'CASES', title: 'Case CASE-2026-000016 assigned to you', body: 'Open HRMS to view it.' });
  });

  it("drops the candidate's name from an interview title", () => {
    const push = buildPushContent(
      note({ type: 'INTERVIEW_SCHEDULED', title: 'Interview scheduled: Jane Candidate', entityType: 'Interview', entityId: 'i-1' }),
    );
    expect(push?.title).toBe('Interview scheduled');
    expect(JSON.stringify(push)).not.toMatch(/Jane/);
  });

  it('does not push a password reset at all', () => {
    expect(buildPushContent(note({ type: 'PASSWORD_RESET', title: 'Password reset requested' }))).toBeNull();
  });

  it('gives anything it does not recognise only its title', () => {
    expect(buildPushContent(note({ entityType: 'SomethingNew', entityId: 'x' }))?.body).toBe('Open HRMS to view it.');
  });
});

describe('a case mention', () => {
  const mention = note({
    type: 'CASE_MENTION',
    title: 'You were mentioned in a case',
    message:
      'Zohaib Saleem mentioned you in CASE-2026-000029 (Medical reimbursement - chemotherapy): "Please process the approved PKR 85,000 reimbursement."',
    entityType: 'CaseDesk',
    entityId: 'case-29',
  });

  it('says who tagged you and which case - never the subject or the comment', () => {
    const push = buildPushContent(mention);
    expect(push).toMatchObject({
      category: 'CASES',
      title: 'You were mentioned in CASE-2026-000029',
      body: 'Zohaib Saleem mentioned you. Open HRMS to view it.',
    });
    expect(JSON.stringify(push)).not.toMatch(/chemotherapy|85,000|reimbursement/i);
  });

  it('falls back to the bare title when the message is not in the expected shape', () => {
    const push = buildPushContent({ ...mention, message: 'Medical: chemotherapy' });
    expect(push).toMatchObject({ title: 'You were mentioned in a case', body: 'Open HRMS to view it.' });
  });

  it('is muted with the other case notifications', () => {
    expect(pushCategory({ type: 'CASE_MENTION', entityType: 'Case' })).toBe('CASES');
  });
});

describe('assets', () => {
  it('names the tag, the asset and the kind of fault for IT', () => {
    const push = buildPushContent(
      note({
        title: 'Asset Issue Reported',
        message: 'Employee: Ahmed Raza\nAsset: Dell Latitude 5420\nAsset Tag: DXT-GE-013\nIssue: Not working',
        entityType: 'AssetIncident',
        entityId: 'inc-1',
      }),
    );
    expect(push).toMatchObject({
      category: 'ASSETS',
      title: 'Asset Issue Reported',
      body: 'DXT-GE-013 — Dell Latitude 5420 reported: Not working',
    });
  });

  it('passes an issued-asset notice through: it names only the asset', () => {
    const push = buildPushContent(
      note({ title: 'You have received a company asset', message: 'Dell Latitude (DXT-GE-013) has been issued to you. Please confirm you have it.', entityType: 'Asset', entityId: 'a' }),
    );
    expect(push?.body).toContain('Please confirm');
  });
});

describe('categories', () => {
  it.each([
    [{ type: 'CASE_UPDATE', entityType: 'Case' }, null, 'CASES'],
    [{ type: 'SYSTEM', entityType: 'AssetRequest' }, null, 'ASSETS'],
    [{ type: 'APPROVAL_REQUESTED', entityType: 'ApprovalRequest' }, { subjectType: 'TIMESHEET' }, 'ATTENDANCE'],
    [{ type: 'APPROVAL_REQUESTED', entityType: 'ApprovalRequest' }, { subjectType: 'ASSET_REQUEST' }, 'ASSETS'],
    [{ type: 'CELEBRATION', entityType: 'MomentGreeting' }, null, 'GENERAL'],
    [{ type: 'SYSTEM', entityType: PUSH_TEST_ENTITY }, null, 'TEST'],
  ] as const)('%o -> %s', (source, approvalContext, expected) => {
    expect(pushCategory(source, approvalContext)).toBe(expected);
  });
});

describe('length', () => {
  it('clips a long title and body for the notification tray', () => {
    const push = buildPushContent(note({ type: 'CELEBRATION', title: 'T'.repeat(200), message: 'B '.repeat(300) }));
    expect(push!.title.length).toBeLessThanOrEqual(80);
    expect(push!.body.length).toBeLessThanOrEqual(180);
    expect(push!.body.endsWith('…')).toBe(true);
  });
});
