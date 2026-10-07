import { describe, expect, it, vi } from 'vitest';

vi.mock('../../core/db.js', () => ({ prisma: {} }));

const { correctionNotice, correctionTypeLabel } = await import('./correction-notice.js');
const { approverNotice } = await import('../../core/approvals/approval.service.js');

const KHI = 'Asia/Karachi';
/** A Karachi wall-clock time on 5 Oct 2026, as the instant it is. */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 5, h! - 5, m!));
};

const base = {
  employeeName: 'Hassan Ali',
  dayKey: '2026-10-05',
  timeZone: KHI,
  issueType: 'MISSING_PUNCH' as const,
  current: { checkInAt: at('09:01'), checkOutAt: null },
  requestedCheckInAt: null,
  requestedCheckOutAt: at('18:02'),
  requestedStatusLabel: null,
  reason: 'Forgot to punch out',
};

describe('the attendance correction notice', () => {
  it('reads like the example: a missing check-out', () => {
    expect(correctionNotice(base)).toEqual({
      title: 'Attendance Correction Request: Hassan Ali, 05-Oct-2026',
      summary: [
        'Employee: Hassan Ali',
        'Date: 05-Oct-2026',
        'Correction: Missing check-out',
        'Current: Missing',
        'Requested: 06:02 PM',
        'Reason: Forgot to punch out',
      ].join('\n'),
    });
  });

  it('labels both ends when both are asked for', () => {
    const { summary } = correctionNotice({
      ...base,
      current: null,
      requestedCheckInAt: at('09:00'),
      requestedCheckOutAt: at('18:00'),
    });
    expect(summary).toContain('Correction: Missing check-in and check-out');
    expect(summary).toContain('Current: Check-in Missing · Check-out Missing');
    expect(summary).toContain('Requested: Check-in 09:00 AM · Check-out 06:00 PM');
  });

  it('a status request with no times shows what is on record and the status asked for', () => {
    const { summary } = correctionNotice({
      ...base,
      issueType: 'OTHER',
      current: { checkInAt: at('09:01'), checkOutAt: at('17:00') },
      requestedCheckOutAt: null,
      requestedStatusLabel: 'Present',
    });
    expect(summary).toContain('Correction: Other attendance issue');
    expect(summary).toContain('Current: Check-in 09:01 AM · Check-out 05:00 PM');
    expect(summary).toContain('Requested: Status Present');
  });

  it('names the end even when no issue type was chosen', () => {
    expect(
      correctionTypeLabel({ issueType: null, requestedCheckInAt: at('09:00'), requestedCheckOutAt: null }),
    ).toBe('Check-in');
  });
});

describe('the approver notification', () => {
  it('a correction carries its whole summary under its own title', () => {
    expect(
      approverNotice({ subjectType: 'ATTENDANCE_REGULARIZATION', title: 't', summary: 'Employee: X\nDate: Y' }),
    ).toEqual({ title: 'Attendance Correction Request', message: 'Employee: X\nDate: Y' });
  });

  it('every other subject keeps the notice it always had', () => {
    expect(approverNotice({ subjectType: 'LEAVE_REQUEST', title: 'Annual leave, 2 days', summary: 'x' })).toEqual({
      title: 'Approval needed',
      message: 'Annual leave, 2 days',
    });
  });
});
