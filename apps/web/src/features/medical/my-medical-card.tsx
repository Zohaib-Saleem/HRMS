import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HeartPulse } from 'lucide-react';
import { PERMISSIONS, type MedicalBenefitView } from '@hrms/shared';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  /**
   * Not eligible means no card at all - not a card saying so.
   *
   * Medical eligibility is a policy decision with several moving parts:
   * whether the benefit is switched on, a minimum service period, whether
   * probation qualifies, the employment stage (Probation / Permanent /
   * Internee), the lifecycle status, and which version of the policy was in
   * force. All of it is decided by `evaluateMedicalEligibility` on the server
   * and arrives here as one boolean. None of those rules is re-stated in this
   * file, and none may be: a policy change has to move the dashboard without
   * anybody editing the frontend.
   *
   * Hiding rather than explaining is the product decision. An employee on
   * probation reading "Not eligible - you are on probation" every morning is
   * being told repeatedly about a benefit they cannot use; the card simply is
   * not part of their dashboard until it is.
   *
   * This is presentation only. It hides nothing the server would otherwise
   * have allowed: /medical/benefit and every claim route apply the same
   * eligibility themselves, so a caller who skips this UI gains nothing.
   */
  if (view && !view.eligibility.eligible) return null;

  /**
   * Nothing at all until the server has answered.
   *
   * Without this the card renders its header and a skeleton while the request
   * is in flight, so somebody who is not eligible sees a "Medical" box flash up
   * and vanish on every load - which is the thing this card is supposed not to
   * do. The same reasoning covers a failed request: eligibility is unknown, and
   * the honest render for "unknown" on a summary card is nothing. The full
   * screen at /medical still reports its errors properly.
   */
  if (query.isLoading || query.isError) return null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <HeartPulse className="size-4" aria-hidden /> Medical
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {view ? <Badge variant="success">Eligible</Badge> : null}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/medical">Open</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {view ? (
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
