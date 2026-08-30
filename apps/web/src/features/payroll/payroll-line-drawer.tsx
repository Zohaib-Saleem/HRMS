import { useQuery } from '@tanstack/react-query';
import {
  PAYROLL_BASIS_LABELS,
  PAYROLL_SALARY_TYPE_LABELS,
  type PayrollReconciliation,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState } from '@/components/feedback/states';
import { Skeleton } from '@/components/ui/skeleton';
import { days, hoursFromMinutes, money } from './payroll-shared';

/**
 * How one figure was arrived at.
 *
 * The screen HR opens when somebody asks why their pay changed. It shows the
 * arithmetic rather than asserting the answer: the attendance the engine
 * recorded, the rate that attendance was priced at, every earning and deduction
 * as its own line, and the rounding visible at the end rather than smeared
 * through the middle.
 */

export function PayrollLineDrawer({
  lineId,
  onClose,
}: {
  lineId: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['payroll-reconciliation', lineId],
    queryFn: () => api.get<PayrollReconciliation>(`/payroll/reconciliation/${lineId}`),
  });

  const data = query.data;
  const currency = data?.currency ?? 'USD';

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent variant="drawer" size="lg">
        <DialogHeader>
          <DialogTitle>{data ? data.employeeName : 'Payroll calculation'}</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.employeeNumber}${data.departmentName ? ` · ${data.departmentName}` : ''} · ${data.periodName}`
              : 'How this figure was arrived at.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : query.isLoading || !data ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Attendance
                </h3>
                <p className="mb-3 text-[12.5px] text-muted-foreground">
                  Read from the attendance engine for {formatDate(data.periodStart)} –{' '}
                  {formatDate(data.periodEnd)}. Payroll does not recalculate any of it.
                </p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                  <Fact label="Scheduled" value={days(data.attendance.scheduledDays)} />
                  <Fact label="Present" value={days(data.attendance.presentDays)} />
                  <Fact label="Paid leave" value={days(data.attendance.paidLeaveDays)} />
                  <Fact label="Unpaid leave" value={days(data.attendance.unpaidLeaveDays)} />
                  <Fact label="Absent" value={days(data.attendance.absentDays)} />
                  <Fact label="Holidays" value={days(data.attendance.holidayDays)} />
                  <Fact label="Weekends" value={days(data.attendance.weekendDays)} />
                  <Fact
                    label="Overtime"
                    value={hoursFromMinutes(data.attendance.overtimeMinutes)}
                    hint={
                      data.attendance.approvedOvertimeMinutes !==
                      data.attendance.overtimeMinutes
                        ? `${hoursFromMinutes(data.attendance.approvedOvertimeMinutes)} approved`
                        : 'all approved'
                    }
                  />
                  {data.attendance.lateOccurrences > 0 ? (
                    <Fact
                      label="Late"
                      value={`${data.attendance.lateOccurrences}x`}
                      hint={`${data.attendance.lateMinutes} min`}
                    />
                  ) : null}
                  {data.attendance.earlyLeaveOccurrences > 0 ? (
                    <Fact
                      label="Left early"
                      value={`${data.attendance.earlyLeaveOccurrences}x`}
                      hint={`${data.attendance.earlyLeaveMinutes} min`}
                    />
                  ) : null}
                </dl>
              </section>

              <section className="rounded-md border border-border bg-surface-muted/40 p-3">
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  How it was priced
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                  <Fact
                    label="Salary"
                    value={money(data.payroll.salaryAmount, currency)}
                    hint={PAYROLL_SALARY_TYPE_LABELS[data.payroll.salaryType]}
                  />
                  <Fact
                    label="Basis"
                    value={String(data.payroll.basisDays)}
                    hint={PAYROLL_BASIS_LABELS[data.payroll.basis]}
                  />
                  <Fact label="Daily rate" value={money(data.payroll.dailyRate, currency)} />
                  <Fact label="Hourly rate" value={money(data.payroll.hourlyRate, currency)} />
                  <Fact label="Payable days" value={days(data.payroll.payableDays)} />
                  <Fact label="Unpaid days" value={days(data.payroll.unpaidDays)} />
                </dl>
                {data.payroll.salaryType === 'MONTHLY' && data.payroll.unpaidDays > 0 ? (
                  <p className="tabular mt-3 border-t border-border pt-2 text-[12.5px] text-muted-foreground">
                    {money(data.payroll.salaryAmount, currency)} ÷ {data.payroll.basisDays} ={' '}
                    {money(data.payroll.dailyRate, currency)} per day ×{' '}
                    {days(data.payroll.unpaidDays)} unpaid
                  </p>
                ) : null}
              </section>

              <section>
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Earnings
                </h3>
                <div className="overflow-hidden rounded-md border border-border">
                  {data.earnings.map((line, index) => (
                    <Row
                      key={`${line.code}-${index}`}
                      label={line.label}
                      hint={describe(line.calc, line.rate, line.units)}
                      value={money(line.amount, currency)}
                    />
                  ))}
                  <Row
                    label="Gross"
                    value={money(data.payroll.grossAmount, currency)}
                    total
                  />
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Deductions
                </h3>
                <div className="overflow-hidden rounded-md border border-border">
                  {data.deductions.length === 0 ? (
                    <p className="px-3 py-3 text-[13px] text-muted-foreground">
                      Nothing was deducted.
                    </p>
                  ) : (
                    data.deductions.map((line, index) => (
                      <Row
                        key={`${line.code}-${index}`}
                        label={line.label}
                        hint={describe(line.calc, line.rate, line.units)}
                        value={money(line.amount, currency)}
                      />
                    ))
                  )}
                  <Row
                    label="Total deductions"
                    value={money(data.payroll.deductionsTotal, currency)}
                    total
                  />
                </div>
              </section>

              <section className="flex items-baseline justify-between rounded-md border border-primary/30 bg-primary-soft/40 px-3 py-3">
                <span className="text-[13px] font-semibold uppercase tracking-wide">Net salary</span>
                <span className="tabular text-xl font-semibold tracking-tight">
                  {money(data.payroll.netAmount, currency)}
                </span>
              </section>

              <p className="text-[12px] text-muted-foreground">
                Each line is rounded once, where it is shown. The totals are the sum of the rounded
                lines, so the figures on this page add up exactly as printed.
              </p>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Says what produced an amount, when the amount alone would not. */
function describe(
  calc: string,
  rate: number | null,
  units: number | null,
): string | undefined {
  if (calc === 'PERCENT_OF_BASIC' && rate !== null) return `${rate}% of basic`;
  if (calc === 'PERCENT_OF_GROSS' && rate !== null) return `${rate}% of gross`;
  if (rate !== null && units !== null) return `${units} × ${rate}`;
  if (units !== null) return `${units} unit(s)`;
  return undefined;
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[12px] text-muted-foreground">{label}</dt>
      <dd className="tabular text-[14px] font-medium">{value}</dd>
      {hint ? <dd className="truncate text-[11.5px] text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  total,
}: {
  label: string;
  value: string;
  hint?: string;
  total?: boolean;
}) {
  return (
    <div
      className={
        total
          ? 'flex items-baseline justify-between gap-3 border-t border-border bg-surface-muted/60 px-3 py-2'
          : 'flex items-baseline justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0'
      }
    >
      <div className="min-w-0">
        <p className={total ? 'text-[13px] font-semibold' : 'text-[13px]'}>{label}</p>
        {hint ? <p className="text-[11.5px] text-muted-foreground">{hint}</p> : null}
      </div>
      <span className={total ? 'tabular text-[13.5px] font-semibold' : 'tabular text-[13px]'}>
        {value}
      </span>
    </div>
  );
}
