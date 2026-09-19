import type { FastifyRequest } from 'fastify';
import {
  INTERVIEW_ROUND_LABELS,
  INTERVIEW_TYPE_LABELS,
  type InterviewRound,
  type InterviewType,
} from '@hrms/shared';
import { notify, type EmailDeliveryStatus } from '../../core/notifications/notification.service.js';

/**
 * Telling an interview panel what has happened to their appointment.
 *
 * This is a thin adapter over the notification service the HRMS already has -
 * `core/notifications/notification.service.ts` - and deliberately nothing more.
 * No transport, no template engine, no queue and no second inbox: the in-app
 * notification is written to the same `notifications` table every other module
 * writes to, and the email half goes out through the same provider resolution
 * that leave, approvals and password resets use. Configuring SMTP later changes
 * nothing in this file.
 *
 * The one thing it is careful about is section 21's honesty rule. The service
 * reports FOUR possible outcomes for the email half and they are not
 * interchangeable:
 *
 *   skipped     - there was no address to write to.
 *   delivered   - a real transport accepted the message.
 *   unconfirmed - it went to a transport that logs and drops. The console
 *                 provider is always this.
 *   failed      - the transport threw.
 *
 * Only `delivered` is an email. Everything here passes that answer through
 * untouched so the UI can say "3 people notified in the app; email was not
 * delivered because mail is not configured" instead of a cheerful "invitations
 * sent" that is false on every installation running the console provider.
 *
 * An interviewer with no login account is skipped silently rather than failing
 * the request. Not everybody in an HRMS has a login, a notification is not the
 * point of scheduling an interview, and a panel of three where one person is
 * unreachable should still produce the interview.
 */

export type PanelNoticeKind =
  | 'SCHEDULED'
  | 'RESCHEDULED'
  | 'CANCELLED'
  | 'REMINDER'
  | 'EVALUATION_PENDING';

export interface PanelNoticeInput {
  kind: PanelNoticeKind;
  companyId: string;
  interviewId: string;
  candidateName: string;
  jobTitle: string | null;
  type: InterviewType;
  round: InterviewRound;
  startsAt: Date;
  timezone: string;
  /** Present on a reschedule, so the message can name both times. */
  previousStartsAt?: Date;
  previousTimezone?: string;
  reason?: string;
  interviewers: ReadonlyArray<{
    id: string;
    fullName: string;
    userId: string | null;
    workEmail: string | null;
  }>;
}

export interface PanelNotice {
  /** In-app notifications actually written. Durable, and the real answer. */
  notified: number;
  /** The transport's own verdict, never flattened into "sent". */
  emailStatus: EmailDeliveryStatus;
  /** Which transport handled it. Never a host, a username or a credential. */
  emailProvider: string | null;
  /** Panellists with no login account, who could not be told in-app. */
  unreachable: string[];
}

const NOTIFICATION_TYPES: Record<
  PanelNoticeKind,
  'INTERVIEW_SCHEDULED' | 'INTERVIEW_RESCHEDULED' | 'INTERVIEW_CANCELLED' | 'INTERVIEW_REMINDER' | 'INTERVIEW_EVALUATION_PENDING'
> = {
  SCHEDULED: 'INTERVIEW_SCHEDULED',
  RESCHEDULED: 'INTERVIEW_RESCHEDULED',
  CANCELLED: 'INTERVIEW_CANCELLED',
  REMINDER: 'INTERVIEW_REMINDER',
  EVALUATION_PENDING: 'INTERVIEW_EVALUATION_PENDING',
};

/**
 * The appointment as a person reads it, in the zone it was arranged in.
 *
 * Formatted in the interview's OWN timezone rather than the server's or the
 * reader's, because "10:00 AM" is what the panel agreed to and rewriting it
 * into a panellist's local time on a notification is how somebody arrives an
 * hour late believing they were early.
 */
function formatWhen(at: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
  return `${formatted} (${timeZone})`;
}

function buildMessage(input: PanelNoticeInput): { title: string; message: string } {
  const what = `${INTERVIEW_TYPE_LABELS[input.type]} - ${INTERVIEW_ROUND_LABELS[input.round]}`;
  const who = input.jobTitle ? `${input.candidateName} for ${input.jobTitle}` : input.candidateName;
  const when = formatWhen(input.startsAt, input.timezone);

  switch (input.kind) {
    case 'SCHEDULED':
      return {
        title: `Interview scheduled: ${input.candidateName}`,
        message: `You are on the panel for a ${what} with ${who}, at ${when}.`,
      };
    case 'RESCHEDULED': {
      // Both times, always. "It moved" without saying from what is the one
      // thing an interviewer cannot act on, which is why section 10 asks for
      // the original to survive and why it is repeated here.
      const previous =
        input.previousStartsAt !== undefined
          ? formatWhen(input.previousStartsAt, input.previousTimezone ?? input.timezone)
          : null;
      return {
        title: `Interview moved: ${input.candidateName}`,
        message: [
          previous ? `Originally ${previous}.` : null,
          `Now ${when}.`,
          input.reason ? `Reason: ${input.reason}` : null,
          `${what} with ${who}.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'CANCELLED':
      return {
        title: `Interview cancelled: ${input.candidateName}`,
        message: `The ${what} with ${who} at ${when} is off.${input.reason ? ` Reason: ${input.reason}` : ''}`,
      };
    case 'REMINDER':
      return {
        title: `Interview coming up: ${input.candidateName}`,
        message: `A ${what} with ${who} starts at ${when}.`,
      };
    case 'EVALUATION_PENDING':
      return {
        title: `Evaluation pending: ${input.candidateName}`,
        message: `The ${what} with ${who} is marked complete. Your feedback has not been submitted yet.`,
      };
  }
}

/**
 * Notifies every panellist who has a login, and reports honestly.
 *
 * Never throws. A notification failure must not fail the request that produced
 * it - the interview is already booked and durable, and refusing the booking
 * because a mail relay is down would be the wrong trade every time.
 *
 * Email is only ATTEMPTED for the kinds where it earns the round trip: a
 * scheduling, a move or a cancellation is something somebody needs to see
 * outside the app. An evaluation reminder is in-app only, because it is about
 * work inside the product and nobody wants mail about it.
 */
export async function notifyPanel(
  request: FastifyRequest,
  input: PanelNoticeInput,
): Promise<PanelNotice> {
  const { title, message } = buildMessage(input);
  const wantsEmail = input.kind !== 'EVALUATION_PENDING';

  let notified = 0;
  const unreachable: string[] = [];
  let emailStatus: EmailDeliveryStatus = 'skipped';
  let emailProvider: string | null = null;

  for (const interviewer of input.interviewers) {
    if (!interviewer.userId) {
      unreachable.push(interviewer.fullName);
      continue;
    }

    try {
      const result = await notify({
        companyId: input.companyId,
        userId: interviewer.userId,
        type: NOTIFICATION_TYPES[input.kind],
        title,
        message,
        entityType: 'Interview',
        entityId: input.interviewId,
        logger: request.log,
        ...(wantsEmail && interviewer.workEmail
          ? {
              email: {
                to: interviewer.workEmail,
                subject: title,
                text: message,
              },
              /*
               * Waited for, on purpose. This is one of the few callers whose
               * response makes a claim about the mail - the scheduling screen
               * says what happened - so dispatching and moving on would mean
               * reporting an outcome we do not have. It costs the round trip
               * to the relay and still cannot turn a mail failure into a
               * failed request.
               */
              awaitEmail: true,
            }
          : {}),
      });

      notified += 1;

      /*
       * The WORST answer across the panel wins, because a summary that says
       * "delivered" when two of three bounced is the misreport this whole
       * arrangement exists to prevent.
       */
      emailStatus = worseOf(emailStatus, result.emailStatus);
      emailProvider = result.emailProvider ?? emailProvider;
    } catch (error) {
      // notify() is documented not to throw; this is belt and braces so a
      // future change there cannot start failing interview scheduling.
      request.log.error(
        { err: error, interviewId: input.interviewId, employeeId: interviewer.id },
        'failed to notify an interviewer; the interview itself is unaffected',
      );
    }
  }

  if (unreachable.length > 0) {
    request.log.info(
      { interviewId: input.interviewId, unreachable },
      'some interviewers have no login account and were not notified',
    );
  }

  return { notified, emailStatus, emailProvider, unreachable };
}

/**
 * The less reassuring of two delivery answers.
 *
 * Ordered worst-first: a single failure outranks any number of successes, and
 * `skipped` - which means nothing was attempted - loses to everything, so a
 * panel of three where one had no address still reports what happened to the
 * other two.
 */
const SEVERITY: Record<EmailDeliveryStatus, number> = {
  failed: 3,
  unconfirmed: 2,
  delivered: 1,
  skipped: 0,
};

function worseOf(a: EmailDeliveryStatus, b: EmailDeliveryStatus): EmailDeliveryStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}
