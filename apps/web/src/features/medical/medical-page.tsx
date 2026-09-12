import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  HeartPulse,
  Info,
  Plus,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  MEDICAL_CLAIM_STATUS_LABELS,
  type MedicalBenefitView,
  type MedicalCategoryUsage,
  type MedicalClaimRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  MEDICAL_CLAIM_STATUS_TONE,
  isoDay,
  money,
} from '@/features/employment/employment-shared';
import { MedicalClaimSubmitDialog } from './medical-claim-dialogs';
import { MedicalDependentsCard } from './medical-dependents-card';

/**
 * The employee's Medical screen.
 *
 * Everything here came from the server. The entitlement, the balance, whether
 * this employee is eligible, which dependents are covered and how much of each
 * category has gone are all decided by the medical policy in force and computed
 * in `GET /medical/benefit` - the browser draws the answer and never works one
 * out. That is not tidiness: an entitlement figure the client could compute is
 * an entitlement figure a client could disagree with.
 *
 * `?employeeId=` is deliberately absent. This screen asks about the caller, and
 * the server resolves who that is from the session, so there is no id here for
 * anybody to change.
 */

export const MEDICAL_BENEFIT_KEY = ['medical', 'benefit', 'mine'] as const;

export function MedicalPage() {
  const [submitting, setSubmitting] = React.useState(false);

  const query = useQuery({
    queryKey: MEDICAL_BENEFIT_KEY,
    queryFn: () => api.get<MedicalBenefitView>('/medical/benefit'),
    retry: false,
  });

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Medical" description="Your medical benefit and who it covers." />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }

  if (query.isError || !query.data) {
    return (
      <>
        <PageHeader title="Medical" description="Your medical benefit and who it covers." />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }

  const view = query.data;
  const { eligibility } = view;
  const currency = view.currency;

  /* Usage by category, so the coverage list can show what is left of each cap. */
  const usageByCategory = new Map<string, MedicalCategoryUsage>(
    view.categoryUsage.map((usage) => [usage.category, usage]),
  );

  return (
    <>
      <PageHeader
        title="Medical"
        description={`${eligibility.policyVersion.name} · benefit year ${view.benefitYear}`}
        actions={
          view.canSubmitClaim ? (
            <Button size="sm" onClick={() => setSubmitting(true)}>
              <Plus className="size-4" aria-hidden />
              Submit a claim
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Annual limit"
          value={money(view.annualLimit, currency)}
          icon={Wallet}
          tone="primary"
          hint="Per employee, per benefit year"
        />
        <StatCard
          label="Used"
          value={money(view.used, currency)}
          icon={HeartPulse}
          hint={
            view.pending > 0
              ? `${money(view.pending, currency)} more is awaiting a decision`
              : 'Agreed and paid claims, company share only'
          }
        />
        {/*
         * `remaining` rather than `available`: being quoted a smaller balance
         * because of a claim that may yet be refused is a figure people plan
         * around and then have to be talked out of. What a NEW claim can draw on
         * is `available`, and it is named as such in the hint whenever the two
         * differ.
         */}
        <StatCard
          label="Remaining"
          value={money(view.remaining, currency)}
          icon={ShieldCheck}
          tone={view.remaining > 0 ? 'success' : 'warning'}
          hint={
            view.pending > 0
              ? `${money(view.available, currency)} available for a new claim`
              : undefined
          }
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Eligibility</CardTitle>
            <Badge variant={eligibility.eligible ? 'success' : 'warning'}>
              {eligibility.eligible ? 'Eligible' : 'Not eligible'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {eligibility.eligible ? (
              <p className="text-muted-foreground">
                Your medical benefit is active under {eligibility.policyVersion.name}.
              </p>
            ) : (
              <ul className="space-y-2">
                {eligibility.reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-2">
                    <CircleAlert
                      className="mt-0.5 size-4 shrink-0 text-warning-foreground"
                      aria-hidden
                    />
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            )}

            {eligibility.warnings.map((warning) => (
              <p key={warning} className="flex items-start gap-2 text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{warning}</span>
              </p>
            ))}

            <dl className="space-y-2 border-t border-border pt-3 text-[13px]">
              <Row
                label="Service"
                value={
                  eligibility.employment.monthsServed === null
                    ? 'Not on record'
                    : `${eligibility.employment.monthsServed} completed month${
                        eligibility.employment.monthsServed === 1 ? '' : 's'
                      }`
                }
              />
              <Row
                label="Employment"
                value={eligibility.employment.onProbation ? 'On probation' : 'Confirmed'}
              />
              <Row
                label="Policy in force since"
                value={isoDay(eligibility.policyVersion.effectiveFrom.slice(0, 10))}
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What is covered</CardTitle>
            <CardDescription>
              Category limits under the policy in force. A blank limit means only the annual
              benefit above applies.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border text-sm">
              {eligibility.categoryLimits.map((category) => {
                const usage = usageByCategory.get(category.category);
                return (
                  <li
                    key={category.category}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{category.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {category.enabled
                          ? `Company pays ${category.companyContributionPercent}%`
                          : 'Not covered'}
                      </p>
                    </div>
                    <span className="shrink-0 text-right tabular-nums">
                      {!category.enabled ? (
                        <Badge variant="neutral">Off</Badge>
                      ) : category.annualLimit === null ? (
                        <span className="text-xs text-muted-foreground">No separate cap</span>
                      ) : (
                        <>
                          {money(category.annualLimit, currency)}
                          {usage && usage.used > 0 ? (
                            <span className="block text-[11px] text-muted-foreground">
                              {money(usage.used, currency)} used
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <MedicalDependentsCard view={view} />
        <MyMedicalClaimsCard currency={currency} />
      </div>

      <MedicalClaimSubmitDialog
        open={submitting}
        onClose={() => setSubmitting(false)}
        currency={currency}
      />
    </>
  );
}

/**
 * The claimant's own recent claims.
 *
 * Asks with `view=mine` rather than leaning on the data scope to narrow a wider
 * question, which matters for anybody who can also see other people's: this
 * card is about the reader either way.
 */
function MyMedicalClaimsCard({ currency }: { currency: string }) {
  const query = useQuery({
    queryKey: ['medical', 'claims', 'mine', 'recent'],
    queryFn: () =>
      api.getPage<MedicalClaimRecord>('/medical/claims', {
        query: { view: 'mine', limit: 5, page: 1 },
      }),
    retry: false,
  });

  const rows = query.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>Your claims</CardTitle>
          <CardDescription>
            The five most recent. Nothing is drawn from your limit until a claim is agreed.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/medical/claims">See all</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={HeartPulse}
            title="No claims yet"
            description="Submit one when you have paid for treatment and have the receipt."
          />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {rows.map((claim) => (
              <li key={claim.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {claim.categoryLabel}
                    <span className="ml-1.5 font-mono text-[11.5px] font-normal text-muted-foreground">
                      {claim.claimNumber}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isoDay(claim.treatmentDate)}
                    {claim.dependentName ? ` · for ${claim.dependentName}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums">{money(claim.requestedAmount, currency)}</p>
                  <Badge variant={MEDICAL_CLAIM_STATUS_TONE[claim.status]}>
                    {MEDICAL_CLAIM_STATUS_LABELS[claim.status]}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
