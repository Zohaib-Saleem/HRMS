import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HeartPulse, Pencil, Settings2, ShieldCheck, Wallet } from 'lucide-react';
import {
  MEDICAL_ELIGIBILITY_OVERRIDE_LABELS,
  PERMISSIONS,
  type MedicalBenefitView,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { isoDay, money } from '@/features/employment/employment-shared';
import { MedicalDependentsCard } from './medical-dependents-card';
import { MedicalOverrideDialog } from './medical-override-dialog';

/**
 * One employee's medical details, for the Employee 360 profile.
 *
 * The same `GET /medical/benefit` the employee's own Medical page reads, asked
 * about somebody else. Nothing is computed here: eligibility, the limit, what
 * has been used and who is covered all come from the policy in force, decided
 * on the server. The medical POLICY itself is not edited from here - that is
 * Settings, behind `medical.policy.manage`.
 *
 * What HR can change on this tab is the dependents list - the per-employee
 * medical record the benefit module keeps - through the same dialog the
 * Medical page uses. The server hands back `canManageDependents` from the
 * caller's own grants, so the Edit controls appear only for a caller the API
 * would let through; the tab itself is offered only to `medical.read` +
 * `medical.manage`, the pair the endpoint requires for another person's
 * record. An ordinary employee never sees this tab and, on their own Medical
 * page, sees their dependents without the controls.
 *
 * HR and Super Admin (`medical.manage`) can also set this employee's own
 * exception to the policy - eligible, not eligible, or an individual annual
 * limit - through `MedicalOverrideDialog`. The company-wide rules stay in
 * Settings; a holder of `medical.policy.manage` gets a link there.
 */
export function EmployeeMedical({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName?: string;
}) {
  const { has } = usePermissions();
  const [editing, setEditing] = React.useState(false);
  const allowed = has(PERMISSIONS.MEDICAL_READ) && has(PERMISSIONS.MEDICAL_MANAGE);

  const query = useQuery({
    // Under the `['medical']` prefix so a saved dependent refreshes this tab
    // the same way it refreshes the Medical page.
    queryKey: ['medical', 'benefit', { employeeId }],
    queryFn: () =>
      api.get<MedicalBenefitView>('/medical/benefit', { query: { employeeId } }),
    enabled: allowed && employeeId !== '',
    retry: false,
  });

  if (!allowed) return null;

  if (query.isPending) return <Skeleton className="h-64 w-full" />;
  if (query.isError || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const view = query.data;
  const { eligibility } = view;
  const currency = view.currency;
  const { override } = eligibility;
  const hasOverride = override.eligibility !== 'FOLLOW_POLICY' || override.annualLimit !== null;

  return (
    <div className="space-y-5">
      {view.canEditOverride || view.canEditPolicy ? (
        <div className="flex flex-wrap justify-end gap-2">
          {view.canEditPolicy ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/medical-policy">
                <Settings2 className="size-4" aria-hidden />
                Edit medical rules
              </Link>
            </Button>
          ) : null}
          {view.canEditOverride ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              Edit medical details
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Annual limit"
          value={money(view.annualLimit, currency)}
          icon={Wallet}
          tone="primary"
          hint={
            override.annualLimit !== null
              ? `Individual limit · policy is ${money(eligibility.policyBenefitLimit, currency)}`
              : `${eligibility.policyVersion.name} · benefit year ${view.benefitYear}`
          }
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Eligibility</CardTitle>
            <Badge variant={eligibility.eligible ? 'success' : 'warning'}>
              {eligibility.eligible ? 'Eligible' : 'Not eligible'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {eligibility.eligible ? (
              <p className="text-muted-foreground">
                {employeeName ?? view.employeeName} is covered under{' '}
                {eligibility.policyVersion.name}.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-4">
                {eligibility.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {eligibility.warnings.map((warning) => (
              <p key={warning} className="text-muted-foreground">
                {warning}
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
                label="Medical setting"
                value={MEDICAL_ELIGIBILITY_OVERRIDE_LABELS[override.eligibility]}
              />
              {hasOverride && override.note ? <Row label="Reason" value={override.note} /> : null}
              <Row
                label="Policy in force since"
                value={isoDay(eligibility.policyVersion.effectiveFrom.slice(0, 10))}
              />
            </dl>
          </CardContent>
        </Card>

        <MedicalDependentsCard view={view} />
      </div>

      {view.canEditOverride ? (
        <MedicalOverrideDialog open={editing} onClose={() => setEditing(false)} view={view} />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
