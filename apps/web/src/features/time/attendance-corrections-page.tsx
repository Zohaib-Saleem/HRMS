import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSearch, History, PencilLine, ShieldCheck } from 'lucide-react';
import {
  ATTENDANCE_FLAGS,
  ATTENDANCE_FLAG_LABELS,
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABELS,
  DERIVED_ATTENDANCE_STATUSES,
  DERIVED_ATTENDANCE_STATUS_LABELS,
  PERMISSIONS,
  type AttendanceDayDetail,
  type AttendanceMonthlyRow,
  type AttendanceMonthlyTotals,
  type Paginated,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { cn, formatDate } from '@/lib/utils';
import { usePermissions } from '@/features/auth/session-context';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  FLAG_BADGE,
  LATE_TEXT,
  STATUS_BADGE,
  minutesLabel,
  timeLabel,
} from './attendance-ui';

/**
 * The Attendance Correction Centre.
 *
 * HR opens this when somebody says "my Tuesday is wrong". It searches every
 * processed day the caller may see - by person, employee code, PunchCode, date,
 * department, team, status or flag - and opens one day at a time.
 *
 * The day panel is deliberately three things side by side rather than one
 * editable form: what is stored, what the punches underneath actually say, and
 * what the rules in force would make of them. A correction is then a decision
 * somebody makes with the evidence in front of them, needs a reason, and never
 * touches the punches.
 */

interface MonthlyResponse extends Paginated<AttendanceMonthlyRow> {
  totals: AttendanceMonthlyTotals;
  range: { from: string; to: string };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

const EMPTY_FILTERS = {
  q: '',
  employeeNumber: '',
  punchCode: '',
  month: thisMonth(),
  from: '',
  to: '',
  departmentId: '',
  teamId: '',
  status: '',
  flag: '',
  workingOnly: 'false',
  page: 1,
  limit: 25,
};

export function AttendanceCorrectionsPage() {
  const { has } = usePermissions();
  const { lookups } = useLookups();
  const canManage = has(PERMISSIONS.ATTENDANCE_MANAGE);

  const [filters, setFilters] = React.useState(() => ({ ...EMPTY_FILTERS }));
  const [open, setOpen] = React.useState<{ employeeId: string; date: string } | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);
  const debouncedNumber = useDebounced(filters.employeeNumber, 350);
  const debouncedPunch = useDebounced(filters.punchCode, 350);

  const update = React.useCallback(
    (patch: Partial<typeof filters>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const query = useQuery({
    queryKey: [
      'attendance',
      'monthly',
      { ...filters, q: debouncedQuery, employeeNumber: debouncedNumber, punchCode: debouncedPunch },
    ],
    queryFn: () =>
      api.get<MonthlyResponse>('/attendance/monthly', {
        query: {
          page: filters.page,
          limit: filters.limit,
          q: debouncedQuery || undefined,
          employeeNumber: debouncedNumber || undefined,
          punchCode: debouncedPunch || undefined,
          // An explicit range wins over the month; the server applies the same
          // precedence, so the two cannot disagree about what was asked.
          month: filters.from || filters.to ? undefined : filters.month || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          departmentId: filters.departmentId || undefined,
          teamId: filters.teamId || undefined,
          status: filters.status || undefined,
          flag: filters.flag || undefined,
          workingOnly: filters.workingOnly === 'true' ? 'true' : undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;
  const hasFilters =
    filters.q !== '' ||
    filters.employeeNumber !== '' ||
    filters.punchCode !== '' ||
    filters.departmentId !== '' ||
    filters.teamId !== '' ||
    filters.status !== '' ||
    filters.flag !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.workingOnly === 'true';

  return (
    <>
      <PageHeader
        title="Attendance corrections"
        description="Search processed attendance, see the punches behind a day, and correct what the terminals got wrong."
      />

      {totals ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Summary label="Present" value={totals.present} />
          <Summary label="Absent" value={totals.absent} />
          <Summary label="Late" value={totals.late} />
          <Summary label="Early leave" value={totals.earlyLeave} />
          <Summary label="Missing punch" value={totals.missingPunch} />
          <Summary label="Corrected" value={totals.manual} />
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by name"
          hasActiveFilters={hasFilters}
          onReset={() => setFilters({ ...EMPTY_FILTERS })}
          filters={
            <div className="grid gap-2 sm:grid-cols-2 xl:flex xl:flex-wrap xl:items-center">
              <Input
                value={filters.employeeNumber}
                onChange={(e) => update({ employeeNumber: e.target.value })}
                placeholder="Employee code"
                aria-label="Employee code"
                className="xl:w-36"
              />
              <Input
                value={filters.punchCode}
                onChange={(e) => update({ punchCode: e.target.value })}
                placeholder="PunchCode"
                aria-label="PunchCode"
                className="xl:w-32"
              />
              <Input
                type="month"
                value={filters.month}
                onChange={(e) => update({ month: e.target.value, from: '', to: '' })}
                aria-label="Month"
                className="xl:w-40"
              />
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => update({ from: e.target.value })}
                aria-label="From"
                className="xl:w-40"
              />
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => update({ to: e.target.value })}
                aria-label="To"
                className="xl:w-40"
              />
              <NativeSelect
                value={filters.departmentId}
                onChange={(e) => update({ departmentId: e.target.value })}
                aria-label="Department"
                className="xl:w-44"
              >
                <option value="">All departments</option>
                {lookups.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.teamId}
                onChange={(e) => update({ teamId: e.target.value })}
                aria-label="Team"
                className="xl:w-40"
              >
                <option value="">All teams</option>
                {lookups.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.status}
                onChange={(e) => update({ status: e.target.value })}
                aria-label="Status"
                className="xl:w-36"
              >
                <option value="">Any status</option>
                {DERIVED_ATTENDANCE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {DERIVED_ATTENDANCE_STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                value={filters.flag}
                onChange={(e) => update({ flag: e.target.value })}
                aria-label="Flag"
                className="xl:w-40"
              >
                <option value="">Any flag</option>
                {ATTENDANCE_FLAGS.map((f) => (
                  <option key={f} value={f}>
                    {ATTENDANCE_FLAG_LABELS[f]}
                  </option>
                ))}
              </NativeSelect>
              <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-[13px]">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input accent-[var(--primary)]"
                  checked={filters.workingOnly === 'true'}
                  onChange={(e) => update({ workingOnly: e.target.checked ? 'true' : 'false' })}
                />
                Working days only
              </label>
            </div>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isLoading ? (
          <TableSkeleton rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileSearch}
            title="No attendance matches those filters"
            description="Widen the range, or clear a filter to see more."
          />
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Employee</TH>
                  <TH>Department</TH>
                  <TH>Shift</TH>
                  <TH>Status</TH>
                  <TH>In</TH>
                  <TH>Out</TH>
                  <TH>Worked</TH>
                  <TH>Late</TH>
                  <TH>Early</TH>
                  <TH>OT</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={`${row.employeeId}-${row.date}`}>
                    <TD className="whitespace-nowrap font-medium">{formatDate(row.date)}</TD>
                    <TD>
                      <div className="font-medium">{row.employeeName}</div>
                      <div className="text-xs text-muted-foreground">{row.employeeNumber}</div>
                    </TD>
                    <TD className="text-muted-foreground">{row.departmentName ?? '--'}</TD>
                    <TD className="text-muted-foreground">{row.shiftName ?? '--'}</TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={STATUS_BADGE[row.status]}>
                          {DERIVED_ATTENDANCE_STATUS_LABELS[row.status]}
                        </span>
                        {row.flags.map((flag) => (
                          <span key={flag} className={FLAG_BADGE[flag]}>
                            {ATTENDANCE_FLAG_LABELS[flag]}
                          </span>
                        ))}
                      </div>
                    </TD>
                    <TD className="whitespace-nowrap">{timeLabel(row.checkInAt)}</TD>
                    <TD className="whitespace-nowrap">{timeLabel(row.checkOutAt)}</TD>
                    <TD className="whitespace-nowrap">{minutesLabel(row.workedMinutes)}</TD>
                    <TD className={cn('whitespace-nowrap', row.lateMinutes ? LATE_TEXT : '')}>
                      {row.lateMinutes ? minutesLabel(row.lateMinutes) : '--'}
                    </TD>
                    <TD className={cn('whitespace-nowrap', row.earlyLeaveMinutes ? LATE_TEXT : '')}>
                      {row.earlyLeaveMinutes ? minutesLabel(row.earlyLeaveMinutes) : '--'}
                    </TD>
                    <TD className="whitespace-nowrap">
                      {row.overtimeMinutes ? minutesLabel(row.overtimeMinutes) : '--'}
                    </TD>
                    <TD className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOpen({ employeeId: row.employeeId, date: row.date })}
                      >
                        {canManage ? (
                          <PencilLine className="size-4" aria-hidden />
                        ) : (
                          <FileSearch className="size-4" aria-hidden />
                        )}
                        {canManage ? 'Open' : 'View'}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        )}

        {query.data ? (
          <Pagination
            meta={query.data.meta}
            onPageChange={(page) => update({ page })}
            onLimitChange={(limit) => update({ limit, page: 1 })}
          />
        ) : null}
      </Card>

      <DayDrawer
        target={open}
        canManage={canManage}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** An instant as the `datetime-local` input wants it, in the viewer's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** And back again. An empty box means "clear this punch", not "leave it". */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface CorrectionForm {
  checkInAt: string;
  checkOutAt: string;
  status: string;
  shiftId: string;
  workedMinutes: string;
  lateMinutes: string;
  earlyLeaveMinutes: string;
  overtimeMinutes: string;
  notes: string;
  reason: string;
}

function DayDrawer({
  target,
  canManage,
  onClose,
}: {
  target: { employeeId: string; date: string } | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['attendance', 'day', target],
    queryFn: () =>
      api.get<AttendanceDayDetail>('/attendance/day', {
        query: { employeeId: target!.employeeId, date: target!.date },
      }),
    enabled: target !== null,
  });

  const day = query.data;

  const [form, setForm] = React.useState<CorrectionForm | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Reset the form whenever a different day is opened, or the day reloads
  // after a correction: an editor holding stale values is how a second
  // correction undoes the first.
  React.useEffect(() => {
    if (!day) {
      setForm(null);
      return;
    }
    setErrors({});
    setForm({
      checkInAt: toLocalInput(day.processed.checkInAt),
      checkOutAt: toLocalInput(day.processed.checkOutAt),
      status: day.processed.hasRecord ? day.processed.status : '',
      shiftId: day.processed.shiftId ?? '',
      workedMinutes: '',
      lateMinutes: '',
      earlyLeaveMinutes: '',
      overtimeMinutes: '',
      notes: day.processed.notes ?? '',
      reason: '',
    });
  }, [day]);

  const save = useMutation({
    mutationFn: (values: CorrectionForm) =>
      api.post('/attendance/corrections', {
        employeeId: target!.employeeId,
        date: target!.date,
        checkInAt: fromLocalInput(values.checkInAt),
        checkOutAt: fromLocalInput(values.checkOutAt),
        status: values.status || undefined,
        shiftId: values.shiftId || null,
        // A blank override means "recompute it from the times", which is not
        // the same as "set it to zero" - so blanks are left out entirely.
        workedMinutes: values.workedMinutes === '' ? undefined : Number(values.workedMinutes),
        lateMinutes: values.lateMinutes === '' ? undefined : Number(values.lateMinutes),
        earlyLeaveMinutes:
          values.earlyLeaveMinutes === '' ? undefined : Number(values.earlyLeaveMinutes),
        overtimeMinutes:
          values.overtimeMinutes === '' ? undefined : Number(values.overtimeMinutes),
        notes: values.notes || null,
        reason: values.reason,
      }),
    onSuccess: async () => {
      toast.success('Attendance corrected', {
        description:
          'The original punches are untouched and the change is in the adjustment log. No other day was recalculated.',
        duration: 7000,
      });
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        setErrors(
          Object.fromEntries(
            Object.entries(error.details).map(([field, messages]) => [field, messages[0] ?? '']),
          ),
        );
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  return (
    <Dialog open={target !== null} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>
            {day ? `${day.employee.name} - ${formatDate(day.date)}` : 'Attendance day'}
          </DialogTitle>
          <DialogDescription>
            {day
              ? `${day.employee.employeeNumber}${day.employee.departmentName ? ` - ${day.employee.departmentName}` : ''}`
              : 'Loading'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : !day || !form ? (
            <TableSkeleton rows={6} />
          ) : (
            <>
              {/* --- what the day is measured against ------------------------- */}
              <section className="rounded-lg border border-border p-4">
                <h3 className="mb-2 text-sm font-semibold">Measured against</h3>
                <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                  <Detail
                    label="Shift"
                    value={
                      day.shift.assigned
                        ? `${day.shift.name} (${day.shift.startTime}-${day.shift.endTime})`
                        : `Company default (${day.shift.startTime}-${day.shift.endTime})`
                    }
                  />
                  <Detail label="Rostered" value={minutesLabel(day.shift.expectedMinutes)} />
                  <Detail
                    label="Rules"
                    value={day.rules.policyName ?? 'Company attendance rules'}
                  />
                  <Detail
                    label="Grace"
                    value={`${day.rules.graceMinutes}m late, ${day.rules.earlyLeaveGraceMinutes}m early`}
                  />
                  <Detail
                    label="Full day from"
                    value={`${day.rules.fullDayMinutes}m (tolerance ${day.rules.fullDayToleranceMinutes}m)`}
                  />
                  <Detail
                    label="PunchCodes"
                    value={
                      day.employee.punchCodes.length === 0
                        ? 'None mapped on this day'
                        : day.employee.punchCodes
                            .map((c) => `${c.deviceUserId} on ${c.deviceName}`)
                            .join(', ')
                    }
                  />
                </dl>
                {day.rules.fromShift.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Overridden by the shift: {day.rules.fromShift.join(', ')}.
                  </p>
                ) : null}
              </section>

              {/* --- stored vs the punches ------------------------------------ */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Stored, and what the punches say</h3>
                <TableWrapper>
                  <Table>
                    <THead>
                      <TR>
                        <TH />
                        <TH>Status</TH>
                        <TH>In</TH>
                        <TH>Out</TH>
                        <TH>Worked</TH>
                        <TH>Late</TH>
                        <TH>Early</TH>
                        <TH>OT</TH>
                      </TR>
                    </THead>
                    <TBody>
                      <TR>
                        <TD className="font-medium">Stored</TD>
                        <TD>
                          <span className={STATUS_BADGE[day.processed.status]}>
                            {DERIVED_ATTENDANCE_STATUS_LABELS[day.processed.status]}
                          </span>
                        </TD>
                        <TD>{timeLabel(day.processed.checkInAt)}</TD>
                        <TD>{timeLabel(day.processed.checkOutAt)}</TD>
                        <TD>{minutesLabel(day.processed.workedMinutes)}</TD>
                        <TD>{minutesLabel(day.processed.lateMinutes)}</TD>
                        <TD>{minutesLabel(day.processed.earlyLeaveMinutes)}</TD>
                        <TD>{minutesLabel(day.processed.overtimeMinutes)}</TD>
                      </TR>
                      {day.fromPunches ? (
                        <TR>
                          <TD className="font-medium">From punches</TD>
                          <TD className="text-muted-foreground">{day.fromPunches.status}</TD>
                          <TD>{timeLabel(day.fromPunches.checkInAt)}</TD>
                          <TD>{timeLabel(day.fromPunches.checkOutAt)}</TD>
                          <TD>{minutesLabel(day.fromPunches.workedMinutes)}</TD>
                          <TD>{minutesLabel(day.fromPunches.lateMinutes)}</TD>
                          <TD>{minutesLabel(day.fromPunches.earlyLeaveMinutes)}</TD>
                          <TD>{minutesLabel(day.fromPunches.overtimeMinutes)}</TD>
                        </TR>
                      ) : null}
                    </TBody>
                  </Table>
                </TableWrapper>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  The second row is what today&rsquo;s rules would make of the punches below. It is
                  shown for comparison and is never written.
                </p>
              </section>

              {/* --- the evidence -------------------------------------------- */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
                  Original punches
                </h3>
                {day.rawPunches.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">
                    No device punches for this day. The record was entered by hand or inferred.
                  </p>
                ) : (
                  <TableWrapper>
                    <Table>
                      <THead>
                        <TR>
                          <TH>Time</TH>
                          <TH>Device</TH>
                          <TH>PunchCode</TH>
                          <TH>Direction</TH>
                          <TH>Used as</TH>
                          <TH>Imported</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {day.rawPunches.map((punch) => (
                          <TR key={punch.id}>
                            <TD className="whitespace-nowrap font-medium">
                              {timeLabel(punch.punchedAt)}
                            </TD>
                            <TD className="text-muted-foreground">{punch.deviceName}</TD>
                            <TD className="text-muted-foreground">{punch.deviceUserId}</TD>
                            <TD className="text-muted-foreground">{punch.punchState ?? '--'}</TD>
                            <TD>
                              {punch.role ? (
                                <span className="rounded-md border border-border px-1.5 py-0.5 text-xs font-medium">
                                  {punch.role === 'IN' ? 'Check-in' : 'Check-out'}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">--</span>
                              )}
                            </TD>
                            <TD className="whitespace-nowrap text-xs text-muted-foreground">
                              {formatDate(punch.importedAt)}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </TableWrapper>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Punches are evidence and are never edited by a correction.
                </p>
              </section>

              {/* --- the correction ------------------------------------------ */}
              {canManage ? (
                <section className="rounded-lg border border-border p-4">
                  <h3 className="mb-3 text-sm font-semibold">Correct this day</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label="Check-in"
                      htmlFor="correct-in"
                      error={errors.checkInAt}
                    >
                      <Input
                        type="datetime-local"
                        value={form.checkInAt}
                        onChange={(e) => setForm({ ...form, checkInAt: e.target.value })}
                      />
                    </FormField>
                    <FormField
                      label="Check-out"
                      htmlFor="correct-out"
                      error={errors.checkOutAt}
                    >
                      <Input
                        type="datetime-local"
                        value={form.checkOutAt}
                        onChange={(e) => setForm({ ...form, checkOutAt: e.target.value })}
                      />
                    </FormField>
                    <FormField label="Status" htmlFor="correct-status" error={errors.status}>
                      <NativeSelect
                        value={form.status}
                        onChange={(e) => setForm({ ...form, status: e.target.value })}
                      >
                        <option value="">Recompute from the times</option>
                        {ATTENDANCE_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {ATTENDANCE_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                    <FormField
                      label="Shift"
                      htmlFor="correct-shift"
                      hint="Blank scores the day against the company default."
                      error={errors.shiftId}
                    >
                      <Input
                        value={form.shiftId}
                        onChange={(e) => setForm({ ...form, shiftId: e.target.value })}
                        placeholder={day.shift.id ?? 'None'}
                      />
                    </FormField>
                  </div>

                  <p className="mb-2 mt-4 text-xs text-muted-foreground">
                    Leave the minute boxes blank to have them recomputed from the times above. Fill
                    one only when the arithmetic is right and the world is wrong - a terminal whose
                    clock drifted, say.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <FormField label="Worked" htmlFor="correct-worked" error={errors.workedMinutes}>
                      <Input
                        type="number"
                        min={0}
                        value={form.workedMinutes}
                        onChange={(e) => setForm({ ...form, workedMinutes: e.target.value })}
                        placeholder={String(day.processed.workedMinutes ?? '')}
                      />
                    </FormField>
                    <FormField label="Late" htmlFor="correct-late" error={errors.lateMinutes}>
                      <Input
                        type="number"
                        min={0}
                        value={form.lateMinutes}
                        onChange={(e) => setForm({ ...form, lateMinutes: e.target.value })}
                        placeholder={String(day.processed.lateMinutes ?? '')}
                      />
                    </FormField>
                    <FormField
                      label="Early leave"
                      htmlFor="correct-early"
                      error={errors.earlyLeaveMinutes}
                    >
                      <Input
                        type="number"
                        min={0}
                        value={form.earlyLeaveMinutes}
                        onChange={(e) => setForm({ ...form, earlyLeaveMinutes: e.target.value })}
                        placeholder={String(day.processed.earlyLeaveMinutes ?? '')}
                      />
                    </FormField>
                    <FormField
                      label="Overtime"
                      htmlFor="correct-ot"
                      error={errors.overtimeMinutes}
                    >
                      <Input
                        type="number"
                        min={0}
                        value={form.overtimeMinutes}
                        onChange={(e) => setForm({ ...form, overtimeMinutes: e.target.value })}
                        placeholder={String(day.processed.overtimeMinutes ?? '')}
                      />
                    </FormField>
                  </div>

                  <div className="mt-4 grid gap-3">
                    <FormField label="Notes" htmlFor="correct-notes" error={errors.notes}>
                      <Input
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      />
                    </FormField>
                    <FormField
                      label="Reason"
                      htmlFor="correct-reason"
                      required
                      hint="Recorded against the change, with your name and the old value."
                      error={errors.reason}
                    >
                      <Textarea
                        rows={2}
                        value={form.reason}
                        onChange={(e) => setForm({ ...form, reason: e.target.value })}
                      />
                    </FormField>
                  </div>
                </section>
              ) : null}

              {/* --- the ledger ---------------------------------------------- */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <History className="size-4 text-muted-foreground" aria-hidden />
                  Corrections to this day
                </h3>
                {day.adjustments.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">
                    Nobody has corrected this day.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {day.adjustments.map((entry) => (
                      <li key={entry.id} className="rounded-lg border border-border p-3 text-[13px]">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium">{entry.actorName ?? 'System'}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{entry.reason}</p>
                        <ul className="mt-2 space-y-0.5 text-xs">
                          {entry.changedFields.map((field) => (
                            <li key={field}>
                              <span className="font-medium">{field}</span>{' '}
                              <span className="text-muted-foreground">
                                {String(entry.before[field] ?? '--')} &rarr;{' '}
                                {String(entry.after[field] ?? '--')}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {canManage ? (
            <Button
              type="button"
              loading={save.isPending}
              disabled={!form || form.reason.trim().length < 3}
              onClick={() => form && save.mutate(form)}
            >
              Save correction
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{value}</dd>
    </div>
  );
}
