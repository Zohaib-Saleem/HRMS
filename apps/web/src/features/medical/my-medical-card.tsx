import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HeartPulse } from 'lucide-react';
import { PERMISSIONS, type MedicalBenefitView } from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/feedback/states';
import { usePermissions } from '@/features/auth/session-context';
import { money } from '@/features/employment/employment-shared';

/**
 * The employee's medical benefit, on their dashboard.
 *
 * One card rather than a section: what somebody wants from a dashboard is "am I
 * covered, and how much is left", and both fit in three lines. The detail is
 * one click away on /medical.
 *
 * The card renders itself away when the permission behind it is absent, so a
 * narrow role gets a shorter dashboard rather than a broken one. It never asks
 * about anybody but the caller - the server resolves the subject from the
 * session, so there is no employee id in this request to tamper with.
 */

export const MY_MEDICAL_KEY = ['medical', 'benefit', 'dashboard'] as const;

export function MyMedicalCard() {
  const { has } = usePermissions();
  const canRead = has(PERMISSIONS.MEDICAL_READ);

  const query = useQuery({
    queryKey: MY_MEDICAL_KEY,
    queryFn: () => api.get<MedicalBenefitView>('/medical/benefit'),
    enabled: canRead,
    retry: false,
  });

  if (!canRead) return null;

  const view = query.data;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <HeartPulse className="size-4" aria-hidden /> Medical
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {view ? (
            <Badge variant={view.eligibility.eligible ? 'success' : 'warning'}>
              {view.eligibility.eligible ? 'Eligible' : 'Not eligible'}
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/medical">Open</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : view ? (
          <>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <Figure label="Annual limit" value={money(view.annualLimit, view.currency)} />
              <Figure label="Used" value={money(view.used, view.currency)} />
              <Figure
                label="Remaining"
                value={money(view.remaining, view.currency)}
                emphasis
              />
            </dl>
            {!view.eligibility.eligible && view.eligibility.reasons[0] ? (
              <p className="mt-3 text-[13px] text-muted-foreground">
                {view.eligibility.reasons[0]}
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          emphasis
            ? 'truncate text-base font-semibold tabular-nums'
            : 'truncate text-base tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}
