import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Info, RotateCcw, Save } from 'lucide-react';
import {
  IRREGULAR_CUTOFF_MODES,
  IRREGULAR_CUTOFF_MODE_LABELS,
  MISSING_PUNCH_RULES,
  MISSING_PUNCH_RULE_LABELS,
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
import { FormField, Input, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';
import { ATTENDANCE_RULES_KEY, useAttendanceRules } from './use-attendance-rules';
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
  status: 'Full day' | 'Half day' | 'Absent';
}

/**
 * The same rules the server applies, for the preview only.
 *
 * Deliberately a mirror rather than a shared module: this runs against
 * unsaved form values, has no shift assignment to resolve and no timezone to
 * reason about. It is a worked example, and nothing is ever stored from it.
 */
function preview(
  rules: AttendanceRulesInput,
  thresholds: { fullDayMinutes: number; halfDayMinutes: number },
  inAt: string,
  outAt: string,
): Outcome {
  const start = toMinutes(rules.defaultShiftStart);
  const end = toMinutes(rules.defaultShiftEnd);
  const cutoff = toMinutes(rules.irregularCheckInCutoff);
  const arrive = toMinutes(inAt);
  const leave = toMinutes(outAt);
  if (start === null || end === null || arrive === null || leave === null) {
    return { late: null, overtime: null, early: null, irregular: false, status: 'Absent' };
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

  // Classification: how much of the SCHEDULED shift the day covered, counted
  // from the shift start so lateness is not charged twice. Falls back to
  // elapsed time for an irregular day, exactly as the server does.
  const covered = irregular ? null : Math.max(0, Math.min(leave, end) - start);
  const worth = covered ?? leave - arrive;
  const tolerance = covered === null ? 0 : Math.max(0, rules.fullDayToleranceMinutes);
  const fullDayFrom = Math.max(thresholds.halfDayMinutes, thresholds.fullDayMinutes - tolerance);

  const status: Outcome['status'] =
    worth >= fullDayFrom ? 'Full day' : worth >= thresholds.halfDayMinutes ? 'Half day' : 'Absent';

  return { late, overtime, early, irregular, status };
}

const EXAMPLES: Array<{ label: string; in: string; out: string }> = [
  { label: 'Normal day', in: '09:00', out: '18:00' },
  { label: 'Stayed late', in: '09:00', out: '18:30' },
  { label: 'Late + overtime', in: '09:15', out: '18:30' },
  { label: 'Early arrival', in: '08:43', out: '18:00' },
  { label: 'Early departure', in: '09:00', out: '17:30' },
  { label: 'Irregular', in: '14:00', out: '21:00' },
];

function Examples({
  rules,
  thresholds,
}: {
  rules: AttendanceRulesInput;
  thresholds: { fullDayMinutes: number; halfDayMinutes: number };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How attendance is calculated</CardTitle>
        <CardDescription>
          Recalculated as you edit, against the default window. An employee with their own shift is
          measured against that instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-0">
        {EXAMPLES.map((example) => {
          const o = preview(rules, thresholds, example.in, example.out);
          const parts: string[] = [];
          if (o.late) parts.push(`${o.late} min late`);
          if (o.early) parts.push(`${o.early} min early departure`);
          if (o.overtime === null) parts.push('no overtime derived');
          else parts.push(`${o.overtime} min overtime`);

          return (
            <div
              key={example.label}
              className="rounded-lg border border-border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {example.label}
                </span>
                <span className="font-mono text-sm tabular-nums">
                  {example.in} &rarr; {example.out}
                </span>
              </div>
              <p className="mt-1 text-sm">
                {o.irregular ? (
                  <span className="mr-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                    requires review
                  </span>
                ) : null}
                <span className="font-semibold">{o.status}</span>
                {parts.length > 0 ? ` \u00b7 ${parts.join(' \u00b7 ')}` : null}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * On/off control.
 *
 * A real checkbox underneath, visually a switch: the native input keeps the
 * keyboard and screen-reader behaviour that a div with a click handler throws
 * away.
 */
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
        'flex items-start gap-3 rounded-lg border border-border p-3 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-accent/40',
      )}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span
          aria-hidden
          className={cn(
            'block h-5 w-9 rounded-full bg-muted transition-colors',
            'peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-surface shadow transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Human labels for the confirmation diff, so it does not read as field names. */
const FIELD_LABELS: Record<keyof AttendanceRulesInput, string> = {
  defaultShiftStart: 'Default start',
  defaultShiftEnd: 'Default end',
  overtimeEnabled: 'Track overtime',
  overtimeFromShiftEnd: 'Overtime starts after shift end',
  overtimeCountsEarlyArrival: 'Early arrival counts as overtime',
  overtimeReducedByLateArrival: 'Late arrival reduces overtime',
  overtimeDailyCapMinutes: 'Daily overtime maximum',
  lateTrackingEnabled: 'Track late arrival',
  graceMinutes: 'Late grace',
  earlyDepartureTrackingEnabled: 'Track early departure',
  earlyLeaveGraceMinutes: 'Early departure grace',
  fullDayToleranceMinutes: 'Full-day tolerance',
  irregularCheckInEnabled: 'Flag irregular check-ins',
  irregularCheckInCutoff: 'Check-in cutoff',
  irregularCheckInMode: 'Cutoff measured as',
  irregularAfterShiftStartMinutes: 'Minutes after shift start',
  breakIncludedInWindow: 'Break included in the window',
  overtimeMinimumMinutes: 'Minimum overtime',
  overtimeRoundingMinutes: 'Overtime rounding',
  overtimeWeeklyCapMinutes: 'Weekly overtime cap',
  overtimeMonthlyCapMinutes: 'Monthly overtime cap',
  missingCheckOutStatus: 'Missing check-out',
  missingCheckInStatus: 'Missing check-in',
};

const shown = (v: unknown): string =>
  typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v);

/** The fields that actually differ, for the save confirmation. */
function changedFields(
  before: AttendanceRulesInput,
  after: AttendanceRulesInput,
): Array<{ label: string; from: string; to: string }> {
  return (Object.keys(FIELD_LABELS) as Array<keyof AttendanceRulesInput>)
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      label: FIELD_LABELS[key],
      from: shown(before[key]),
      to: shown(after[key]),
    }));
}

export function AttendanceRulesPage() {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  // The same query the Settings tab strip probes with, so reaching this screen
  // costs no extra request and the two can never disagree about availability.
  const query = useAttendanceRules();

  // The server decides; the UI only reflects it. Both are checked, because a
  // hidden control is a courtesy and the endpoint is the actual gate.
  const canManage = has(PERMISSIONS.SETTINGS_MANAGE) && (query.data?.canManage ?? false);
  const rulesUnavailable = query.state === 'unavailable';

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
          fullDayToleranceMinutes: query.data.fullDayToleranceMinutes,
          irregularCheckInEnabled: query.data.irregularCheckInEnabled,
          irregularCheckInCutoff: query.data.irregularCheckInCutoff,
          irregularCheckInMode: query.data.irregularCheckInMode,
          irregularAfterShiftStartMinutes: query.data.irregularAfterShiftStartMinutes,
          breakIncludedInWindow: query.data.breakIncludedInWindow,
          overtimeMinimumMinutes: query.data.overtimeMinimumMinutes,
          overtimeRoundingMinutes: query.data.overtimeRoundingMinutes,
          overtimeWeeklyCapMinutes: query.data.overtimeWeeklyCapMinutes,
          overtimeMonthlyCapMinutes: query.data.overtimeMonthlyCapMinutes,
          missingCheckOutStatus: query.data.missingCheckOutStatus,
          missingCheckInStatus: query.data.missingCheckInStatus,
        }
      : undefined,
  });

  const live = useWatch({ control: form.control }) as AttendanceRulesInput | undefined;

  const save = useMutation({
    mutationFn: (input: AttendanceRulesInput) =>
      api.patch<AttendanceRulesView>('/company/attendance-rules', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ATTENDANCE_RULES_KEY });
      toast.success('Attendance rules saved', {
        description:
          'Attendance rule changes apply to future attendance processing. Existing attendance records are not recalculated automatically.',
        duration: 8000,
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

  if (query.state === 'checking') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  /**
   * Reached directly while the endpoint is not deployed.
   *
   * The tab is already hidden, so this is a typed URL or a stale bookmark.
   * Sending them back to Settings is a better answer than an error card about
   * a screen they were never offered.
   */
  if (rulesUnavailable || !query.data) {
    return <Navigate to="/settings" replace />;
  }

  const rules = query.data;
  // The persisted values, as the baseline the confirmation diffs against.
  const saved: AttendanceRulesInput = {
    defaultShiftStart: rules.defaultShiftStart,
    defaultShiftEnd: rules.defaultShiftEnd,
    overtimeEnabled: rules.overtimeEnabled,
    overtimeFromShiftEnd: rules.overtimeFromShiftEnd,
    overtimeCountsEarlyArrival: rules.overtimeCountsEarlyArrival,
    overtimeReducedByLateArrival: rules.overtimeReducedByLateArrival,
    overtimeDailyCapMinutes: rules.overtimeDailyCapMinutes,
    lateTrackingEnabled: rules.lateTrackingEnabled,
    graceMinutes: rules.graceMinutes,
    earlyDepartureTrackingEnabled: rules.earlyDepartureTrackingEnabled,
    earlyLeaveGraceMinutes: rules.earlyLeaveGraceMinutes,
    fullDayToleranceMinutes: rules.fullDayToleranceMinutes,
    irregularCheckInEnabled: rules.irregularCheckInEnabled,
    irregularCheckInCutoff: rules.irregularCheckInCutoff,
    irregularCheckInMode: rules.irregularCheckInMode,
    irregularAfterShiftStartMinutes: rules.irregularAfterShiftStartMinutes,
    breakIncludedInWindow: rules.breakIncludedInWindow,
    overtimeMinimumMinutes: rules.overtimeMinimumMinutes,
    overtimeRoundingMinutes: rules.overtimeRoundingMinutes,
    overtimeWeeklyCapMinutes: rules.overtimeWeeklyCapMinutes,
    overtimeMonthlyCapMinutes: rules.overtimeMonthlyCapMinutes,
    missingCheckOutStatus: rules.missingCheckOutStatus,
    missingCheckInStatus: rules.missingCheckInStatus,
  };
  const window =
    (toMinutes(live?.defaultShiftEnd ?? rules.defaultShiftEnd) ?? 0) -
    (toMinutes(live?.defaultShiftStart ?? rules.defaultShiftStart) ?? 0);
  const windowMinutes = window > 0 ? window : window + MINUTES_PER_DAY;

  return (
    <form
      onSubmit={form.handleSubmit(async (values) => {
        // Show exactly what is about to change, old value to new, before it is
        // written. A settings screen that saves silently is how a rule gets
        // changed by accident and noticed a payroll later.
        const changes = changedFields(saved, values);
        if (changes.length === 0) return;

        const ok = await confirm({
          title: 'Save attendance rules?',
          confirmLabel: 'Save rules',
          description: (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Setting</th>
                      <th className="px-3 py-2 font-semibold">Current</th>
                      <th className="px-3 py-2 font-semibold">New</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {changes.map((c) => (
                      <tr key={c.label}>
                        <td className="px-3 py-2">{c.label}</td>
                        <td className="px-3 py-2 text-muted-foreground">{c.from}</td>
                        <td className="px-3 py-2 font-semibold">{c.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-muted-foreground">
                These apply to attendance processed from now on. Existing attendance records are not
                recalculated.
              </p>
            </div>
          ),
        });

        if (ok) save.mutate(values);
      })}
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
              <p className="text-xs text-muted-foreground">Edited on the Company screen.</p>
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
            <div className="sm:col-span-2">
              <Controller
                control={form.control}
                name="breakIncludedInWindow"
                render={({ field }) => (
                  <Toggle
                    label="Break is included inside the shift window"
                    hint="On: the window already accounts for it and nothing is subtracted. Off: the shift's break is deducted from the day."
                    checked={field.value}
                    disabled={!canManage}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-surface-muted/40 p-3 text-xs text-muted-foreground sm:col-span-2">
              <p>
                Scheduled presence window: <strong className="text-foreground">{fmt(windowMinutes)}</strong>{' '}
                ({windowMinutes} minutes). The break sits inside this window and is never subtracted
                from it when overtime is calculated.
              </p>
              <div>
                <p className="mb-1 font-semibold text-foreground">Which shift applies</p>
                <p>
                  These times are the default. An employee&rsquo;s own shift assignment takes
                  precedence whenever they have one &mdash; so an employee assigned 10:00&ndash;19:00
                  starts earning overtime after <strong className="text-foreground">19:00</strong>,
                  not after {live?.defaultShiftEnd ?? rules.defaultShiftEnd}. There is no blanket
                  rule.
                </p>
              </div>
              <div>
                <p className="mb-1 font-semibold text-foreground">Three separate numbers</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <strong className="text-foreground">{windowMinutes} minutes</strong> &mdash;
                    scheduled office presence, start to end. Overtime is measured from the end of it.
                  </li>
                  <li>
                    <strong className="text-foreground">{rules.fullDayMinutes} minutes</strong> &mdash;
                    the full-day threshold, measured on elapsed time, deciding present vs half day.
                  </li>
                  <li>
                    <strong className="text-foreground">8 hours</strong> &mdash; payroll&rsquo;s
                    standard hours per day, used to price a day. Configured in payroll settings and
                    not changed here.
                  </li>
                </ul>
              </div>
            </div>
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
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Daily overtime maximum (minutes)"
                htmlFor="overtimeDailyCapMinutes"
                hint="Stops a forgotten check-out booking a whole evening."
                error={form.formState.errors.overtimeDailyCapMinutes?.message}
              >
                <Input id="overtimeDailyCapMinutes" type="number" min={0} disabled={!canManage}
                  {...form.register('overtimeDailyCapMinutes')} />
              </FormField>
              <FormField
                label="Minimum overtime (minutes)"
                htmlFor="overtimeMinimumMinutes"
                hint="Shorter overruns are not credited. Zero credits every minute."
                error={form.formState.errors.overtimeMinimumMinutes?.message}
              >
                <Input id="overtimeMinimumMinutes" type="number" min={0} disabled={!canManage}
                  {...form.register('overtimeMinimumMinutes')} />
              </FormField>
              <FormField
                label="Round overtime down to (minutes)"
                htmlFor="overtimeRoundingMinutes"
                hint="Always downwards, so rounding cannot create time nobody worked. Zero is no rounding."
                error={form.formState.errors.overtimeRoundingMinutes?.message}
              >
                <Input id="overtimeRoundingMinutes" type="number" min={0} disabled={!canManage}
                  {...form.register('overtimeRoundingMinutes')} />
              </FormField>
              <FormField
                label="Weekly overtime cap (minutes)"
                htmlFor="overtimeWeeklyCapMinutes"
                hint="Leave empty for no weekly ceiling."
                error={form.formState.errors.overtimeWeeklyCapMinutes?.message}
              >
                <Input id="overtimeWeeklyCapMinutes" type="number" min={0} disabled={!canManage}
                  {...form.register('overtimeWeeklyCapMinutes', { setValueAs: (v) => (v === '' ? null : Number(v)) })} />
              </FormField>
              <FormField
                label="Monthly overtime cap (minutes)"
                htmlFor="overtimeMonthlyCapMinutes"
                hint="Leave empty for no monthly ceiling."
                error={form.formState.errors.overtimeMonthlyCapMinutes?.message}
              >
                <Input id="overtimeMonthlyCapMinutes" type="number" min={0} disabled={!canManage}
                  {...form.register('overtimeMonthlyCapMinutes', { setValueAs: (v) => (v === '' ? null : Number(v)) })} />
              </FormField>
            </div>
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
              hint="Below this, no early departure is recorded at all."
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
            <FormField
              label="Full-day tolerance (minutes)"
              htmlFor="fullDayToleranceMinutes"
              hint="How far short of a full day someone may fall and still be credited one. The early departure is still recorded."
              error={form.formState.errors.fullDayToleranceMinutes?.message}
              className="sm:col-span-2"
            >
              <Input
                id="fullDayToleranceMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('fullDayToleranceMinutes')}
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
              label="Cutoff measured as"
              htmlFor="irregularCheckInMode"
              hint="A fixed time only describes one shared schedule. Measuring from the shift start works for any shift, including nights."
              error={form.formState.errors.irregularCheckInMode?.message}
            >
              <NativeSelect id="irregularCheckInMode" disabled={!canManage}
                {...form.register('irregularCheckInMode')}>
                {IRREGULAR_CUTOFF_MODES.map((mode) => (
                  <option key={mode} value={mode}>{IRREGULAR_CUTOFF_MODE_LABELS[mode]}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Check-in cutoff (fixed time)"
              htmlFor="irregularCheckInCutoff"
              error={form.formState.errors.irregularCheckInCutoff?.message}
            >
              <Input id="irregularCheckInCutoff" type="time" disabled={!canManage}
                {...form.register('irregularCheckInCutoff')} />
            </FormField>
            <FormField
              label="Minutes after shift start"
              htmlFor="irregularAfterShiftStartMinutes"
              hint="Used when the cutoff is measured from the shift start."
              error={form.formState.errors.irregularAfterShiftStartMinutes?.message}
            >
              <Input id="irregularAfterShiftStartMinutes" type="number" min={0} disabled={!canManage}
                {...form.register('irregularAfterShiftStartMinutes')} />
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
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Day with a check-in and no check-out"
                htmlFor="missingCheckOutStatus"
                error={form.formState.errors.missingCheckOutStatus?.message}
              >
                <NativeSelect id="missingCheckOutStatus" disabled={!canManage}
                  {...form.register('missingCheckOutStatus')}>
                  {MISSING_PUNCH_RULES.map((rule) => (
                    <option key={rule} value={rule}>{MISSING_PUNCH_RULE_LABELS[rule]}</option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField
                label="Day with no check-in at all"
                htmlFor="missingCheckInStatus"
                error={form.formState.errors.missingCheckInStatus?.message}
              >
                <NativeSelect id="missingCheckInStatus" disabled={!canManage}
                  {...form.register('missingCheckInStatus')}>
                  {MISSING_PUNCH_RULES.map((rule) => (
                    <option key={rule} value={rule}>{MISSING_PUNCH_RULE_LABELS[rule]}</option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4 xl:sticky xl:top-20">
        {live ? (
          <Examples
            rules={live}
            thresholds={{
              fullDayMinutes: rules.fullDayMinutes,
              halfDayMinutes: rules.halfDayMinutes,
            }}
          />
        ) : null}
        {canManage ? (
          <Card>
            <CardFooter className="flex flex-wrap justify-end gap-2 py-4">
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending || !form.formState.isDirty}
                onClick={() => form.reset(saved)}
              >
                <RotateCcw className="size-4" aria-hidden />
                Reset
              </Button>
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
