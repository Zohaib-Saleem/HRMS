import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Save } from 'lucide-react';
import {
  PERMISSIONS,
  WEEK_DAYS,
  WEEK_DAY_LABELS,
  attendancePolicySchema,
  type AttendancePolicyInput,
  type LocationRecord,
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
 * The attendance policy screen.
 *
 * Everything the attendance calculation reads is editable here, which is the
 * whole point: no grace period, threshold or weekend is written into the code.
 * Saving posts to its own endpoint so the change is audited as a policy
 * decision rather than as an edit to the company profile.
 */

type CompanyPolicy = AttendancePolicyInput & { id: string };

export function AttendancePolicyPage() {
  const { has } = usePermissions();
  const canManage = has(PERMISSIONS.COMPANY_MANAGE);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<CompanyPolicy>('/company'),
  });

  // Only fetched to warn about sites that cannot be geofenced yet.
  const locations = useQuery({
    queryKey: ['locations', 'geofence'],
    queryFn: () => api.getPage<LocationRecord>('/locations', { query: { limit: 100 } }),
    enabled: has(PERMISSIONS.LOCATION_READ),
  });

  const form = useForm<AttendancePolicyInput>({
    resolver: zodResolver(attendancePolicySchema),
    values: query.data
      ? {
          weekendDays: query.data.weekendDays,
          graceMinutes: query.data.graceMinutes,
          halfDayMinutes: query.data.halfDayMinutes,
          fullDayMinutes: query.data.fullDayMinutes,
          earlyLeaveGraceMinutes: query.data.earlyLeaveGraceMinutes,
          overtimeEnabled: query.data.overtimeEnabled,
          overtimeAfterMinutes: query.data.overtimeAfterMinutes,
          overtimeDailyCapMinutes: query.data.overtimeDailyCapMinutes,
          locationRestrictionEnabled: query.data.locationRestrictionEnabled,
          defaultGeofenceRadiusM: query.data.defaultGeofenceRadiusM,
        }
      : undefined,
  });

  const { register, handleSubmit, formState, reset, control, watch, setError } = form;

  const mutation = useMutation({
    mutationFn: (values: AttendancePolicyInput) =>
      api.patch<CompanyPolicy>('/company/attendance-policy', values),
    onSuccess: async (updated) => {
      toast.success('Attendance policy saved. It applies from the next check-out.');
      queryClient.setQueryData(['company'], updated);
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
      reset(updated);
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isValidation && error.details) {
        for (const [field, messages] of Object.entries(error.details)) {
          setError(field as keyof AttendancePolicyInput, { message: messages[0] });
        }
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (query.isLoading) {
    return (
      <Card>
        <CardContent className="space-y-4 py-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const restrictionOn = watch('locationRestrictionEnabled');
  const overtimeOn = watch('overtimeEnabled');

  const unmapped = (locations.data?.data ?? []).filter(
    (l) => l.isActive && (l.latitude === null || l.longitude === null),
  );

  return (
    <form
      onSubmit={handleSubmit((values) => mutation.mutate(values))}
      className="space-y-6"
      noValidate
    >
      <Card>
        <CardHeader bordered>
          <CardTitle>Working week</CardTitle>
          <CardDescription>
            Which days are not worked. Attendance and leave both read this, so a day marked here is
            never counted against a leave balance or reported as an absence.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-5">
          <Controller
            control={control}
            name="weekendDays"
            render={({ field }) => (
              <div className="flex flex-wrap gap-2">
                {WEEK_DAYS.map((day) => {
                  const checked = field.value?.includes(day) ?? false;
                  return (
                    <label
                      key={day}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors',
                        checked
                          ? 'border-primary/40 bg-primary-soft/40 font-medium'
                          : 'border-border hover:bg-accent/50',
                        !canManage && 'pointer-events-none opacity-60',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManage}
                        onChange={() =>
                          field.onChange(
                            checked
                              ? (field.value ?? []).filter((d: WeekDay) => d !== day)
                              : [...(field.value ?? []), day],
                          )
                        }
                        className="size-4 shrink-0 rounded border-input accent-[var(--primary)]"
                      />
                      {WEEK_DAY_LABELS[day]}
                    </label>
                  );
                })}
              </div>
            )}
          />
          {formState.errors.weekendDays ? (
            <p className="mt-2 text-[13px] text-destructive">
              {formState.errors.weekendDays.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader bordered>
          <CardTitle>Scoring a day</CardTitle>
          <CardDescription>
            How worked time turns into a status. Grace decides whether someone counts as late at
            all; past it, the full lateness is reported.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 py-5 sm:grid-cols-2">
          <FormField
            label="Late grace (minutes)"
            htmlFor="graceMinutes"
            hint="Arriving within this many minutes of the shift start is not late."
            error={formState.errors.graceMinutes?.message}
          >
            <Input type="number" min={0} disabled={!canManage} {...register('graceMinutes')} />
          </FormField>

          <FormField
            label="Early-leave grace (minutes)"
            htmlFor="earlyLeaveGraceMinutes"
            hint="Leaving within this many minutes of the shift end is not early."
            error={formState.errors.earlyLeaveGraceMinutes?.message}
          >
            <Input
              type="number"
              min={0}
              disabled={!canManage}
              {...register('earlyLeaveGraceMinutes')}
            />
          </FormField>

          <FormField
            label="Half day from (minutes worked)"
            htmlFor="halfDayMinutes"
            hint="Below this, a day with a check-in still counts as absent."
            error={formState.errors.halfDayMinutes?.message}
          >
            <Input type="number" min={0} disabled={!canManage} {...register('halfDayMinutes')} />
          </FormField>

          <FormField
            label="Full day from (minutes worked)"
            htmlFor="fullDayMinutes"
            hint="480 is eight hours."
            error={formState.errors.fullDayMinutes?.message}
          >
            <Input type="number" min={1} disabled={!canManage} {...register('fullDayMinutes')} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader bordered>
          <CardTitle>Overtime</CardTitle>
          <CardDescription>
            Overtime labels the part of the day worked past the threshold. It is never added to
            worked time, so the two can be reported together without double-counting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 py-5">
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 text-[13.5px]',
              !canManage && 'pointer-events-none opacity-60',
            )}
          >
            <input
              type="checkbox"
              disabled={!canManage}
              {...register('overtimeEnabled')}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
            />
            <span>
              <span className="block font-medium">Calculate overtime</span>
              <span className="block text-[12.5px] text-muted-foreground">
                Turn this off and overtime is recorded as zero rather than left unknown.
              </span>
            </span>
          </label>

          <div className={cn('grid gap-5 sm:grid-cols-2', !overtimeOn && 'opacity-50')}>
            <FormField
              label="Overtime after (minutes worked)"
              htmlFor="overtimeAfterMinutes"
              error={formState.errors.overtimeAfterMinutes?.message}
            >
              <Input
                type="number"
                min={0}
                disabled={!canManage || !overtimeOn}
                {...register('overtimeAfterMinutes')}
              />
            </FormField>

            <FormField
              label="Daily overtime cap (minutes)"
              htmlFor="overtimeDailyCapMinutes"
              hint="Stops a forgotten check-out booking a whole night of overtime."
              error={formState.errors.overtimeDailyCapMinutes?.message}
            >
              <Input
                type="number"
                min={0}
                disabled={!canManage || !overtimeOn}
                {...register('overtimeDailyCapMinutes')}
              />
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader bordered>
          <CardTitle>Check-in location</CardTitle>
          <CardDescription>
            Optional. When on, a check-in must come from within the radius of the employee work
            location, and the server - not the browser - decides.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 py-5">
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 text-[13.5px]',
              !canManage && 'pointer-events-none opacity-60',
            )}
          >
            <input
              type="checkbox"
              disabled={!canManage}
              {...register('locationRestrictionEnabled')}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-[var(--primary)]"
            />
            <span>
              <span className="block font-medium">Restrict check-in to work locations</span>
              <span className="block text-[12.5px] text-muted-foreground">
                Applies to remote check-ins too, so the rule cannot be avoided by changing the work
                mode.
              </span>
            </span>
          </label>

          <div className={cn(!restrictionOn && 'opacity-50')}>
            <FormField
              label="Default radius (metres)"
              htmlFor="defaultGeofenceRadiusM"
              hint="Used for locations that do not set their own radius."
              error={formState.errors.defaultGeofenceRadiusM?.message}
              className="sm:max-w-xs"
            >
              <Input
                type="number"
                min={10}
                disabled={!canManage || !restrictionOn}
                {...register('defaultGeofenceRadiusM')}
              />
            </FormField>
          </div>

          {restrictionOn && unmapped.length > 0 ? (
            <div className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3.5 text-[13px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
              <div>
                <p className="font-medium text-warning-foreground">
                  {unmapped.length} location(s) have no coordinates
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Check-in is refused for anyone assigned to {unmapped.map((l) => l.name).join(', ')}
                  {' '}until latitude and longitude are set on the location. This fails closed on
                  purpose - a missing coordinate is a gap, not a free pass.
                </p>
              </div>
            </div>
          ) : null}
        </CardContent>
        {canManage ? (
          <CardFooter className="justify-end">
            <Button type="submit" loading={mutation.isPending} disabled={!formState.isDirty}>
              <Save />
              Save policy
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}
