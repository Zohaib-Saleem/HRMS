import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import type { PayslipRecord } from '@hrms/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ErrorState, FullPageLoader } from '@/components/feedback/states';
import { useSession } from '@/features/auth/session-context';
import { days, hoursFromMinutes, money } from './payroll-shared';

/**
 * A payslip.
 *
 * Deliberately a document rather than a dashboard: one column, printable, and
 * readable by somebody who has never used this system and just wants to know
 * what they were paid and why.
 *
 * Printing uses the browser's own print, with a stylesheet that drops the
 * application chrome. No PDF library: the browser already produces a better
 * PDF than a hand-rolled one, and every platform has the button.
 */

export function PayslipPage() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const company = session?.company ?? null;

  const query = useQuery({
    queryKey: ['payslip', id],
    queryFn: () => api.get<PayslipRecord>(`/payslips/${id}`),
    enabled: id !== '',
  });

  if (query.isLoading) return <FullPageLoader />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const slip = query.data!;
  const line = slip.line;
  const currency = slip.currency;

  const allowances = line.earnings.filter((e) => e.kind !== 'BASIC' && e.kind !== 'OVERTIME');
  const basic = line.earnings.find((e) => e.kind === 'BASIC');
  const overtime = line.earnings.find((e) => e.kind === 'OVERTIME');

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/payslips">
            <ArrowLeft />
            All payslips
          </Link>
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer />
          Print or save as PDF
        </Button>
      </div>

      <Card className="mx-auto max-w-3xl p-6 print:border-0 print:shadow-none sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0">
            <p className="text-lg font-semibold tracking-tight">{company?.name ?? 'Payslip'}</p>
            <p className="text-[13px] text-muted-foreground">Payslip</p>
          </div>
          <div className="text-right">
            <p className="tabular text-[13px] font-semibold">{slip.number}</p>
            <p className="text-[12.5px] text-muted-foreground">
              Issued {formatDate(slip.issuedAt)}
            </p>
          </div>
        </header>

        <section className="grid gap-x-6 gap-y-3 border-b border-border py-5 sm:grid-cols-2">
          <Field label="Employee" value={slip.employeeName} />
          <Field label="Employee ID" value={slip.employeeNumber} />
          <Field label="Department" value={line.departmentName ?? '--'} />
          <Field label="Pay period" value={slip.periodName} />
          <Field
            label="Period dates"
            value={`${formatDate(slip.periodStart)} – ${formatDate(slip.periodEnd)}`}
          />
          <Field
            label="Payment date"
            value={slip.payDate ? formatDate(slip.payDate) : formatDate(slip.issuedAt)}
          />
        </section>

        <section className="border-b border-border py-5">
          <h2 className="mb-3 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
            Attendance
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Field label="Working days" value={days(line.scheduledDays)} />
            <Field label="Present" value={days(line.presentDays)} />
            <Field label="Paid leave" value={days(line.paidLeaveDays)} />
            <Field label="Unpaid leave" value={days(line.unpaidLeaveDays)} />
            <Field label="Absence" value={days(line.absentDays)} />
            <Field
              label="Overtime hours"
              value={hoursFromMinutes(line.approvedOvertimeMinutes)}
            />
          </div>
        </section>

        <section className="grid gap-6 border-b border-border py-5 sm:grid-cols-2">
          <div>
            <h2 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              Earnings
            </h2>
            <dl className="space-y-1.5">
              {basic ? (
                <Amount label={basic.label} value={money(basic.amount, currency)} />
              ) : null}
              {allowances.map((item, index) => (
                <Amount
                  key={`${item.code}-${index}`}
                  label={item.label}
                  value={money(item.amount, currency)}
                />
              ))}
              {overtime ? (
                <Amount label="Overtime" value={money(overtime.amount, currency)} />
              ) : null}
              <Amount
                label="Gross earnings"
                value={money(line.grossAmount, currency)}
                total
              />
            </dl>
          </div>

          <div>
            <h2 className="mb-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              Deductions
            </h2>
            <dl className="space-y-1.5">
              {line.deductions.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">None</p>
              ) : (
                line.deductions.map((item, index) => (
                  <Amount
                    key={`${item.code}-${index}`}
                    label={item.label}
                    hint={item.units !== null ? `${item.units} × ${money(item.rate ?? 0, currency)}` : undefined}
                    value={money(item.amount, currency)}
                  />
                ))
              )}
              <Amount
                label="Total deductions"
                value={money(line.deductionsTotal, currency)}
                total
              />
            </dl>
          </div>
        </section>

        <section className="flex items-baseline justify-between py-5">
          <span className="text-[13.5px] font-semibold uppercase tracking-wide">Net salary</span>
          <span className="tabular text-2xl font-semibold tracking-tight">
            {money(line.netAmount, currency)}
          </span>
        </section>

        <footer className="border-t border-border pt-4 text-[11.5px] text-muted-foreground">
          <p>
            Attendance figures come from recorded attendance for the period. Every amount is rounded
            once, where it is shown, so the columns above add up exactly as printed.
          </p>
          <p className="mt-1">
            This payslip was generated by {company?.name ?? 'the HRMS'} and does not require a
            signature.
          </p>
        </footer>
      </Card>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate text-[13.5px] font-medium">{value}</p>
    </div>
  );
}

function Amount({
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
          ? 'flex items-baseline justify-between gap-3 border-t border-border pt-1.5'
          : 'flex items-baseline justify-between gap-3'
      }
    >
      <div className="min-w-0">
        <dt className={total ? 'text-[13px] font-semibold' : 'text-[13px]'}>{label}</dt>
        {hint ? <dd className="text-[11.5px] text-muted-foreground">{hint}</dd> : null}
      </div>
      <dd className={total ? 'tabular text-[13.5px] font-semibold' : 'tabular text-[13px]'}>
        {value}
      </dd>
    </div>
  );
}
