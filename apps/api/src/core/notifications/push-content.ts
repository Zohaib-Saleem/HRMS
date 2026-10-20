import type { PushCategory } from '@hrms/shared';

/**
 * What a browser push says, and which category it is muted under.
 *
 * A push is shown on a lock screen, to whoever is near the device, so it is
 * NOT the in-app message copied across. The in-app message is read after
 * signing in; a push is read before. The rule here is an allow-list: a body
 * is built only for the kinds of notification known to be safe to summarise,
 * and everything else gets its title and a generic line. A new notification
 * somebody adds later therefore starts out private, not exposed.
 *
 * Never on a lock screen: money amounts (loans, advances, payslips), medical
 * anything, case subjects (free text, and an HR case's subject can be the
 * whole confidential matter), interview candidates' names, approver comments, and the
 * reason on an attendance correction.
 *
 * Pure: no database, no clock. The caller looks up the approval a notification
 * is about, because the subject type decides both category and wording.
 */

export interface PushSourceNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
}

/** The approval request an `ApprovalRequest` notification points at. */
export interface PushApprovalContext {
  subjectType: string;
  title: string;
  summary: string | null;
  requesterName: string | null;
}

export interface PushContent {
  category: PushCategory | 'TEST';
  title: string;
  body: string;
  /**
   * Lets the browser replace an earlier push about the same record rather than
   * stacking a second one beside it.
   */
  tag: string;
}

/** Entity type of the test push sent from the profile screen. Never muted. */
export const PUSH_TEST_ENTITY = 'PushTest';

const GENERIC_BODY = 'Open HRMS to view it.';
const TITLE_MAX = 80;
const BODY_MAX = 180;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function content(
  source: PushSourceNotification,
  category: PushContent['category'],
  title: string,
  body: string,
): PushContent {
  const tag =
    source.entityType && source.entityId
      ? `${source.entityType}:${source.entityId}`
      : `notification:${source.id}`;
  return { category, title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), tag };
}

/** Which push category a notification belongs to. */
export function pushCategory(
  source: Pick<PushSourceNotification, 'type' | 'entityType'>,
  approval?: Pick<PushApprovalContext, 'subjectType'> | null,
): PushContent['category'] {
  if (source.entityType === PUSH_TEST_ENTITY) return 'TEST';
  if (source.type === 'CASE_UPDATE' || source.type === 'CASE_MENTION') return 'CASES';
  switch (source.entityType) {
    case 'Case':
    case 'CaseDesk':
      return 'CASES';
    case 'Asset':
    case 'AssetIncident':
    case 'AssetRequest':
      return 'ASSETS';
    case 'Payslip':
    case 'PayrollRun':
    case 'EmployeeLoan':
      return 'PAYROLL';
    case 'ApprovalRequest':
      switch (approval?.subjectType) {
        case 'ATTENDANCE_REGULARIZATION':
        case 'SHIFT_CHANGE':
        case 'TIMESHEET':
          return 'ATTENDANCE';
        case 'LEAVE_REQUEST':
          return 'LEAVE';
        case 'LOAN_REQUEST':
          return 'PAYROLL';
        case 'ASSET_REQUEST':
          return 'ASSETS';
        default:
          return 'GENERAL';
      }
    default:
      return 'GENERAL';
  }
}

/** "Salary advance" or "Loan", read off the approval's own title. */
function loanKind(approval: PushApprovalContext | null | undefined): string {
  return approval?.title.startsWith('Salary advance') ? 'salary advance' : 'loan';
}

/**
 * The lock-screen lines of an attendance correction: who, which day, and what
 * is being asked for. The reason is left out - it is free text.
 */
function correctionBody(summary: string | null, fallbackName: string | null): string | null {
  if (!summary) return null;
  const field = (label: string) =>
    summary
      .split('\n')
      .find((line) => line.startsWith(`${label}: `))
      ?.slice(label.length + 2)
      .trim() ?? null;
  const employee = field('Employee') ?? fallbackName;
  const date = field('Date');
  const correction = field('Correction');
  const requested = field('Requested');
  if (!employee || !date) return null;
  const ask =
    correction && requested && requested !== 'See reason'
      ? `${correction} correction requested for ${requested}.`
      : correction
        ? `${correction} correction requested.`
        : 'Correction requested.';
  return `${employee} — ${date} — ${ask}`;
}

/**
 * The push for one notification, or null when it should not be pushed at all.
 *
 * Password resets are not pushed: the request comes from somebody who is not
 * signed in, and the email is the channel that matters.
 */
export function buildPushContent(
  source: PushSourceNotification,
  approval?: PushApprovalContext | null,
): PushContent | null {
  if (source.type === 'PASSWORD_RESET') return null;

  const category = pushCategory(source, approval);
  const who = approval?.requesterName ?? 'A colleague';

  if (category === 'TEST') return content(source, category, source.title, source.message);

  if (source.entityType === 'ApprovalRequest' && approval) {
    const subject = approval.subjectType;

    if (source.type === 'APPROVAL_REQUESTED') {
      switch (subject) {
        case 'ATTENDANCE_REGULARIZATION':
          return content(
            source,
            category,
            'Attendance Correction Requires Review',
            correctionBody(approval.summary, approval.requesterName) ??
              `${who} requested an attendance correction.`,
          );
        case 'LEAVE_REQUEST':
          return content(source, category, 'Leave Approval Required', `${who} requested ${approval.title}.`);
        case 'LOAN_REQUEST':
          return content(
            source,
            category,
            'Approval Required',
            `${who} submitted a ${loanKind(approval)} request.`,
          );
        case 'ASSET_REQUEST':
          return content(source, category, 'Equipment Request Approval Required', `${who} — ${approval.title}`);
        default:
          return content(source, category, 'Approval Required', `${who} — ${approval.title}`);
      }
    }

    if (
      source.type === 'APPROVAL_APPROVED' ||
      source.type === 'APPROVAL_REJECTED' ||
      source.type === 'APPROVAL_CANCELLED'
    ) {
      const outcome =
        source.type === 'APPROVAL_APPROVED'
          ? 'approved'
          : source.type === 'APPROVAL_REJECTED'
            ? 'rejected'
            : 'withdrawn';
      // The approver's comment is never pushed; it can say anything.
      const body =
        subject === 'LOAN_REQUEST'
          ? `The ${loanKind(approval)} request was ${outcome}.`
          : `${approval.title} — ${outcome}.`;
      return content(source, category, source.title, body);
    }
  }

  switch (source.entityType) {
    // Asset notifications name the asset, its tag and the kind of fault -
    // what IT needs to triage - and are built without the reporter's free text.
    case 'AssetIncident': {
      const lines = source.message.split('\n');
      const value = (label: string) =>
        lines.find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2).trim();
      const tag = value('Asset Tag');
      const asset = value('Asset');
      const issue = value('Issue');
      const body =
        tag && asset ? `${tag} — ${asset}${issue ? ` reported: ${issue}` : ' reported.'}` : GENERIC_BODY;
      return content(source, category, source.title, body);
    }
    case 'Asset':
    case 'AssetRequest':
      return content(source, category, source.title, source.message);
    // Titles here are written for this purpose and carry no amounts.
    case 'Payslip':
    case 'PayrollRun':
    case 'EmployeeLoan':
      return content(source, category, source.title, GENERIC_BODY);
    case 'MedicalClaim':
      return content(source, category, 'Medical claim update', GENERIC_BODY);
    default:
      break;
  }

  if (source.type === 'CELEBRATION') return content(source, category, source.title, source.message);

  /*
   * A mention names who tagged you and which case - both already on every
   * desk push - and stops there. The in-app message goes on to quote the
   * case's subject and the comment itself, and either can be the whole of a
   * medical or salary matter, so neither is put on a lock screen.
   */
  if (source.type === 'CASE_MENTION') {
    const lead = /^(.{1,80}?) mentioned you in (CASE-\d{4}-\d+)/.exec(source.message);
    return content(
      source,
      category,
      lead ? `You were mentioned in ${lead[2]}` : source.title,
      lead ? `${lead[1]} mentioned you. ${GENERIC_BODY}` : GENERIC_BODY,
    );
  }

  // "Interview scheduled: <candidate>" - the candidate is not ours to show.
  if (source.type.startsWith('INTERVIEW_')) {
    return content(source, category, source.title.split(':')[0]!, GENERIC_BODY);
  }

  // Cases: the title says which case and what happened; the subject stays in
  // the app. Interviews and anything unrecognised: title only.
  return content(source, category, source.title, GENERIC_BODY);
}
