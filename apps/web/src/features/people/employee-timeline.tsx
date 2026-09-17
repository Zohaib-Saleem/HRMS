import * as React from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  BadgeCheck,
  Briefcase,
  Building2,
  CalendarX,
  CheckCircle2,
  CircleSlash,
  Clock,
  FileCheck,
  FileText,
  FileWarning,
  FileX,
  HandCoins,
  HeartPulse,
  History,
  Landmark,
  LifeBuoy,
  LogOut,
  MapPin,
  PartyPopper,
  PencilLine,
  Plane,
  RotateCcw,
  Shuffle,
  TrendingUp,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import {
  TIMELINE_CATEGORY_LABELS,
  TIMELINE_PAGE_SIZE,
  type EmployeeTimelinePage,
  type TimelineCategory,
  type TimelineEvent,
  type TimelineEventType,
  type TimelineLinkTab,
} from '@hrms/shared';
import { api } from '@/lib/api';
import type { BadgeProps } from '@/components/ui/badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * The Timeline tab: one person's history, in order.
 *
 * Every event on this screen is a row some other module owns, normalised by
 * the API into one shape. Nothing here calculates, and nothing here is stored:
 * opening the tab is a read, and closing it leaves no trace. The card is
 * deliberately thin - it shows what happened and hands the reader on to the
 * module that owns the record, rather than growing into a second, worse copy
 * of the Loans tab.
 *
 * What the screen must never do is present an absence as a fact. A category
 * the reader may not open is not listed as a filter and contributes no events,
 * which is why the chips come from the response rather than from a constant:
 * an empty "Salary" filter would read as "this person has never had a raise".
 */

type Tone = NonNullable<BadgeProps['variant']>;

/**
 * An icon per event type, from the same set the rest of the app uses.
 *
 * Exhaustive by type, so an event type added to the shared contract cannot
 * reach this screen without somebody deciding what it looks like.
 */
const EVENT_ICONS: Record<TimelineEventType, LucideIcon> = {
  EMPLOYEE_JOINED: UserPlus,
  WORK_ANNIVERSARY: PartyPopper,
  EMPLOYEE_CONFIRMED: BadgeCheck,
  EMPLOYEE_RESIGNED: LogOut,
  EMPLOYEE_LAST_WORKING_DAY: CalendarX,
  EMPLOYEE_TERMINATED: UserMinus,
  EMPLOYEE_REACTIVATED: RotateCcw,
  EMPLOYMENT_STATUS_CHANGED: Shuffle,
  EMPLOYMENT_STAGE_CHANGED: BadgeCheck,
  EMPLOYMENT_TYPE_CHANGED: Briefcase,
  DEPARTMENT_CHANGED: Building2,
  TEAM_CHANGED: Users,
  DESIGNATION_CHANGED: Briefcase,
  MANAGER_CHANGED: UserCog,
  LOCATION_CHANGED: MapPin,
  SALARY_CREATED: Wallet,
  SALARY_UPDATED: TrendingUp,
  SALARY_INCREMENT: TrendingUp,
  ATTENDANCE_CORRECTION_REQUESTED: Clock,
  ATTENDANCE_CORRECTION_APPROVED: CheckCircle2,
  ATTENDANCE_CORRECTION_REJECTED: XCircle,
  ATTENDANCE_CORRECTED: PencilLine,
  LEAVE_REQUESTED: Plane,
  LEAVE_APPROVED: Plane,
  LEAVE_REJECTED: XCircle,
  LEAVE_CANCELLED: CircleSlash,
  LOAN_APPLIED: HandCoins,
  LOAN_APPROVED: Landmark,
  LOAN_REJECTED: XCircle,
  LOAN_ACTIVATED: Landmark,
  LOAN_COMPLETED: CheckCircle2,
  LOAN_CANCELLED: CircleSlash,
  MEDICAL_CLAIM_SUBMITTED: HeartPulse,
  MEDICAL_CLAIM_APPROVED: HeartPulse,
  MEDICAL_CLAIM_REJECTED: XCircle,
  MEDICAL_CLAIM_PAID: HeartPulse,
  MEDICAL_CLAIM_CANCELLED: CircleSlash,
  CASE_OPENED: LifeBuoy,
  CASE_RESOLVED: CheckCircle2,
  CASE_CLOSED: CircleSlash,
  CONTRACT_STARTED: FileText,
  CONTRACT_ENDED: FileX,
  POLICY_ASSIGNED: FileText,
  POLICY_ACKNOWLEDGED: FileCheck,
  POLICY_DECLINED: FileX,
  DOCUMENT_EXPIRED: FileWarning,
};

/**
 * The colour of a marker is a judgement about the event.
 *
 * Green for things that opened or went the employee's way, amber for things
 * that need somebody to look, red only for an ending or a refusal. Everything
 * else stays grey on purpose: a timeline where every row is coloured is a
 * timeline where none of them is.
 */
const EVENT_TONES: Record<TimelineEventType, Tone> = {
  EMPLOYEE_JOINED: 'success',
  WORK_ANNIVERSARY: 'primary',
  EMPLOYEE_CONFIRMED: 'success',
  EMPLOYEE_RESIGNED: 'warning',
  EMPLOYEE_LAST_WORKING_DAY: 'warning',
  EMPLOYEE_TERMINATED: 'destructive',
  EMPLOYEE_REACTIVATED: 'success',
  EMPLOYMENT_STATUS_CHANGED: 'neutral',
  EMPLOYMENT_STAGE_CHANGED: 'neutral',
  EMPLOYMENT_TYPE_CHANGED: 'neutral',
  DEPARTMENT_CHANGED: 'neutral',
  TEAM_CHANGED: 'neutral',
  DESIGNATION_CHANGED: 'neutral',
  MANAGER_CHANGED: 'neutral',
  LOCATION_CHANGED: 'neutral',
  SALARY_CREATED: 'primary',
  SALARY_UPDATED: 'primary',
  SALARY_INCREMENT: 'primary',
  ATTENDANCE_CORRECTION_REQUESTED: 'neutral',
  ATTENDANCE_CORRECTION_APPROVED: 'success',
  ATTENDANCE_CORRECTION_REJECTED: 'destructive',
  ATTENDANCE_CORRECTED: 'warning',
  LEAVE_REQUESTED: 'neutral',
  LEAVE_APPROVED: 'success',
  LEAVE_REJECTED: 'destructive',
  LEAVE_CANCELLED: 'neutral',
  LOAN_APPLIED: 'neutral',
  LOAN_APPROVED: 'success',
  LOAN_REJECTED: 'destructive',
  LOAN_ACTIVATED: 'primary',
  LOAN_COMPLETED: 'success',
  LOAN_CANCELLED: 'neutral',
  MEDICAL_CLAIM_SUBMITTED: 'neutral',
  MEDICAL_CLAIM_APPROVED: 'success',
  MEDICAL_CLAIM_REJECTED: 'destructive',
  MEDICAL_CLAIM_PAID: 'primary',
  MEDICAL_CLAIM_CANCELLED: 'neutral',
  CASE_OPENED: 'neutral',
  CASE_RESOLVED: 'success',
  CASE_CLOSED: 'neutral',
  CONTRACT_STARTED: 'neutral',
  CONTRACT_ENDED: 'warning',
  POLICY_ASSIGNED: 'neutral',
  POLICY_ACKNOWLEDGED: 'success',
  POLICY_DECLINED: 'destructive',
  DOCUMENT_EXPIRED: 'warning',
};

const MARKER_CLASS: Record<Tone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  primary: 'border-transparent bg-primary-soft text-primary',
  success: 'border-transparent bg-success-soft text-success',
  warning: 'border-transparent bg-warning-soft text-warning-foreground',
  destructive: 'border-transparent bg-destructive-soft text-destructive',
  outline: 'border-border text-foreground',
};

type Order = 'desc' | 'asc';

/** "10 Sep" - the rail's date, read at a glance down the left-hand edge. */
function railDate(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "10 Sep 2026" - the full date, on the card. */
function fullDate(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The clock time, for events that had one.
 *
 * A salary effective date never had a time of day and must not be given one -
 * `dateOnly` is what says so, and it comes from whether the source was a date
 * column or a timestamp.
 */
function clockTime(event: TimelineEvent): string | null {
  if (event.dateOnly) return null;
  const parsed = new Date(event.occurredAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function EmployeeTimeline({
  employeeId,
  employeeName,
  photoUrl,
  onOpenTab,
}: {
  employeeId: string;
  employeeName: string;
  photoUrl: string | null;
  /** Hands the reader to the tab that owns the record, from the detail drawer. */
  onOpenTab?: (tab: TimelineLinkTab) => void;
}) {
  const [category, setCategory] = React.useState<TimelineCategory | null>(null);
  const [year, setYear] = React.useState<number | null>(null);
  const [order, setOrder] = React.useState<Order>('desc');
  const [selected, setSelected] = React.useState<TimelineEvent | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['employees', employeeId, 'timeline', { category, year, order }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.getEnvelope<EmployeeTimelinePage>(`/employees/${employeeId}/timeline`, {
        query: {
          category: category ?? undefined,
          year: year ?? undefined,
          order,
          limit: TIMELINE_PAGE_SIZE,
          cursor: pageParam,
        },
      }),
    getNextPageParam: (last: EmployeeTimelinePage) => last.meta.nextCursor ?? undefined,
    /*
     * A filter change must not blank the screen it was clicked on. Without
     * this the chips themselves unmount while the next page is in flight, and
     * the control the reader just used disappears under their cursor.
     */
    placeholderData: keepPreviousData,
    enabled: employeeId !== '',
  });

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader bordered>
          <CardTitle className="text-base">Employee timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 py-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const pages = query.data?.pages ?? [];
  const meta = pages[0]?.meta;
  const events = pages.flatMap((page) => page.data);

  return (
    <>
      <Card>
        <CardHeader
          bordered
          className="flex flex-row flex-wrap items-center justify-between gap-3"
        >
          <CardTitle className="flex items-center gap-2.5">
            <Avatar name={employeeName} photoUrl={photoUrl} colorKey={employeeId} size="sm" />
            Employee timeline
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOrder((current) => (current === 'desc' ? 'asc' : 'desc'))}
          >
            <History aria-hidden />
            {order === 'desc' ? 'Newest first' : 'Oldest first'}
          </Button>
        </CardHeader>

        {meta && (meta.categories.length > 0 || meta.years.length > 0) ? (
          <div className="space-y-2 border-b border-border px-5 py-3">
            {meta.categories.length > 0 ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
                <Chip active={category === null} onClick={() => setCategory(null)}>
                  All
                </Chip>
                {meta.categories.map((item) => (
                  <Chip
                    key={item}
                    active={category === item}
                    onClick={() => setCategory(item)}
                  >
                    {TIMELINE_CATEGORY_LABELS[item]}
                  </Chip>
                ))}
              </div>
            ) : null}

            {meta.years.length > 0 ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by year">
                <Chip active={year === null} onClick={() => setYear(null)}>
                  All time
                </Chip>
                {meta.years.map((item) => (
                  <Chip key={item} active={year === item} onClick={() => setYear(item)}>
                    {item}
                  </Chip>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <CardContent className="py-0">
          {events.length === 0 ? (
            <EmptyState
              icon={History}
              title="Employee timeline"
              description={
                category || year
                  ? 'Nothing was recorded that matches these filters.'
                  : 'No history is available yet.'
              }
            />
          ) : (
            <ol className="py-2">
              {events.map((event, index) => (
                <React.Fragment key={event.id}>
                  {index === 0 || events[index - 1]!.year !== event.year ? (
                    <li className="sticky top-0 z-10 -mx-5 bg-card/95 px-5 pb-1 pt-4 backdrop-blur">
                      <h4 className="tabular text-[13px] font-semibold text-muted-foreground">
                        {event.year}
                      </h4>
                    </li>
                  ) : null}
                  <TimelineRow event={event} onOpen={() => setSelected(event)} />
                </React.Fragment>
              ))}
            </ol>
          )}
        </CardContent>

        {query.hasNextPage ? (
          <div className="border-t border-border px-5 py-3 text-center">
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>

      <EventDetail
        event={selected}
        onClose={() => setSelected(null)}
        onOpenTab={onOpenTab}
      />
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * One event: a dated rail, a marker, and a card.
 *
 * The whole row is the control rather than a "details" link at the end of it -
 * a reader who wants more has already pointed at the thing they want more of.
 */
function TimelineRow({ event, onOpen }: { event: TimelineEvent; onOpen: () => void }) {
  const Icon = EVENT_ICONS[event.type];
  const tone = EVENT_TONES[event.type];
  const time = clockTime(event);

  return (
    <li className="flex gap-3">
      <div className="w-16 shrink-0 pt-4 text-right">
        <span className="tabular text-[12px] text-muted-foreground">{railDate(event.day)}</span>
      </div>

      <div className="relative flex shrink-0 flex-col items-center">
        <span
          className={cn(
            'mt-3.5 grid size-8 place-items-center rounded-full border',
            MARKER_CLASS[tone],
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        {/* The thread. Decorative, and it stops at the last row of its own accord
            because the row below is what draws the next length of it. */}
        <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="my-1.5 min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{event.title}</span>
          <Badge variant="neutral">{TIMELINE_CATEGORY_LABELS[event.category]}</Badge>
        </div>
        {event.description ? (
          <p className="mt-0.5 break-words text-[13px] text-muted-foreground">
            {event.description}
          </p>
        ) : null}
        <p className="mt-1 text-[12px] text-muted-foreground">
          {fullDate(event.day)}
          {time ? ` · ${time}` : ''}
          {event.actorName ? ` · Changed by: ${event.actorName}` : ''}
        </p>
      </button>
    </li>
  );
}

/**
 * The detail drawer.
 *
 * A summary and a way out, not a second copy of the module. Every row in it
 * was formatted by the API, which is also where the decision about what may be
 * shown was made - this component renders what it is handed and redacts
 * nothing, because a client-side redaction is a redaction that already
 * travelled over the wire.
 */
function EventDetail({
  event,
  onClose,
  onOpenTab,
}: {
  event: TimelineEvent | null;
  onClose: () => void;
  onOpenTab?: (tab: TimelineLinkTab) => void;
}) {
  const time = event ? clockTime(event) : null;

  return (
    <Dialog open={event !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent variant="drawer" size="md">
        {event ? (
          <>
            <DialogHeader>
              <DialogTitle>{event.title}</DialogTitle>
              <DialogDescription>
                {fullDate(event.day)}
                {time ? ` · ${time}` : ''}
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <dl className="space-y-3">
                {event.details.map((row) => (
                  <div key={row.label}>
                    <dt className="text-[12px] text-muted-foreground">{row.label}</dt>
                    <dd className="mt-0.5 break-words text-[13.5px]">{row.value}</dd>
                  </div>
                ))}
                {event.actorName ? (
                  <div>
                    <dt className="text-[12px] text-muted-foreground">Changed by</dt>
                    <dd className="mt-0.5 text-[13.5px]">{event.actorName}</dd>
                  </div>
                ) : null}
              </dl>
            </DialogBody>

            <DialogFooter>
              {event.link && onOpenTab ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const tab = event.link;
                    onClose();
                    if (tab) onOpenTab(tab);
                  }}
                >
                  Open {event.link}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
