import * as React from 'react';
import {
  PAYROLL_RUN_STATUS_LABELS,
  type PayrollRunStatus,
} from '@hrms/shared';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/field';
import { useLookups } from '@/lib/lookups';

/**
 * Pieces shared by the payroll screens.
 *
 * Money formatting lives here rather than in each page because a figure that
 * reads differently on the review table and on the payslip invites the question
 * of which one is right.
 */

export const RUN_STATUS_TONE: Record<
  PayrollRunStatus,
  'neutral' | 'warning' | 'success' | 'destructive' | 'primary'
> = {
  DRAFT: 'neutral',
  CALCULATING: 'primary',
  REVIEW: 'warning',
  APPROVED: 'primary',
  FINALIZED: 'success',
  CANCELLED: 'destructive',
};

export function RunStatusBadge({ status }: { status: PayrollRunStatus }) {
  return <Badge variant={RUN_STATUS_TONE[status]}>{PAYROLL_RUN_STATUS_LABELS[status]}</Badge>;
}

/**
 * Money, in the currency the run was calculated in.
 *
 * Always two decimals, always grouped, always the same. Payroll figures are
 * compared down columns, and a number that sometimes shows its cents and
 * sometimes does not cannot be scanned.
 */
export function money(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // An unknown currency code should not blank the payslip.
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** A count of days, which is often a half. */
export function days(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function hoursFromMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '--';
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * The department / location / employee filters the payroll screens share.
 *
 * One component so the three dropdowns cannot drift apart between the dashboard
 * and the reports, and so adding a fourth is one edit.
 */
export function ScopeFilters({
  departmentId,
  locationId,
  onChange,
  className,
}: {
  departmentId: string;
  locationId: string;
  onChange: (patch: { departmentId?: string; locationId?: string }) => void;
  className?: string;
}) {
  const { lookups } = useLookups();

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <NativeSelect
        value={departmentId}
        onChange={(e) => onChange({ departmentId: e.target.value })}
        aria-label="Filter by department"
        className="w-44"
      >
        <option value="">All departments</option>
        {lookups.departments?.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        value={locationId}
        onChange={(e) => onChange({ locationId: e.target.value })}
        aria-label="Filter by location"
        className="w-40"
      >
        <option value="">All locations</option>
        {lookups.locations?.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/**
 * A finalized run is a fact, not a draft.
 *
 * Shown wherever a run can be acted on, so that the absence of buttons reads as
 * a deliberate lock rather than a screen that failed to load.
 */
export function FinalizedNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/30 bg-success-soft/50 px-3 py-2 text-[13px]">
      <span className="font-medium text-success">Finalized</span>
      <span className="text-muted-foreground">
        {children ??
          'This payroll is closed and cannot be edited. Corrections are made with a payroll adjustment.'}
      </span>
    </div>
  );
}
