import { useQuery } from '@tanstack/react-query';
import { Banknote, CalendarCheck, HandCoins, Timer } from 'lucide-react';
import type { EmployeeProfileSummary } from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { StatCard } from '@/components/ui/stat-card';
import { minutesLabel } from '@/features/time/attendance-ui';
import { money } from '@/features/payroll/payroll-shared';

/**
 * The Employee 360 headline strip.
 *
 * Four questions HR asks before opening any tab: were they here this month,
 * how much leave is left, do they owe anything, and what are they on. One
 * request answers all four - `/employees/:id/profile-summary` - and every
 * figure in it is produced by the module that owns it: the central attendance
 * engine, the leave balance service, the loan schedule, the salary records.
 * Nothing is recalculated in the browser.
 *
 * A card whose block the API omitted is not rendered. The API omits a block the
 * caller has no permission for, so the strip narrows to what the reader may
 * actually see instead of showing four cards, two of them empty.
 */
export function EmployeeProfileSummaryCards({ employeeId }: { employeeId: string }) {
  const query = useQuery({
    queryKey: ['employees', employeeId, 'profile-summary'],
    queryFn: () => api.get<EmployeeProfileSummary>(`/employees/${employeeId}/profile-summary`),
    enabled: employeeId !== '',
  });

  const data = query.data;
  const loading = query.isLoading;

  // A failed summary must not take the profile down with it - the tabs below
  // read their own endpoints and are perfectly usable without this strip.
  if (query.isError) return null;

  const cards: React.ReactNode[] = [];

  if (loading || data?.attendance) {
    const a = data?.attendance;
    cards.push(
      <StatCard
        key="attendance"
        label="Present this month"
        value={a ? `${a.present + a.halfDay * 0.5}` : undefined}
        hint={
          a
            ? `${a.absent} absent · ${a.late} late · ${a.onLeave} on leave`
            : undefined
        }
        icon={CalendarCheck}
        tone="primary"
        loading={loading}
      />,
    );
  }

  if (loading || data?.attendance) {
    const a = data?.attendance;
    cards.push(
      <StatCard
        key="hours"
        label="Hours worked"
        value={a ? minutesLabel(a.workedMinutes) : undefined}
        hint={
          a
            ? `of ${minutesLabel(a.expectedMinutes)} normal · ${minutesLabel(a.overtimeMinutes)} overtime`
            : undefined
        }
        icon={Timer}
        loading={loading}
      />,
    );
  }

  if (loading || data?.leave) {
    const l = data?.leave;
    cards.push(
      <StatCard
        key="leave"
        label="Leave remaining"
        value={l ? days(l.availableDays) : undefined}
        hint={l ? `${days(l.usedDays)} used of ${days(l.entitlementDays)} in ${l.year}` : undefined}
        icon={CalendarCheck}
        tone="success"
        loading={loading}
      />,
    );
  }

  if (loading || data?.salary) {
    const s = data?.salary;
    cards.push(
      <StatCard
        key="salary"
        label="Current salary"
        value={s ? money(s.amount, s.currency) : undefined}
        hint={
          s
            ? [
                s.effectiveFrom ? `from ${formatDate(s.effectiveFrom)}` : 'none in force',
                s.nextIncrementDueDate
                  ? `increment due ${formatDate(s.nextIncrementDueDate)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        icon={Banknote}
        loading={loading}
      />,
    );
  }

  // Only when there is something to owe. A zero-balance card on every profile
  // that has never taken a loan is noise on the one strip that must stay
  // scannable.
  if (data?.loans && data.loans.activeCount > 0) {
    const l = data.loans;
    cards.push(
      <StatCard
        key="loans"
        label="Loan outstanding"
        value={money(l.outstandingAmount, l.currency)}
        hint={`${l.activeCount} active · ${money(l.monthlyDeduction, l.currency)} a month`}
        icon={HandCoins}
        tone="warning"
      />,
    );
  }

  if (cards.length === 0) return null;

  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards}</div>
  );
}

const days = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
