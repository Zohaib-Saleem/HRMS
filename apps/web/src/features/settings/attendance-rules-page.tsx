import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Info, Save } from 'lucide-react';
import {
  PERMISSIONS,
  WEEK_DAY_LABELS,
  attendanceRulesSchema,
  type AttendanceRulesInput,
  type AttendanceRulesView,
  type WeekDay,
} from '@hrms/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormField, Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { cn } from '@/lib/utils';

/**
 * Attendance rules - Super Admin only.
 *
 * The rules that decide what a day is worth. They write to the same company
 * record the attendance policy screen uses; what makes this screen separate is
 * the gate, not the storage. Everything the overtime calculation reads is here,
 * so no clock time or threshold is written into the code.
 *
 * The worked examples down the right recompute as the form changes, using the
 * same arithmetic the server does. They are there because the difference
 * between "overtime after the shift ends" and "overtime after nine hours" is
 * invisible in a form and obvious in an example.
 */

const MINUTES_PER_DAY = 24 * 60;

/** "HH:mm" to minutes since midnight, or null when unparseable. */
function toMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const fmt = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

interface Outcome {
  late: number | null;
  overtime: number | null;
  early: number | null;
  irregular: boolean;
}

/**
 * The same rules the server applies, for the preview only.
 *
 * Deliberately a mirror rather than a shared module: this runs against
 * unsaved form values, has no shift assignment to resolve and no timezone to
 * reason about. It is a worked example, and nothing is ever stored from it.
 */
function preview(rules: AttendanceRulesInput, inAt: string, outAt: string): Outcome {
  const start = toMinutes(rules.defaultShiftStart);
  const end = toMinutes(rules.defaultShiftEnd);
  const cutoff = toMinutes(rules.irregularCheckInCutoff);
  const arrive = toMinutes(inAt);
  const leave = toMinutes(outAt);
  if (start === null || end === null || arrive === null || leave === null) {
    return { late: null, overtime: null, early: null, irregular: false };
  }

  const irregular = rules.irregularCheckInEnabled && cutoff !== null && arrive > cutoff;

  const rawLate = Math.max(0, arrive - start);
  const late = rules.lateTrackingEnabled ? (rawLate > rules.graceMinutes ? rawLate : 0) : null;

  const rawEarly = Math.max(0, end - leave);
  const early = rules.earlyDepartureTrackingEnabled
    ? rawEarly > rules.earlyLeaveGraceMinutes
      ? rawEarly
      : 0
    : null;

  let overtime: number | null;
  if (!rules.overtimeEnabled) overtime = 0;
  else if (irregular) overtime = null;
  else if (!rules.overtimeFromShiftEnd) {
    const elapsed = leave - arrive;
    overtime = Math.min(Math.max(0, elapsed - (end - start)), rules.overtimeDailyCapMinutes);
  } else {
    let minutes = Math.max(0, leave - end);
    if (rules.overtimeCountsEarlyArrival) minutes += Math.max(0, start - arrive);
    if (rules.overtimeReducedByLateArrival) minutes -= rawLate > rules.graceMinutes ? rawLate : 0;
    overtime = Math.min(Math.max(0, minutes), rules.overtimeDailyCapMinutes);
  }

  return { late, overtime, early, irregular };
}

const EXAMPLES: Array<[string, string]> = [
  ['09:00', '18:00'],
  ['09:00', '18:30'],
  ['09:15', '18:30'],
  ['08:43', '18:00'],
  ['09:00', '17:30'],
  ['14:00', '21:00'],
];

function Examples({ rules }: { rules: AttendanceRulesInput }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What these rules produce</CardTitle>
        <CardDescription>
          Recalculated as you edit, against the default window. An employee with their own shift is
          measured against that instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="w-full overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="border-y border-border bg-surface-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Day</th>
                <th className="px-4 py-2 text-right font-semibold">Late</th>
                <th className="px-4 py-2 text-right font-semibold">Early out</th>
                <th className="px-4 py-2 text-right font-semibold">Overtime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {EXAMPLES.map(([inAt, outAt]) => {
                const o = preview(rules, inAt, outAt);
                const cell = (v: number | null) =>
                  v === null ? <span className="text-muted-foreground">&mdash;</span> : `${v}m`;
                return (
                  <tr key={`${inAt}-${outAt}`}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium">
                      {inAt} &rarr; {outAt}
                      {o.irregular ? (
                        <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                          irregular
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right">{cell(o.late)}</td>
                    <td className="px-4 py-2 text-right">{cell(o.early)}</td>
                    <td
                      className={cn(
                        'px-4 py-2 text-right font-semibold',
                        o.overtime ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {cell(o.overtime)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/** A labelled on/off control. Native checkbox, so it is keyboard-reachable. */
function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent/40',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

export function AttendanceRulesPage() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['company', 'attendance-rules'],
    queryFn: () => api.get<AttendanceRulesView>('/company/attendance-rules'),
  });

  // The server decides; the UI only reflects it. Both are checked, because a
  // hidden control is a courtesy and the endpoint is the actual gate.
  const canManage = has(PERMISSIONS.SETTINGS_MANAGE) && (query.data?.canManage ?? false);

  const form = useForm<AttendanceRulesInput>({
    resolver: zodResolver(attendanceRulesSchema),
    values: query.data
      ? {
          defaultShiftStart: query.data.defaultShiftStart,
          defaultShiftEnd: query.data.defaultShiftEnd,
          overtimeEnabled: query.data.overtimeEnabled,
          overtimeFromShiftEnd: query.data.overtimeFromShiftEnd,
          overtimeCountsEarlyArrival: query.data.overtimeCountsEarlyArrival,
          overtimeReducedByLateArrival: query.data.overtimeReducedByLateArrival,
          overtimeDailyCapMinutes: query.data.overtimeDailyCapMinutes,
          lateTrackingEnabled: query.data.lateTrackingEnabled,
          graceMinutes: query.data.graceMinutes,
          earlyDepartureTrackingEnabled: query.data.earlyDepartureTrackingEnabled,
          earlyLeaveGraceMinutes: query.data.earlyLeaveGraceMinutes,
          irregularCheckInEnabled: query.data.irregularCheckInEnabled,
          irregularCheckInCutoff: query.data.irregularCheckInCutoff,
        }
      : undefined,
  });

  const live = useWatch({ control: form.control }) as AttendanceRulesInput | undefined;

  const save = useMutation({
    mutationFn: (input: AttendanceRulesInput) =>
      api.patch<AttendanceRulesView>('/company/attendance-rules', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['company'] });
      toast.success('Attendance rules saved', {
        description: 'They apply to attendance processed from now on. Nothing was recalculated.',
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          form.setError(field as keyof AttendanceRulesInput, { message: messages[0] });
        }
        return;
      }
      toast.error('Could not save', { description: errorMessage(error) });
    },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const rules = query.data;
  const window =
    (toMinutes(live?.defaultShiftEnd ?? rules.defaultShiftEnd) ?? 0) -
    (toMinutes(live?.defaultShiftStart ?? rules.defaultShiftStart) ?? 0);
  const windowMinutes = window > 0 ? window : window + MINUTES_PER_DAY;

  return (
    <form
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
      className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start"
    >
      <div className="space-y-5">
        {!canManage ? (
          <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-muted/50 p-4 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-muted-foreground">
              These rules are read-only for you. Only a Super Admin can change them.
            </p>
          </div>
        ) : null}

        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p>
            Changing attendance rules affects future processing. Existing attendance will not be
            recalculated automatically.
          </p>
        </div>

        {/* --- general ----------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">General</CardTitle>
            <CardDescription>
              Set on the company profile and the attendance policy. Shown here for context.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Timezone</p>
              <p className="text-sm font-medium">{rules.timezone}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Working week</p>
              <p className="text-sm font-medium">
                {rules.weekendDays.length === 0
                  ? 'Every day is a working day'
                  : `All except ${rules.weekendDays.map((d: WeekDay) => WEEK_DAY_LABELS[d]).join(', ')}`}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* --- shift defaults ---------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Shift defaults</CardTitle>
            <CardDescription>
              The window used for an employee with no shift assignment. An assigned shift always
              takes precedence over these times.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Default start"
              htmlFor="defaultShiftStart"
              error={form.formState.errors.defaultShiftStart?.message}
            >
              <Input
                id="defaultShiftStart"
                type="time"
                disabled={!canManage}
                {...form.register('defaultShiftStart')}
              />
            </FormField>
            <FormField
              label="Default end"
              htmlFor="defaultShiftEnd"
              error={form.formState.errors.defaultShiftEnd?.message}
            >
              <Input
                id="defaultShiftEnd"
                type="time"
                disabled={!canManage}
                {...form.register('defaultShiftEnd')}
              />
            </FormField>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Scheduled window: <strong>{fmt(windowMinutes)}</strong> ({windowMinutes} minutes). The
              break sits inside this window and is never subtracted from it when overtime is
              calculated. Payroll&rsquo;s net working hours are configured separately.
            </p>
          </CardContent>
        </Card>

        {/* --- overtime ----------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overtime</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="overtimeEnabled"
                render={({ field }) => (
                  <Toggle
                    label="Track overtime"
                    checked={field.value}
                    disabled={!canManage}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                control={form.control}
                name="overtimeFromShiftEnd"
                render={({ field }) => (
                  <Toggle
                    label="Start after shift end"
                    hint="Off: overtime is elapsed time beyond a fixed duration, which charges the break to the company."
                    checked={field.value}
                    disabled={!canManage}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                control={form.control}
                name="overtimeCountsEarlyArrival"
                render={({ field }) => (
                  <Toggle
                    label="Early arrival counts as overtime"
                    hint="Off by default: turning up early is not overtime."
                    checked={field.value}
                    disabled={!canManage}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                control={form.control}
                name="overtimeReducedByLateArrival"
                render={({ field }) => (
                  <Toggle
                    label="Late arrival reduces overtime"
                    hint="Off by default: lateness and overtime are independent."
                    checked={field.value}
                    disabled={!canManage}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
            <FormField
              label="Daily overtime maximum (minutes)"
              htmlFor="overtimeDailyCapMinutes"
              hint="Stops a forgotten check-out booking a whole evening."
              error={form.formState.errors.overtimeDailyCapMinutes?.message}
            >
              <Input
                id="overtimeDailyCapMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('overtimeDailyCapMinutes')}
              />
            </FormField>
          </CardContent>
        </Card>

        {/* --- late / early -------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Late arrival and early departure</CardTitle>
            <CardDescription>Both measured against the applicable shift.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="lateTrackingEnabled"
              render={({ field }) => (
                <Toggle
                  label="Track late arrival"
                  checked={field.value}
                  disabled={!canManage}
                  onChange={field.onChange}
                />
              )}
            />
            <Controller
              control={form.control}
              name="earlyDepartureTrackingEnabled"
              render={({ field }) => (
                <Toggle
                  label="Track early departure"
                  checked={field.value}
                  disabled={!canManage}
                  onChange={field.onChange}
                />
              )}
            />
            <FormField
              label="Late grace (minutes)"
              htmlFor="graceMinutes"
              hint="Decides whether someone is late, not how late: past it, the full lateness is recorded."
              error={form.formState.errors.graceMinutes?.message}
            >
              <Input
                id="graceMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('graceMinutes')}
              />
            </FormField>
            <FormField
              label="Early departure grace (minutes)"
              htmlFor="earlyLeaveGraceMinutes"
              error={form.formState.errors.earlyLeaveGraceMinutes?.message}
            >
              <Input
                id="earlyLeaveGraceMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('earlyLeaveGraceMinutes')}
              />
            </FormField>
          </CardContent>
        </Card>

        {/* --- irregular ----------------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Irregular attendance</CardTitle>
            <CardDescription>
              A day starting after the cutoff does not fit the shift it would be scored against, so
              no overtime is derived from it. The day is still recorded.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="irregularCheckInEnabled"
              render={({ field }) => (
                <Toggle
                  label="Flag irregular check-ins"
                  checked={field.value}
                  disabled={!canManage}
                  onChange={field.onChange}
                />
              )}
            />
            <FormField
              label="Check-in cutoff"
              htmlFor="irregularCheckInCutoff"
              error={form.formState.errors.irregularCheckInCutoff?.message}
            >
              <Input
                id="irregularCheckInCutoff"
                type="time"
                disabled={!canManage}
                {...form.register('irregularCheckInCutoff')}
              />
            </FormField>
          </CardContent>
        </Card>

        {/* --- read-only: half day and missing punches ----------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Half day and missing punches</CardTitle>
            <CardDescription>Unchanged by this screen.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              A day of at least <strong>{rules.halfDayMinutes} minutes</strong> counts as a half day
              and at least <strong>{rules.fullDayMinutes} minutes</strong> as a full day, measured on
              elapsed time. Leaving before the shift ends is recorded as an early departure and does
              not by itself make the day a half day. These thresholds are edited on the attendance
              policy screen.
            </p>
            <p className="text-muted-foreground">
              A day with no check-in is recorded absent. A day with a check-in and no check-out stays
              present with no worked minutes until it is corrected. That behaviour is currently fixed
              in code and is not configurable here.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4 xl:sticky xl:top-20">
        {live ? <Examples rules={live} /> : null}
        {canManage ? (
          <Card>
            <CardFooter className="flex justify-end py-4">
              <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                <Save className="size-4" aria-hidden />
                {save.isPending ? 'Saving...' : 'Save rules'}
              </Button>
            </CardFooter>
          </Card>
        ) : null}
      </div>
    </form>
  );
}
