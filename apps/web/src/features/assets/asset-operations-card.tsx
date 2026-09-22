import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Boxes, CheckCircle2, PackageOpen, Wrench } from 'lucide-react';
import { PERMISSIONS, type AssetSummary } from '@hrms/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import { usePermissions } from '@/features/auth/session-context';

/**
 * The register, as four numbers, on the dashboard of whoever runs it.
 *
 * This is the ONE piece of company-wide data on the employee dashboard, and it
 * is worth being explicit about why it is allowed to be there when the
 * company's attendance is not. An asset figure is a fact about equipment: "we
 * own 125 things, 62 are out, 3 are being fixed". An attendance figure is a
 * fact about PEOPLE - in a small company "absent today: 1" beside a visibly
 * empty desk names a colleague - and that is the distinction the whole of this
 * change turns on. The asset manager's job is the first list; none of it is the
 * second.
 *
 * It renders itself away without `asset.read.all`, so it appears for the people
 * who run the register and for nobody else - an ordinary employee's dashboard
 * is unchanged, and their own kit is the card beside this one. The grant is the
 * same one the Asset dashboard and the register screen need, and the endpoint
 * re-checks it: `/assets/summary` counts the assets the caller's own filter
 * reaches, so a narrow reader asking for it directly is served their own laptop
 * rather than the company's stock.
 *
 * Deliberately four tiles and a link, not a second asset dashboard. The alerts,
 * the warranty expiries and the people pending clearance live one click away on
 * a page built for them; repeating them here would make the dashboard of the
 * person who runs the register a worse version of the register.
 */
export function AssetOperationsCard() {
  const { has } = usePermissions();
  const canReadAll = has(PERMISSIONS.ASSET_READ_ALL);

  const query = useQuery({
    queryKey: ['assets', 'summary'],
    queryFn: () => api.get<AssetSummary>('/assets/summary'),
    enabled: canReadAll,
    staleTime: 60_000,
    retry: false,
  });

  if (!canReadAll) return null;

  const summary = query.data;
  const loading = query.isLoading;
  const byStatus = summary?.byStatus;

  /*
   * "Needs attention" is the two statuses somebody has to do something about.
   * Lost and damaged are counted together because the action is the same -
   * open the register and look - and splitting them across two tiles would make
   * the row about the taxonomy rather than about the work.
   */
  const attention =
    byStatus === undefined ? undefined : byStatus.LOST + byStatus.DAMAGED;

  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Asset register</h2>
        <Button variant="outline" size="sm" asChild>
          <Link to="/assets/dashboard">Open asset dashboard</Link>
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total assets"
          value={summary?.total}
          icon={Boxes}
          loading={loading}
          to="/assets"
        />
        <StatCard
          label="Assigned"
          value={byStatus?.ASSIGNED}
          icon={CheckCircle2}
          tone="primary"
          hint="Out with an employee"
          loading={loading}
          to="/assets?status=ASSIGNED"
        />
        <StatCard
          label="Available"
          value={byStatus?.AVAILABLE}
          icon={PackageOpen}
          tone="success"
          hint="In stock, ready to issue"
          loading={loading}
          to="/assets?status=AVAILABLE"
        />
        <StatCard
          label="Under repair"
          value={byStatus?.UNDER_REPAIR}
          icon={Wrench}
          tone={byStatus && byStatus.UNDER_REPAIR > 0 ? 'warning' : 'default'}
          hint={
            attention !== undefined && attention > 0
              ? `${attention} lost or damaged as well`
              : 'Away being fixed'
          }
          loading={loading}
          to="/assets?status=UNDER_REPAIR"
        />
      </div>
    </div>
  );
}
