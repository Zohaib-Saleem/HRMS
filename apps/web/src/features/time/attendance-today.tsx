import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, LogIn, LogOut, MapPin, Wifi } from 'lucide-react';
import {
  ATTENDANCE_MODES,
  ATTENDANCE_MODE_LABELS,
  type AttendanceMode,
  type AttendanceTodayState,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { minutesLabel as hours, timeLabel as time } from './attendance-ui';

/**
 * Asks the browser where it is, once, when the company requires it.
 *
 * The coordinates are only ever evidence. The server compares them against the
 * work location and can refuse the check-in; nothing here decides anything.
 */
function currentPosition(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser cannot share your location, which your company requires for check-in.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      () =>
        reject(
          new Error('Location permission is needed to check in. Allow it in your browser and try again.'),
        ),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

/**
 * Check-in widget.
 *
 * The server decides whether today is a working day; this only renders what it
 * is told. That keeps the weekend, holiday and leave rules in one place instead
 * of duplicating the calendar logic in the browser.
 */
export function AttendanceToday() {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<AttendanceMode>('OFFICE');

  const today = useQuery({
    queryKey: ['attendance', 'today'],
    queryFn: () => api.get<AttendanceTodayState>('/attendance/today'),
    // A clock that silently goes stale is worse than no clock.
    refetchInterval: 60_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['attendance'] });
  };

  const checkIn = useMutation({
    mutationFn: async () => {
      // Only asked for when the company restricts check-in, so companies that
      // do not use the feature never see a permission prompt.
      const where = today.data?.locationRequired ? await currentPosition() : null;
      return api.post<{ lateMinutes: number | null; distanceMeters: number | null }>(
        '/attendance/check-in',
        { mode, ...(where ?? {}) },
      );
    },
    onSuccess: async (result) => {
      toast.success(
        result.lateMinutes && result.lateMinutes > 0
          ? `Checked in, ${result.lateMinutes} minute(s) after your shift start.`
          : 'Checked in.',
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const checkOut = useMutation({
    mutationFn: () =>
      api.post<{ workedMinutes: number; overtimeMinutes: number | null; status: string }>(
        '/attendance/check-out',
        {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `Checked out after ${(result.workedMinutes / 60).toFixed(1)} hours.${
          result.overtimeMinutes ? ` ${result.overtimeMinutes} minute(s) counted as overtime.` : ''
        }`,
      );
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (today.isLoading) {
    return (
      <Card className="mb-6">
        <CardContent className="flex items-center gap-4 py-5">
          <Skeleton className="size-11 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-9 w-28" />
        </CardContent>
      </Card>
    );
  }

  // An account with no employee record cannot check in; the page still works.
  if (today.isError) return null;

  const state = today.data;
  if (!state) return null;

  return (
    <Card className="mb-6">
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
        <span
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-lg',
            state.checkedIn && !state.checkedOut
              ? 'bg-success-soft text-success'
              : 'bg-muted text-muted-foreground',
          )}
          aria-hidden
        >
          <Clock className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-semibold">Today</p>
            {state.shiftName ? (
              <Badge variant="outline">
                {state.shiftName} {state.shiftStartTime}–{state.shiftEndTime}
              </Badge>
            ) : null}
            {state.lateMinutes && state.lateMinutes > 0 ? (
              <Badge variant="warning">{state.lateMinutes}m late</Badge>
            ) : null}
            {state.earlyLeaveMinutes && state.earlyLeaveMinutes > 0 ? (
              <Badge variant="warning">{state.earlyLeaveMinutes}m early</Badge>
            ) : null}
            {state.overtimeMinutes && state.overtimeMinutes > 0 ? (
              <Badge variant="success">{state.overtimeMinutes}m overtime</Badge>
            ) : null}
            {state.status === 'HALF_DAY' ? <Badge variant="warning">Half day</Badge> : null}
            {state.locationRequired && !state.checkedIn ? (
              <Badge variant="outline">
                <MapPin className="size-3" aria-hidden />
                Location required
              </Badge>
            ) : null}
          </div>

          {!state.isWorkingDay ? (
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">
              Not a working day{state.reason ? ` — ${state.reason}` : ''}.
            </p>
          ) : (
            <p className="tabular mt-0.5 text-[13.5px] text-muted-foreground">
              In {time(state.checkInAt)} · Out {time(state.checkOutAt)} · Worked{' '}
              {hours(state.workedMinutes)}
              {state.mode ? ` · ${ATTENDANCE_MODE_LABELS[state.mode as AttendanceMode]}` : ''}
            </p>
          )}
        </div>

        {state.isWorkingDay ? (
          <div className="flex shrink-0 items-center gap-2">
            {!state.checkedIn ? (
              <>
                <NativeSelect
                  value={mode}
                  onChange={(e) => setMode(e.target.value as AttendanceMode)}
                  aria-label="Work location"
                  className="h-9 w-32"
                >
                  {ATTENDANCE_MODES.map((m) => (
                    <option key={m} value={m}>{ATTENDANCE_MODE_LABELS[m]}</option>
                  ))}
                </NativeSelect>
                <Button loading={checkIn.isPending} onClick={() => checkIn.mutate()}>
                  <LogIn />
                  Check in
                </Button>
              </>
            ) : !state.checkedOut ? (
              <Button variant="outline" loading={checkOut.isPending} onClick={() => checkOut.mutate()}>
                <LogOut />
                Check out
              </Button>
            ) : (
              <Badge variant="success">
                {state.mode === 'REMOTE' ? (
                  <Wifi className="size-3" aria-hidden />
                ) : (
                  <MapPin className="size-3" aria-hidden />
                )}
                Day complete
              </Badge>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
