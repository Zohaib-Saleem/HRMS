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
  NON_WORKING_DAY_WORK_RULES,
  NON_WORKING_DAY_WORK_RULE_LABELS,
  PERMISSIONS,
  WEEK_DAYS,
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
  defaultBreakMinutes: 'Default break',
  weekendDays: 'Weekend days',
  halfDayMinutes: 'Half-day minutes',
  fullDayMinutes: 'Full-day minutes',
  lateThresholdMinutes: 'Late flag threshold',
  earlyLeaveThresholdMinutes: 'Early-leave flag threshold',
  weekendWorkRule: 'Work on a weekend',
  holidayWorkRule: 'Work on a holiday',
  duplicatePunchWindowSeconds: 'Duplicate punch window',
  maxPlausibleSpanMinutes: 'Longest believable day',
  allowImplausibleSpans: 'Score implausible days anyway',
  overnightCheckOutWindowMinutes: 'A day can still be closed for',
  overnightCheckOutCutoff: 'Last time a punch can close yesterday',
};

const shown = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.length === 0 ? 'None' : v.join(', ');
  if (v === null) return 'No limit';
  return String(v);
};

/** The fields that actually differ, for the save confirmation. */
function changedFields(
  before: AttendanceRulesInput,
  after: AttendanceRulesInput,
): Array<{ label: string; from: string; to: string }> {
  return (Object.keys(FIELD_LABELS) as Array<keyof AttendanceRulesInput>)
    // `weekendDays` is an array, so reference inequality would report it as
    // changed on every save. Compare what the reader would compare: the value.
    .filter((key) => shown(before[key]) !== shown(after[key]))
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
  // Either permission opens the form: `settings.manage` is Super Admin's, and
  // `attendance.rules.manage` exists so HR can be granted these alone. The
  // server decides regardless - `canManage` on the payload is the real answer
  // and a hidden control was never the gate.
  const canManage =
    (has(PERMISSIONS.SETTINGS_MANAGE) || has(PERMISSIONS.ATTENDANCE_RULES_MANAGE)) &&
    (query.data?.canManage ?? false);
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
          defaultBreakMinutes: query.data.defaultBreakMinutes,
          weekendDays: query.data.weekendDays,
          halfDayMinutes: query.data.halfDayMinutes,
          fullDayMinutes: query.data.fullDayMinutes,
          lateThresholdMinutes: query.data.lateThresholdMinutes,
          earlyLeaveThresholdMinutes: query.data.earlyLeaveThresholdMinutes,
          weekendWorkRule: query.data.weekendWorkRule,
          holidayWorkRule: query.data.holidayWorkRule,
          duplicatePunchWindowSeconds: query.data.duplicatePunchWindowSeconds,
          maxPlausibleSpanMinutes: query.data.maxPlausibleSpanMinutes,
          allowImplausibleSpans: query.data.allowImplausibleSpans,
          overnightCheckOutWindowMinutes: query.data.overnightCheckOutWindowMinutes,
          overnightCheckOutCutoff: query.data.overnightCheckOutCutoff,
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
    defaultBreakMinutes: rules.defaultBreakMinutes,
    weekendDays: rules.weekendDays,
    halfDayMinutes: rules.halfDayMinutes,
    fullDayMinutes: rules.fullDayMinutes,
    lateThresholdMinutes: rules.lateThresholdMinutes,
    earlyLeaveThresholdMinutes: rules.earlyLeaveThresholdMinutes,
    weekendWorkRule: rules.weekendWorkRule,
    holidayWorkRule: rules.holidayWorkRule,
    duplicatePunchWindowSeconds: rules.duplicatePunchWindowSeconds,
    maxPlausibleSpanMinutes: rules.maxPlausibleSpanMinutes,
    allowImplausibleSpans: rules.allowImplausibleSpans,
    overnightCheckOutWindowMinutes: rules.overnightCheckOutWindowMinutes,
    overnightCheckOutCutoff: rules.overnightCheckOutCutoff,
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
              The working week, and the timezone every clock time on this screen is read in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Timezone</p>
              <p className="text-sm font-medium">{rules.timezone}</p>
              <p className="text-xs text-muted-foreground">Edited on the Company screen.</p>
            </div>

            <Controller
              control={form.control}
              name="weekendDays"
              render={({ field }) => {
                const selected = (field.value ?? []) as WeekDay[];
                return (
                  <fieldset>
                    <legend className="mb-1.5 text-[13px] font-medium">Weekend days</legend>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Days nobody is expected. Attendance is never counted against them, and a
                      shift may still override this with its own working days.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {WEEK_DAYS.map((day) => (
                        <label
                          key={day}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-xs',
                            canManage ? 'cursor-pointer hover:bg-accent/40' : 'cursor-not-allowed opacity-60',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 rounded border-input accent-[var(--primary)]"
                            disabled={!canManage}
                            checked={selected.includes(day)}
                            onChange={(event) =>
                              field.onChange(
                                event.target.checked
                                  ? [...selected, day]
                                  : selected.filter((d) => d !== day),
                              )
                            }
                          />
                          {WEEK_DAY_LABELS[day]}
                        </label>
                      ))}
                    </div>
                    {form.formState.errors.weekendDays ? (
                      <p className="mt-1.5 text-xs text-destructive">
                        {form.formState.errors.weekendDays.message}
                      </p>
                    ) : null}
                  </fieldset>
                );
              }}
            />
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

        {/* --- what a day is worth ------------------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What a day is worth</CardTitle>
            <CardDescription>
              The thresholds that decide whether a day is a full day, a half day or an absence -
              and what a day with a punch missing on one end counts as.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                label="Full-day minutes"
                htmlFor="fullDayMinutes"
                hint={`The ${windowMinutes}-minute window, less any tolerance below.`}
                error={form.formState.errors.fullDayMinutes?.message}
              >
                <Input
                  id="fullDayMinutes"
                  type="number"
                  min={1}
                  disabled={!canManage}
                  {...form.register('fullDayMinutes')}
                />
              </FormField>
              <FormField
                label="Half-day minutes"
                htmlFor="halfDayMinutes"
                hint="Below this, the day is an absence."
                error={form.formState.errors.halfDayMinutes?.message}
              >
                <Input
                  id="halfDayMinutes"
                  type="number"
                  min={0}
                  disabled={!canManage}
                  {...form.register('halfDayMinutes')}
                />
              </FormField>
              <FormField
                label="Default break (minutes)"
                htmlFor="defaultBreakMinutes"
                hint="Only subtracted when the break sits outside the window."
                error={form.formState.errors.defaultBreakMinutes?.message}
              >
                <Input
                  id="defaultBreakMinutes"
                  type="number"
                  min={0}
                  disabled={!canManage}
                  {...form.register('defaultBreakMinutes')}
                />
              </FormField>
            </div>

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

        {/* --- punch integrity ---------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Punch integrity</CardTitle>
            <CardDescription>
              A terminal records events, not intent: it will report the same badge twice, and it
              cannot tell a forgotten check-out from a fourteen-hour day. These decide what happens
              when the events do not add up. Raw punches are never altered by any of them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Duplicate punch window (seconds)"
                htmlFor="duplicatePunchWindowSeconds"
                hint="Punches this close together, saying the same thing, are one event seen twice. Zero takes every punch at face value."
                error={form.formState.errors.duplicatePunchWindowSeconds?.message}
              >
                <Input
                  id="duplicatePunchWindowSeconds"
                  type="number"
                  min={0}
                  disabled={!canManage}
                  {...form.register('duplicatePunchWindowSeconds')}
                />
              </FormField>
              <FormField
                label="Longest believable day (minutes)"
                htmlFor="maxPlausibleSpanMinutes"
                hint="Beyond this the day is reported as irregular with no hours, rather than crediting a figure nobody worked. Zero switches the check off."
                error={form.formState.errors.maxPlausibleSpanMinutes?.message}
              >
                <Input
                  id="maxPlausibleSpanMinutes"
                  type="number"
                  min={0}
                  disabled={!canManage}
                  {...form.register('maxPlausibleSpanMinutes')}
                />
              </FormField>
            </div>

            <Controller
              control={form.control}
              name="allowImplausibleSpans"
              render={({ field }) => (
                <Toggle
                  label="Score days past that bound anyway"
                  hint="Off: a day longer than the bound contributes no hours and is listed for correction. On: it is scored on its punches, which is what happened before this setting existed."
                  checked={field.value ?? false}
                  disabled={!canManage}
                  onChange={field.onChange}
                />
              )}
            />

            {/*
              The day that ends after midnight. Separate from the bound above:
              that one asks whether a day is believable, these ask which day a
              punch belongs to - and a punch can be attributed correctly to a
              day that is then too long to score.
            */}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="A day can still be closed for (minutes)"
                htmlFor="overnightCheckOutWindowMinutes"
                hint="Somebody who stays until one in the morning badges out on the next date. Within this long after a day's first punch, that punch closes the day instead of opening a new one - and only while the day is still open. Zero switches the rule off."
                error={form.formState.errors.overnightCheckOutWindowMinutes?.message}
              >
                <Input
                  id="overnightCheckOutWindowMinutes"
                  type="number"
                  min={0}
                  disabled={!canManage}
                  {...form.register('overnightCheckOutWindowMinutes')}
                />
              </FormField>
              <FormField
                label="Last time a punch can close yesterday"
                htmlFor="overnightCheckOutCutoff"
                hint="After this local time a punch is an arrival however open yesterday looks. Stops a forgotten departure being closed by the next morning."
                error={form.formState.errors.overnightCheckOutCutoff?.message}
              >
                <Input
                  id="overnightCheckOutCutoff"
                  type="time"
                  disabled={!canManage}
                  {...form.register('overnightCheckOutCutoff')}
                />
              </FormField>
            </div>
          </CardContent>
        </Card>

        {/* --- flag thresholds ---------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reporting thresholds</CardTitle>
            <CardDescription>
              Grace decides what is <em>recorded</em>; these decide what is <em>reported</em>. A
              five-minute overrun can be recorded and still not worth flagging as a late day.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Flag as late from (minutes)"
              htmlFor="lateThresholdMinutes"
              hint="Zero flags any lateness the grace period did not forgive."
              error={form.formState.errors.lateThresholdMinutes?.message}
            >
              <Input
                id="lateThresholdMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('lateThresholdMinutes')}
              />
            </FormField>
            <FormField
              label="Flag as early leave from (minutes)"
              htmlFor="earlyLeaveThresholdMinutes"
              hint="The same rule for leaving before the shift ends."
              error={form.formState.errors.earlyLeaveThresholdMinutes?.message}
            >
              <Input
                id="earlyLeaveThresholdMinutes"
                type="number"
                min={0}
                disabled={!canManage}
                {...form.register('earlyLeaveThresholdMinutes')}
              />
            </FormField>
          </CardContent>
        </Card>

        {/* --- weekends and holidays ---------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Work on a non-working day</CardTitle>
            <CardDescription>
              What time worked on a weekend or a public holiday is worth. Applied when attendance
              is read, so changing it needs no recalculation - and changes nothing already stored.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Worked on a weekend"
              htmlFor="weekendWorkRule"
              error={form.formState.errors.weekendWorkRule?.message}
            >
              <NativeSelect id="weekendWorkRule" disabled={!canManage}
                {...form.register('weekendWorkRule')}>
                {NON_WORKING_DAY_WORK_RULES.map((rule) => (
                  <option key={rule} value={rule}>{NON_WORKING_DAY_WORK_RULE_LABELS[rule]}</option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              label="Worked on a holiday"
              htmlFor="holidayWorkRule"
              error={form.formState.errors.holidayWorkRule?.message}
            >
              <NativeSelect id="holidayWorkRule" disabled={!canManage}
                {...form.register('holidayWorkRule')}>
                {NON_WORKING_DAY_WORK_RULES.map((rule) => (
                  <option key={rule} value={rule}>{NON_WORKING_DAY_WORK_RULE_LABELS[rule]}</option>
                ))}
              </NativeSelect>
            </FormField>
          </CardContent>
        </Card>

        {/* --- what these rules cost --------------------------------------- */}
        {rules.payrollIntegration ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What these rules cost</CardTitle>
              <CardDescription>
                Read from payroll settings and edited there. Shown here because a rule that
                records lateness and a rule that charges for it are two different decisions, and
                it should be obvious which are currently on.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              {(
                [
                  ['Unpaid absence reduces pay', rules.payrollIntegration.deductUnpaidAbsence],
                  ['Unpaid leave reduces pay', rules.payrollIntegration.deductUnpaidLeave],
                  ['Lateness is deducted', rules.payrollIntegration.lateDeductionEnabled],
                  ['Early leaving is deducted', rules.payrollIntegration.earlyLeaveDeductionEnabled],
                  ['Overtime is paid', rules.payrollIntegration.overtimePaid],
                  [
                    'Overtime needs an approved timesheet',
                    rules.payrollIntegration.requireApprovedOvertime,
                  ],
                ] as Array<[string, boolean]>
              ).map(([label, on]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="text-muted-foreground">{label}</span>
                  <span className={cn('text-xs font-semibold', on ? 'text-success' : 'text-muted-foreground')}>
                    {on ? 'On' : 'Off'}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:col-span-2">
                <span className="text-muted-foreground">Overtime multiplier and pay ceiling</span>
                <span className="text-xs font-semibold">
                  {rules.payrollIntegration.overtimeMultiplier}x
                  {rules.payrollIntegration.overtimeCapMinutes === null
                    ? ', no ceiling'
                    : `, at most ${(rules.payrollIntegration.overtimeCapMinutes / 60).toFixed(2)} h a period`}
                </span>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="space-y-4 xl:sticky xl:top-6">
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
