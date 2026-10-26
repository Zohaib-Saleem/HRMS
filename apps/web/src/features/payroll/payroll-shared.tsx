import * as React from 'react';
import {
  PAYROLL_BASIS_LABELS,
  PAYROLL_RUN_STATUS_LABELS,
  payrollUnpaidBreakdown,
  type PayrollBasis,
  type PayrollRunStatus,
  type PayrollSalaryType,
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

/**
 * Where a line's unpaid days came from, and what they cost.
 *
 * The review sheet shows full-day absences in one column and a deduction
 * priced on a different number in another - three absences and a half day
 * attended charge 3.5 days, and nothing on the row said why. This is the
 * arithmetic, read off the deduction lines the calculation wrote: each source
 * of an unpaid day, their total, the daily rate under the company's own basis,
 * and the amount.
 */
export function UnpaidDaysBreakdown({
  line,
  currency,
}: {
  line: {
    salaryType: PayrollSalaryType;
    salaryAmount: number;
    basis: PayrollBasis;
    basisDays: number;
    scheduledDays: number;
    holidayDays: number;
    weekendDays: number;
    payableDays: number;
    unpaidDays: number;
    absentDays: number;
    halfDays: number;
    deductions: ReadonlyArray<{ code: string | null; units: number | null; amount: number }>;
  };
  currency: string;
}) {
  const b = payrollUnpaidBreakdown(line);
  const monthly = line.salaryType === 'MONTHLY';

  const parts: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Full-day absences', value: days(b.fullDayAbsences) },
    {
      label: 'Half days',
      value: days(b.halfDayUnpaid),
      hint: b.halfDays > 0 ? `${days(b.halfDays)} half day(s) × 0.5` : undefined,
    },
    { label: 'Unpaid leave (LWP)', value: days(b.unpaidLeaveDays) },
  ];
  if (b.deductiblePaidLeaveDays > 0) {
    parts.push({ label: 'Deductible paid leave', value: days(b.deductiblePaidLeaveDays) });
  }

  return (
    <section
      className="rounded-md border border-border p-3 text-[13px]"
      aria-label="Unpaid days breakdown"
    >
      <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        Days and unpaid-day deduction
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <BreakdownFact label="Calendar days" value={days(b.calendarDays)} />
        <BreakdownFact label="Scheduled working days" value={days(b.scheduledDays)} />
        <BreakdownFact label="Paid days" value={days(b.paidDays)} />
        <BreakdownFact label="Unpaid days" value={days(b.unpaidDays)} />
      </dl>

      {monthly ? (
        <>
          <dl className="mt-3 space-y-1 border-t border-border pt-2">
            {parts.map((part) => (
              <div key={part.label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">
                  {part.label}
                  {part.hint ? <span className="ml-1 text-[11.5px]">({part.hint})</span> : null}
                </dt>
                <dd className="tabular-nums">{part.value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
              <dt>Total unpaid days used for payroll</dt>
              <dd className="tabular-nums">{days(b.chargedDays)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">
                Daily rate ({money(line.salaryAmount, currency)} ÷ {line.basisDays},{' '}
                {PAYROLL_BASIS_LABELS[line.basis].toLowerCase()})
              </dt>
              <dd className="tabular-nums">{money(b.dailyRate, currency)}</dd>
            </div>
            <div className="flex justify-between gap-3 font-medium">
              <dt>Deduction</dt>
              <dd className="tabular-nums">{money(b.deductionAmount, currency)}</dd>
            </div>
          </dl>
          {!b.reconciles ? (
            <p role="alert" className="mt-2 text-[12.5px] text-destructive">
              The parts above do not add up to the {days(b.unpaidDays)} unpaid day(s) this line was
              priced on. Recalculate the run before approving it.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          {line.salaryType === 'DAILY' ? 'Daily' : 'Hourly'} pay is earned per day or hour worked,
          so an unpaid day is never paid rather than deducted.
        </p>
      )}
    </section>
  );
}

function BreakdownFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[12px] text-muted-foreground">{label}</dt>
      <dd className="tabular text-[14px] font-medium">{value}</dd>
    </div>
  );
}
