import * as React from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import {
  INTERVIEW_STATUSES,
  INTERVIEW_STATUS_LABELS,
  INTERVIEW_TYPES,
  INTERVIEW_TYPE_LABELS,
  type InterviewRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ViewSwitcher } from '@/components/ui/view-switcher';
import { ListSkeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  INTERVIEW_STATUS_TONE,
  interviewLongDay,
  interviewRange,
  interviewTime,
  shiftDay,
  splitInZone,
  todayIn,
  zoneLabel,
} from './recruitment-shared';
import { useInterviewers, useJobOpeningOptions, useRecruitmentAccess } from './use-recruitment-data';

/**
 * The interview calendar.
 *
 * The WINDOW is computed by the server, not here. A browser working out "this
 * week" works it out in the browser's zone, which is how a Monday interview
 * disappears from a Monday-to-Sunday week for somebody sitting five hours west
 * of the office - so this page sends a view and an anchor day and is told back
 * which instants the window spans and in which zone.
 *
 * Every interview is then placed on the day it falls on IN THE CALENDAR'S
 * ZONE, and its time is shown in ITS OWN. Those are usually the same zone and
 * occasionally are not - a remote candidate booked in Berlin sits in the
 * office's Thursday column and says 15:00 CET - and conflating them is exactly
 * how somebody turns up at the wrong hour.
 *
 * Who is on the calendar at all is the server's decision: `interview.manage`
 * sees the company's, `interview.read` alone sees the seats they are on. There
 * is no control here that widens that, which is why the "Mine only" filter
 * sends the word `mine` rather than an employee id - the session is the only
 * trustworthy answer to "whose".
 */

type View = 'day' | 'week' | 'month';

interface CalendarEnvelope {
  data: InterviewRecord[];
  range: {
    from: string | null;
    to: string | null;
    view: View;
    timezone: string;
    anchor?: string;
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function InterviewsPage() {
  const { companyTimezone, canManageInterviews } = useRecruitmentAccess();
  const { lookups } = useLookups();
  const { interviewers } = useInterviewers();
  const { openings } = useJobOpeningOptions();

  const [view, setView] = React.useState<View>('week');
  const [anchor, setAnchor] = React.useState(() => todayIn(companyTimezone));
  const [filters, setFilters] = React.useState({
    interviewerId: '',
    jobOpeningId: '',
    departmentId: '',
    type: '',
    status: '',
    scope: '',
  });

  const query = useQuery({
    queryKey: ['recruitment', 'interviews', 'calendar', view, anchor, filters],
    queryFn: () =>
      api.getEnvelope<CalendarEnvelope>('/recruitment/interviews/calendar', {
        query: {
          view,
          day: anchor,
          interviewerId: filters.interviewerId || undefined,
          jobOpeningId: filters.jobOpeningId || undefined,
          departmentId: filters.departmentId || undefined,
          type: filters.type || undefined,
          status: filters.status || undefined,
          scope: filters.scope || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const timezone = query.data?.range.timezone ?? companyTimezone;
  const interviews = query.data?.data ?? [];

  /** The days the window spans, in the calendar's own zone. */
  const days = React.useMemo(() => {
    const range = query.data?.range;
    if (!range?.from || !range.to) return [] as string[];
    const first = splitInZone(range.from, range.timezone).day;
    // `to` is the exclusive end instant, so the day it falls on is one past
    // the last day of the window.
    const past = splitInZone(range.to, range.timezone).day;
    const list: string[] = [];
    for (let day = first; day !== past && list.length < 45; day = shiftDay(day, 1)) {
      list.push(day);
    }
    return list;
  }, [query.data]);

  const byDay = React.useMemo(() => {
    const map = new Map<string, InterviewRecord[]>();
    for (const interview of interviews) {
      const day = splitInZone(interview.startsAt, timezone).day;
      const bucket = map.get(day);
      if (bucket) bucket.push(interview);
      else map.set(day, [interview]);
    }
    return map;
  }, [interviews, timezone]);

  const step = view === 'day' ? 1 : view === 'week' ? 7 : 30;
  const hasFilters = Object.values(filters).some((value) => value !== '');

  return (
    <>
      <PageHeader
        title="Interviews"
        description={`Times are shown in each interview's own zone. The calendar runs on ${timezone}.`}
      />

      <Card className="mb-4">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3.5 xl:flex-row xl:items-center">
          <ViewSwitcher
            label="Calendar view"
            value={view}
            onChange={setView}
            options={[
              { key: 'day', label: 'Day', icon: CalendarDays },
              { key: 'week', label: 'Week', icon: Columns3 },
              { key: 'month', label: 'Month', icon: CalendarRange },
            ]}
          />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous"
              onClick={() => setAnchor((day) => shiftDay(day, -step))}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAnchor(todayIn(timezone))}
            >
              Today
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next"
              onClick={() => setAnchor((day) => shiftDay(day, step))}
            >
              <ChevronRight />
            </Button>
            <p className="ml-1 text-[13.5px] font-medium">{rangeLabel(days, view)}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          {/* A word, not an employee id: the server resolves whose session
              this is, because it is the only thing that can be trusted to. */}
          <NativeSelect
            aria-label="Whose interviews"
            value={filters.scope}
            onChange={(event) => setFilters((prev) => ({ ...prev, scope: event.target.value }))}
            className="xl:w-44"
          >
            <option value="">Everything I can see</option>
            <option value="mine">Only mine</option>
          </NativeSelect>

          {canManageInterviews ? (
            <NativeSelect
              aria-label="Interviewer"
              value={filters.interviewerId}
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, interviewerId: event.target.value }))
              }
              className="xl:w-48"
            >
              <option value="">Any interviewer</option>
              {interviewers.map((person) => (
                <option key={person.employeeId} value={person.employeeId}>
                  {person.fullName}
                </option>
              ))}
            </NativeSelect>
          ) : null}

          <NativeSelect
            aria-label="Job opening"
            value={filters.jobOpeningId}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, jobOpeningId: event.target.value }))
            }
            className="xl:w-52"
          >
            <option value="">All openings</option>
            {openings.map((opening) => (
              <option key={opening.id} value={opening.id}>
                {opening.title}
              </option>
            ))}
          </NativeSelect>

          <NativeSelect
            aria-label="Department"
            value={filters.departmentId}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, departmentId: event.target.value }))
            }
            className="xl:w-44"
          >
            <option value="">All departments</option>
            {lookups.departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.label}
              </option>
            ))}
          </NativeSelect>

          <NativeSelect
            aria-label="Interview type"
            value={filters.type}
            onChange={(event) => setFilters((prev) => ({ ...prev, type: event.target.value }))}
            className="xl:w-44"
          >
            <option value="">All types</option>
            {INTERVIEW_TYPES.map((type) => (
              <option key={type} value={type}>
                {INTERVIEW_TYPE_LABELS[type]}
              </option>
            ))}
          </NativeSelect>

          <NativeSelect
            aria-label="Status"
            value={filters.status}
            onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))}
            className="xl:w-44"
          >
            <option value="">All statuses</option>
            {INTERVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {INTERVIEW_STATUS_LABELS[status]}
              </option>
            ))}
          </NativeSelect>

          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setFilters({
                  interviewerId: '',
                  jobOpeningId: '',
                  departmentId: '',
                  type: '',
                  status: '',
                  scope: '',
                })
              }
            >
              Reset
            </Button>
          ) : null}
        </div>
      </Card>

      {query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : query.isLoading ? (
        <Card>
          <ListSkeleton rows={5} />
        </Card>
      ) : interviews.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarDays}
            title="Nothing booked in this window"
            description={
              hasFilters
                ? 'Clear the filters, or move to another week.'
                : 'Interviews scheduled for these days appear here.'
            }
          />
        </Card>
      ) : view === 'month' ? (
        <MonthGrid days={days} byDay={byDay} timezone={timezone} />
      ) : (
        <DayList days={days} byDay={byDay} timezone={timezone} />
      )}
    </>
  );
}

/**
 * Day and week, as a list of days.
 *
 * A week rendered as seven columns of an hour grid looks like a calendar and
 * is unreadable on a phone, where a good half of these screens are opened. A
 * list of days with the appointments under each says the same thing, reads at
 * any width, and does not need a scroll position to be useful.
 */
function DayList({
  days,
  byDay,
  timezone,
}: {
  days: string[];
  byDay: Map<string, InterviewRecord[]>;
  timezone: string;
}) {
  const today = todayIn(timezone);

  return (
    <div className="space-y-3">
      {days.map((day) => {
        const entries = byDay.get(day) ?? [];
        // Empty days are dropped from a week rather than rendered as blanks:
        // seven "no interviews" cards are seven cards of nothing.
        if (entries.length === 0 && days.length > 1) return null;

        return (
          <Card key={day}>
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <h2 className="text-[14px] font-semibold">
                {interviewLongDay(`${day}T12:00:00Z`, 'UTC')}
                {day === today ? (
                  <span className="ml-2 rounded-md bg-primary-soft px-1.5 py-0.5 text-[11px] font-medium text-primary">
                    Today
                  </span>
                ) : null}
              </h2>
              <span className="tabular text-[12.5px] text-muted-foreground">
                {entries.length} interview{entries.length === 1 ? '' : 's'}
              </span>
            </div>

            {entries.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13px] text-muted-foreground">
                Nothing booked.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {entries.map((interview) => (
                  <li key={interview.id}>
                    <CalendarRow interview={interview} calendarZone={timezone} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function CalendarRow({
  interview,
  calendarZone,
}: {
  interview: InterviewRecord;
  calendarZone: string;
}) {
  // The zone is printed only when it differs from the calendar's. Repeating
  // "PKT" on every row of a Karachi office's calendar is noise; printing
  // "CET" on the one row that is in Berlin is the whole point.
  const foreign = interview.timezone !== calendarZone;

  return (
    <Link
      to={`/recruitment/interviews/${interview.id}`}
      className="flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-accent/45 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="shrink-0 sm:w-40">
        <p className="tabular text-[13.5px] font-semibold">
          {interviewRange(interview.startsAt, interview.endsAt, interview.timezone)}
        </p>
        {foreign ? (
          <p className="text-[11.5px] text-warning-foreground">
            {zoneLabel(interview.startsAt, interview.timezone)}
          </p>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium">{interview.candidateName}</p>
        <p className="truncate text-[12px] text-muted-foreground">
          {INTERVIEW_TYPE_LABELS[interview.type]}
          {interview.jobTitle ? ` · ${interview.jobTitle}` : ''}
        </p>
      </div>

      <div className="flex items-center gap-2 sm:w-56 sm:justify-end">
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
          {interview.interviewers.map((person) => person.fullName).join(', ') || 'No panel'}
        </span>
        <Badge variant={INTERVIEW_STATUS_TONE[interview.status]}>
          {INTERVIEW_STATUS_LABELS[interview.status]}
        </Badge>
      </div>
    </Link>
  );
}

/**
 * A month.
 *
 * A real grid from `md` up, because a month is a shape people recognise and
 * the shape is the information - "we have nothing booked in the last week of
 * the month" is visible at a glance and invisible in a list. Below `md` it
 * falls back to the same day list as the other two views: a seven-column grid
 * at 375px is seven columns of nothing.
 */
function MonthGrid({
  days,
  byDay,
  timezone,
}: {
  days: string[];
  byDay: Map<string, InterviewRecord[]>;
  timezone: string;
}) {
  const today = todayIn(timezone);
  const first = days[0];
  // A date-only value has no zone to get wrong, so UTC is exact here.
  const offset = first ? new Date(`${first}T00:00:00Z`).getUTCDay() : 0;

  return (
    <>
      <div className="md:hidden">
        <DayList days={days} byDay={byDay} timezone={timezone} />
      </div>

      <Card className="hidden overflow-hidden md:block">
        <div className="grid grid-cols-7 border-b border-border bg-surface-muted/60">
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              className="px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-px bg-border">
          {Array.from({ length: offset }).map((_, index) => (
            <div key={`pad-${index}`} className="min-h-28 bg-surface-muted/40" />
          ))}

          {days.map((day) => {
            const entries = byDay.get(day) ?? [];
            return (
              <div key={day} className="min-h-28 bg-card p-1.5">
                <p
                  className={cn(
                    'tabular mb-1 text-[11.5px] font-medium',
                    day === today ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {Number(day.slice(8, 10))}
                </p>
                <ul className="space-y-1">
                  {entries.slice(0, 3).map((interview) => (
                    <li key={interview.id}>
                      <Link
                        to={`/recruitment/interviews/${interview.id}`}
                        className="block truncate rounded bg-primary-soft px-1.5 py-1 text-[11px] text-primary hover:underline"
                        title={`${interview.candidateName} - ${INTERVIEW_TYPE_LABELS[interview.type]}`}
                      >
                        {interviewTime(interview.startsAt, interview.timezone)}{' '}
                        {interview.candidateName}
                      </Link>
                    </li>
                  ))}
                  {entries.length > 3 ? (
                    <li className="px-1.5 text-[11px] text-muted-foreground">
                      +{entries.length - 3} more
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

/** "18 September 2026", or the two ends of a longer window. */
function rangeLabel(days: string[], view: View): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  if (view === 'day' || first === last) return interviewLongDay(`${first}T12:00:00Z`, 'UTC');
  return `${interviewLongDay(`${first}T12:00:00Z`, 'UTC')} - ${interviewLongDay(`${last}T12:00:00Z`, 'UTC')}`;
}
