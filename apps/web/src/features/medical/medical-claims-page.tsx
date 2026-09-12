import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { HeartPulse, Plus } from 'lucide-react';
import {
  MEDICAL_CATEGORIES,
  MEDICAL_CATEGORY_LABELS,
  MEDICAL_CLAIM_STATUSES,
  MEDICAL_CLAIM_STATUS_LABELS,
  PERMISSIONS,
  type MedicalClaimRecord,
} from '@hrms/shared';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { useLookups } from '@/lib/lookups';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/field';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Pagination } from '@/components/ui/pagination';
import { TableSkeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePermissions } from '@/features/auth/session-context';
import { MEDICAL_CLAIM_STATUS_TONE, isoDay, money } from '@/features/employment/employment-shared';
import { MedicalClaimSubmitDialog } from './medical-claim-dialogs';
import { MedicalClaimDetailPanel } from './medical-claim-detail-panel';

/**
 * Medical claims, from both sides of the desk.
 *
 * One screen rather than two, for the same reason Loans is one screen: the data
 * scope already decides what somebody sees. An employee opens this and finds
 * their own claims; somebody who decides claims finds the company's. The `mine`
 * toggle exists for the people who can see both and want their own.
 *
 * Medical data makes that narrowing stricter than anywhere else in the product.
 * A wide data scope is NOT enough on its own here - the endpoint requires
 * `medical.manage` or `medical.claim.approve` on top of it before it will show
 * anybody else's claim. So a manager, whose scope reaches their reports, opens
 * this and still finds only their own: a reporting line is not a reason to see
 * what treatment somebody had.
 */

const INITIAL = {
  q: '',
  status: '',
  category: '',
  view: 'all' as 'all' | 'mine',
  page: 1,
  limit: 20,
};

export function MedicalClaimsPage() {
  const { has } = usePermissions();
  const canRequest = has(PERMISSIONS.MEDICAL_CLAIM_REQUEST);
  const canManage = has(PERMISSIONS.MEDICAL_MANAGE);
  /*
   * Whether the list can hold anybody else's claims at all. Deliberately the
   * same pair the endpoint calls "oversight" - holding one of these is what
   * makes the `mine` toggle and the employee column mean anything.
   */
  const hasOversight = canManage || has(PERMISSIONS.MEDICAL_CLAIM_APPROVE);

  const [filters, setFilters] = React.useState(INITIAL);
  const [submitting, setSubmitting] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [openClaimId, setOpenClaimId] = React.useState<string | null>(null);
  const debouncedQuery = useDebounced(filters.q, 350);

  const { lookups } = useLookups();

  const update = React.useCallback(
    (patch: Partial<typeof INITIAL>) =>
      setFilters((prev) => ({ ...prev, ...patch, ...('page' in patch ? {} : { page: 1 }) })),
    [],
  );

  const company = useQuery({
    queryKey: ['company'],
    queryFn: () => api.get<{ currency: string }>('/company'),
  });
  const currency = company.data?.currency ?? 'USD';

  const query = useQuery({
    queryKey: ['medical', 'claims', 'list', { ...filters, q: debouncedQuery }],
    queryFn: () =>
      api.getPage<MedicalClaimRecord>('/medical/claims', {
        query: {
          q: debouncedQuery || undefined,
          status: filters.status || undefined,
          category: filters.category || undefined,
          view: filters.view,
          page: filters.page,
          limit: filters.limit,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const hasActiveFilters =
    filters.q !== '' || filters.status !== '' || filters.category !== '' || filters.view !== 'all';

  const columns = hasOversight ? 7 : 6;

  return (
    <>
      <PageHeader
        title="Medical claims"
        description="Reimbursement for treatment, measured against the policy in force when the claim was submitted."
        actions={
          <div className="flex flex-wrap gap-2">
            {canRequest ? (
              <Button variant="outline" size="sm" onClick={() => setSubmitting(true)}>
                Submit a claim
              </Button>
            ) : null}
            {canManage ? (
              <Button size="sm" onClick={() => setRecording(true)}>
                <Plus className="size-4" aria-hidden />
                Record a claim
              </Button>
            ) : null}
          </div>
        }
      />

      <Card>
        <ListToolbar
          search={filters.q}
          onSearchChange={(q) => update({ q })}
          placeholder="Search by claim number, employee or provider"
          hasActiveFilters={hasActiveFilters}
          onReset={() => setFilters(INITIAL)}
          filters={
            <>
              <NativeSelect
                aria-label="Status"
                value={filters.status}
                onChange={(event) => update({ status: event.target.value })}
                className="xl:w-48"
              >
                <option value="">All statuses</option>
                {MEDICAL_CLAIM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {MEDICAL_CLAIM_STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="Treatment"
                value={filters.category}
                onChange={(event) => update({ category: event.target.value })}
                className="xl:w-48"
              >
                <option value="">All treatments</option>
                {MEDICAL_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {MEDICAL_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </NativeSelect>
              {hasOversight ? (
                <NativeSelect
                  aria-label="Whose claims"
                  value={filters.view}
                  onChange={(event) => update({ view: event.target.value as 'all' | 'mine' })}
                  className="xl:w-40"
                >
                  <option value="all">Everyone</option>
                  <option value="mine">Mine</option>
                </NativeSelect>
              ) : null}
            </>
          }
        />

        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Claim</TH>
                    {hasOversight ? <TH>Employee</TH> : null}
                    <TH>Treatment</TH>
                    <TH>Claimed</TH>
                    <TH>Agreed</TH>
                    <TH>Treated on</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {query.isLoading ? (
                    <TableSkeleton rows={5} columns={columns} />
                  ) : rows.length === 0 ? (
                    <TR className="hover:bg-transparent">
                      <TD colSpan={columns} className="p-0">
                        <EmptyState
                          icon={HeartPulse}
                          title={
                            hasActiveFilters ? 'No claims match those filters' : 'No claims yet'
                          }
                          description={
                            hasActiveFilters
                              ? 'Clear the filters to see everything.'
                              : canRequest
                                ? 'Submit one when you have paid for treatment and have the receipt.'
                                : 'Claims appear here once one is submitted.'
                          }
                        />
                      </TD>
                    </TR>
                  ) : (
                    rows.map((row) => (
                      <TR
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => setOpenClaimId(row.id)}
                      >
                        <TD>
                          <p className="font-mono text-[12.5px] font-medium">{row.claimNumber}</p>
                          {row.dependentName ? (
                            <p className="text-[11.5px] text-muted-foreground">
                              for {row.dependentName}
                            </p>
                          ) : null}
                        </TD>
                        {hasOversight ? (
                          <TD>
                            <p className="text-[13.5px] font-medium">{row.employeeName}</p>
                            <p className="font-mono text-[11.5px] text-muted-foreground">
                              {row.employeeNumber}
                            </p>
                          </TD>
                        ) : null}
                        <TD className="text-[13px]">{row.categoryLabel}</TD>
                        <TD className="tabular text-[13px]">
                          {money(row.requestedAmount, row.currency)}
                        </TD>
                        <TD className="tabular text-[13px]">
                          {row.approvedAmount === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <>
                              {money(row.approvedAmount, row.currency)}
                              {row.companyAmount !== null &&
                              row.companyAmount !== row.approvedAmount ? (
                                <span className="block text-[11px] text-muted-foreground">
                                  {money(row.companyAmount, row.currency)} from the company
                                </span>
                              ) : null}
                            </>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-muted-foreground">
                          {isoDay(row.treatmentDate)}
                        </TD>
                        <TD>
                          <Badge variant={MEDICAL_CLAIM_STATUS_TONE[row.status]}>
                            {MEDICAL_CLAIM_STATUS_LABELS[row.status]}
                          </Badge>
                        </TD>
                      </TR>
                    ))
                  )}
                </TBody>
              </Table>
            </TableWrapper>
            {meta ? <Pagination meta={meta} onPageChange={(page) => update({ page })} /> : null}
          </>
        )}
      </Card>

      {/* The claimant's own claim: no employee selector, and the endpoint takes
          no employee id from this form at all. */}
      <MedicalClaimSubmitDialog
        open={submitting}
        onClose={() => setSubmitting(false)}
        currency={currency}
      />
      {/* The administrative one, which can name an employee and - where the
          policy allows it - record a reason for an exception. */}
      {canManage ? (
        <MedicalClaimSubmitDialog
          open={recording}
          onClose={() => setRecording(false)}
          employees={lookups.managers}
          currency={currency}
        />
      ) : null}

      <Dialog open={openClaimId !== null} onOpenChange={(next) => !next && setOpenClaimId(null)}>
        <DialogContent variant="drawer" size="lg">
          <DialogHeader>
            <DialogTitle>Medical claim</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {openClaimId ? <MedicalClaimDetailPanel claimId={openClaimId} /> : null}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
