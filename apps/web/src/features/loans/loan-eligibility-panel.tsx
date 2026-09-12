import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import type { LoanEligibilityResult } from '@hrms/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * What the employee is told about their own eligibility.
 *
 * Two jobs, and the split matters. Before an amount is typed it answers "may I
 * apply at all, and for how much"; once one is, it answers "would THIS
 * application pass". Both answers come from the server.
 *
 * A refusal names the rule and the figure behind it - "attendance is 84%, the
 * minimum is 90%" - because the point is that the employee knows what to fix.
 * What it never carries is anything internal: no employee ids, no policy
 * version, no colleague's figures, no hint of who else has a loan. Every number
 * shown is one about the reader that they can already see on their own
 * dashboard.
 */

const money = (currency: string, amount: number) =>
  `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function Row({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-medium tabular-nums', tone === 'bad' && 'text-destructive')}>
        {value}
      </span>
    </div>
  );
}

export function LoanEligibilityPanel({
  result,
  loading,
  className,
}: {
  result: LoanEligibilityResult | undefined;
  loading?: boolean;
  className?: string;
}) {
  if (loading && !result) {
    return <Skeleton className={cn('h-28 w-full', className)} />;
  }
  if (!result) return null;

  const { currency } = result;
  const overLimit =
    result.estimatedMonthlyDeduction !== null &&
    result.estimatedMonthlyDeduction > result.maxMonthlyDeduction;

  if (!result.eligible) {
    return (
      <div
        role="status"
        className={cn(
          'rounded-lg border border-destructive/40 bg-destructive-soft p-3',
          className,
        )}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          Loan application unavailable
        </p>
        <ul className="mt-2 space-y-1">
          {result.failures.map((failure) => (
            <li key={failure.rule} className="flex items-start gap-2 text-[13px]">
              <X className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{failure.message}</span>
            </li>
          ))}
        </ul>
        {result.monthlySalary !== null ? (
          <div className="mt-3 space-y-1 border-t border-destructive/20 pt-2">
            <Row label="Maximum eligible amount" value={money(currency, result.maxAllowedAmount)} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border bg-surface-muted/40 p-3', className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-success">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        Eligible to apply
      </p>

      <div className="mt-2 space-y-1">
        {result.monthlySalary !== null ? (
          <Row label="Monthly salary" value={money(currency, result.monthlySalary)} />
        ) : null}
        <Row label="Maximum eligible loan" value={money(currency, result.maxAllowedAmount)} />
        {result.estimatedMonthlyDeduction !== null ? (
          <Row
            label="Estimated monthly deduction"
            value={money(currency, result.estimatedMonthlyDeduction)}
            tone={overLimit ? 'bad' : undefined}
          />
        ) : null}
        <Row
          label="Maximum permitted deduction"
          value={money(currency, result.maxMonthlyDeduction)}
        />
        <Row label="Longest repayment" value={`${result.maxTenureMonths} months`} />
      </div>

      {result.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {result.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
