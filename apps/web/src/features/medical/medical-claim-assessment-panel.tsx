import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  MEDICAL_CLAIM_DOCUMENT_LABELS,
  type MedicalClaimAssessment,
} from '@hrms/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { money } from '@/features/employment/employment-shared';

/**
 * What the claimant is told before they commit to a claim.
 *
 * Two jobs, and the split matters. Before an amount is typed it answers "may I
 * claim under this category at all, and how much is left"; once one is, it
 * answers "would THIS claim pass, and what would I actually be paid". Both
 * answers come from the server and neither is worked out here.
 *
 * A refusal names the rule and the figure behind it - "this category allows
 * 20,000 a year and 18,500 is already used" - because the point is that the
 * claimant knows what to change. What it never carries is anything internal: no
 * employee ids, no policy version id, no colleague's balance. Every figure here
 * is one about the reader, and one they can already see on their own Medical
 * screen.
 *
 * The split is shown whenever the amount is known, including on a refusal. "You
 * would be paid 8,000 of the 10,000" is the single most useful line on the
 * form, and somebody fixing a refusal should not have to guess at it.
 */

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'bad' | 'strong';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-medium tabular-nums',
          tone === 'bad' && 'text-destructive',
          tone === 'strong' && 'font-semibold',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** The balances, the split and the caps - the same lines either way. */
function Figures({ result }: { result: MedicalClaimAssessment }) {
  const { currency } = result;
  const hasAmount = result.requestedAmount > 0;

  return (
    <div className="mt-2 space-y-1">
      <Row label="Annual limit" value={money(result.annualLimit, currency)} />
      <Row label="Used this year" value={money(result.used, currency)} />
      {result.pending > 0 ? (
        <Row label="Awaiting a decision" value={money(result.pending, currency)} />
      ) : null}
      <Row
        label="Available for a new claim"
        value={money(result.available, currency)}
        tone="strong"
      />

      {result.categoryAnnualLimit !== null ? (
        <Row
          label="This category's own cap"
          value={`${money(result.categoryUsed, currency)} of ${money(
            result.categoryAnnualLimit,
            currency,
          )} used`}
        />
      ) : null}
      {result.maxClaimAmount !== null ? (
        <Row label="Most one claim may be" value={money(result.maxClaimAmount, currency)} />
      ) : null}

      {hasAmount ? (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
          <Row
            label={`Company pays (${result.companyContributionPercent}%)`}
            value={money(result.companyAmount, currency)}
            tone="strong"
          />
          {result.employeeAmount > 0 ? (
            <Row
              label={`Your share (${result.employeeContributionPercent}%)`}
              value={money(result.employeeAmount, currency)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the policy in force insists a claim carries. */
function Requirements({ result }: { result: MedicalClaimAssessment }) {
  const needs: string[] = [
    ...result.requiredDocuments.map((type) => MEDICAL_CLAIM_DOCUMENT_LABELS[type].toLowerCase()),
    ...(result.requireProviderName ? ['the provider name'] : []),
    ...(result.requireTreatmentDate ? ['the treatment date'] : []),
  ];
  if (needs.length === 0) return null;

  return (
    <p className="mt-2 border-t border-border/60 pt-2 text-[12.5px] text-muted-foreground">
      This claim must carry {needs.join(', ')}.
    </p>
  );
}

export function MedicalClaimAssessmentPanel({
  result,
  loading,
  className,
}: {
  result: MedicalClaimAssessment | undefined;
  loading?: boolean;
  className?: string;
}) {
  if (loading && !result) {
    return <Skeleton className={cn('h-28 w-full', className)} />;
  }
  if (!result) return null;

  if (!result.allowed) {
    return (
      <div
        role="status"
        className={cn('rounded-lg border border-destructive/40 bg-destructive-soft p-3', className)}
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          This claim cannot be submitted yet
        </p>
        <ul className="mt-2 space-y-1">
          {result.failures.map((failure) => (
            <li key={failure.rule} className="flex items-start gap-2 text-[13px]">
              <X className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{failure.message}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 border-t border-destructive/20 pt-2">
          <Figures result={result} />
        </div>
        <Requirements result={result} />
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-border bg-surface-muted/40 p-3', className)}>
      <p className="flex items-center gap-2 text-sm font-semibold text-success">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        {result.requiresApproval ? 'Ready to submit' : 'Ready to submit - settled on arrival'}
      </p>
      {result.requiresApproval ? null : (
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          The policy in force does not require a decision on this claim, so it is agreed as soon as
          it is submitted.
        </p>
      )}

      <Figures result={result} />
      <Requirements result={result} />

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
