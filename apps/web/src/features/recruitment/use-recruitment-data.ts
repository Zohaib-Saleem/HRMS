import { useQuery } from '@tanstack/react-query';
import {
  PERMISSIONS,
  type InterviewerOption,
  type JobOpeningRecord,
  type Paginated,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { usePermissions, useSession } from '@/features/auth/session-context';

/**
 * The data every recruitment screen needs before it can draw a form.
 *
 * Three hooks, and each one exists because the same request was about to be
 * written in three files with three different cache keys - which is how a
 * screen ends up refetching the staff list every time a drawer opens.
 */

/**
 * Who can be put on a panel, or own a vacancy.
 *
 * Existing employees. There is no "invite an interviewer" anywhere in this
 * module: an interviewer is somebody the company already employs, and the
 * endpoint returns exactly that, minus anybody who has left.
 *
 * `enabled` is honoured rather than ignored because this is a form's
 * vocabulary, not a page's - a closed dialog has no form, and this list is
 * three hundred people.
 */
export function useInterviewers(enabled = true) {
  const query = useQuery({
    queryKey: ['recruitment', 'interviewers'],
    queryFn: () => api.get<InterviewerOption[]>('/recruitment/dashboard/interviewers'),
    enabled,
    staleTime: 5 * 60_000,
  });

  return {
    interviewers: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * The openings, for a filter or a picker rather than for a list screen.
 *
 * Capped at a hundred and unpaginated on purpose: this feeds a `<select>`, and
 * a select with a second page is not a select. A company with more than a
 * hundred live vacancies filters on the Job openings screen itself, which is
 * paginated properly.
 */
export function useJobOpeningOptions(enabled = true) {
  const query = useQuery({
    queryKey: ['recruitment', 'job-openings', 'options'],
    queryFn: () =>
      api.getPage<JobOpeningRecord>('/recruitment/job-openings', {
        query: { limit: 100, sort: 'title', order: 'asc' },
      }),
    enabled,
    staleTime: 60_000,
  });

  return {
    openings: (query.data as Paginated<JobOpeningRecord> | undefined)?.data ?? [],
    isLoading: query.isLoading,
  };
}

/**
 * What this reader may do, as the eight booleans the screens actually ask.
 *
 * A courtesy, not a control. Every endpoint behind every one of these re-checks
 * the same grant, and the narrow reads - an interviewer's calendar, a hiring
 * manager's openings - are narrowed by a WHERE clause on the server rather than
 * by anything decided here. What this buys is that somebody is not shown a
 * button that will answer 403.
 */
export function useRecruitmentAccess() {
  const { has } = usePermissions();
  const { session } = useSession();

  return {
    canReadRecruitment: has(PERMISSIONS.RECRUITMENT_READ),
    canManageRecruitment: has(PERMISSIONS.RECRUITMENT_MANAGE),
    canReadCandidates: has(PERMISSIONS.CANDIDATE_READ),
    canManageCandidates: has(PERMISSIONS.CANDIDATE_MANAGE),
    canReadInterviews: has(PERMISSIONS.INTERVIEW_READ),
    canManageInterviews: has(PERMISSIONS.INTERVIEW_MANAGE),
    canEvaluate: has(PERMISSIONS.INTERVIEW_EVALUATE),
    canManageOffers: has(PERMISSIONS.RECRUITMENT_OFFER_MANAGE),
    canConvert: has(PERMISSIONS.RECRUITMENT_CONVERT_EMPLOYEE),
    /** The company's zone, which is what a new interview is booked in. */
    companyTimezone: session?.company.timezone ?? 'UTC',
    currency: session?.company.currency ?? 'USD',
  };
}
