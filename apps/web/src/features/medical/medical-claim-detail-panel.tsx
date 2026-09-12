import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, BadgeCheck, Check, HeartPulse, Wallet, X } from 'lucide-react';
import {
  MEDICAL_CLAIM_DOCUMENT_LABELS,
  MEDICAL_CLAIM_STATUS_DESCRIPTIONS,
  MEDICAL_CLAIM_STATUS_LABELS,
  type MedicalClaimDetail,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { MEDICAL_CLAIM_STATUS_TONE, isoDay, money } from '@/features/employment/employment-shared';
import { formatDateTime } from '@/lib/utils';
import {
  MedicalClaimDecisionDialog,
  MedicalClaimPayDialog,
  MedicalClaimRejectDialog,
} from './medical-claim-dialogs';

/**
 * One claim in full, and every decision that can still be made about it.
 *
 * Which buttons appear is the server's answer, not this component's. `canDecide`,
 * `canCancel` and `canMarkPaid` arrive on the record already resolved from the
 * caller's permissions, the claim's status and whose claim it is - so a screen
 * cannot draw an action the endpoint would refuse, and cannot hide one it would
 * allow. Every endpoint behind them checks again regardless.
 *
 * The money is shown as three separate figures once a decision exists - claimed,
 * agreed, and the company's share of it - because they are three different
 * numbers and only the last one is what came out of the annual limit. Collapsing
 * them would hide either a reduction or a co-payment.
 */

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function MedicalClaimDetailPanel({ claimId }: { claimId: string }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [deciding, setDeciding] = React.useState(false);
  const [rejecting, setRejecting] = React.useState(false);
  const [paying, setPaying] = React.useState(false);

  const query = useQuery({
    queryKey: ['medical', 'claims', claimId],
    queryFn: () => api.get<MedicalClaimDetail>(`/medical/claims/${claimId}`),
    enabled: claimId !== '',
    retry: false,
  });

  const cancel = useMutation({
    mutationFn: (reason: string | null) =>
      api.post(`/medical/claims/${claimId}/cancel`, { reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medical'] });
      toast.success('Claim withdrawn', { description: 'Nothing was drawn from the limit.' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isPending) return <Skeleton className="h-64" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const claim = query.data;
  if (!claim) return null;

  const decided = claim.approvedAmount !== null;

  const handleCancel = async () => {
    const ok = await confirm({
      title: 'Withdraw this claim?',
      description:
        'It stops waiting for a decision and nothing is paid. A withdrawn claim cannot be reopened - a new one would have to be submitted.',
      confirmLabel: 'Withdraw claim',
      tone: 'destructive',
    });
    if (ok) cancel.mutate(null);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <HeartPulse className="size-4" aria-hidden />
            <span className="font-mono text-[13px]">{claim.claimNumber}</span>
            <Badge variant={MEDICAL_CLAIM_STATUS_TONE[claim.status]}>
              {MEDICAL_CLAIM_STATUS_LABELS[claim.status]}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {claim.canDecide ? (
              <>
                <Button size="sm" onClick={() => setDeciding(true)}>
                  <Check className="size-4" aria-hidden />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => setRejecting(true)}
                >
                  <X className="size-4" aria-hidden />
                  Decline
                </Button>
              </>
            ) : null}
            {claim.canMarkPaid ? (
              <Button size="sm" variant="outline" onClick={() => setPaying(true)}>
                <Wallet className="size-4" aria-hidden />
                Mark paid
              </Button>
            ) : null}
            {claim.canCancel ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                loading={cancel.isPending}
                onClick={() => void handleCancel()}
              >
                <Ban className="size-4" aria-hidden />
                Withdraw
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-[12.5px] text-muted-foreground">
            {MEDICAL_CLAIM_STATUS_DESCRIPTIONS[claim.status]}
          </p>

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Claimed</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(claim.requestedAmount, claim.currency)}
              </dd>
            </div>
            {decided ? (
              <>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">Agreed</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {money(claim.approvedAmount ?? 0, claim.currency)}
                  </dd>
                  {claim.approvedAmount !== null && claim.approvedAmount < claim.requestedAmount ? (
                    <dd className="text-[11px] text-muted-foreground">
                      Reduced by{' '}
                      {money(claim.requestedAmount - claim.approvedAmount, claim.currency)}
                    </dd>
                  ) : null}
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Company pays
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {money(claim.companyAmount ?? 0, claim.currency)}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    {claim.companyContributionPercent}% · the figure drawn from the limit
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Employee's share
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {money(claim.employeeAmount ?? 0, claim.currency)}
                  </dd>
                </div>
              </>
            ) : (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Would settle at
                </dt>
                <dd className="text-sm">
                  The company pays {claim.companyContributionPercent}% under the policy version
                  this claim was submitted against, whatever the current policy says.
                </dd>
              </div>
            )}
          </dl>

          <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Employee">
              {claim.employeeName}
              <span className="ml-1.5 font-mono text-[11.5px] text-muted-foreground">
                {claim.employeeNumber}
              </span>
            </Field>
            <Field label="Treatment">{claim.categoryLabel}</Field>
            <Field label="Who was treated">
              {claim.dependentName
                ? `${claim.dependentName} (${claim.dependentRelationship})`
                : 'The employee'}
            </Field>
            <Field label="Treatment date">{isoDay(claim.treatmentDate)}</Field>
            <Field label="Hospital or clinic">{claim.providerName ?? '—'}</Field>
            <Field label="Submitted">{formatDateTime(claim.submittedAt)}</Field>
            {claim.notes ? (
              <Field label="Notes" wide>
                {claim.notes}
              </Field>
            ) : null}
          </dl>

          {claim.decidedAt || claim.paidAt || claim.cancelledAt ? (
            <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-3">
              {claim.decidedAt ? (
                <Field label="Decided">
                  {formatDateTime(claim.decidedAt)}
                  {claim.reviewedByName ? (
                    <span className="block text-[11px] text-muted-foreground">
                      by {claim.reviewedByName}
                    </span>
                  ) : null}
                </Field>
              ) : null}
              {claim.paidAt ? (
                <Field label="Paid">
                  {formatDateTime(claim.paidAt)}
                  {claim.paymentReference ? (
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {claim.paymentReference}
                    </span>
                  ) : null}
                </Field>
              ) : null}
              {claim.cancelledAt ? (
                <Field label="Withdrawn">{formatDateTime(claim.cancelledAt)}</Field>
              ) : null}
              {claim.decisionNote ? (
                <Field label="Note from the reviewer" wide>
                  {claim.decisionNote}
                </Field>
              ) : null}
              {claim.rejectionReason ? (
                <Field label="Why it was declined" wide>
                  {claim.rejectionReason}
                </Field>
              ) : null}
              {/* Withheld from the claimant by the API, so this renders only for
                  a reviewer: an exception made in somebody's favour is a note
                  between the reviewer and the audit trail. */}
              {claim.overrideReason ? (
                <Field label="Allowed through because" wide>
                  <span className="flex items-start gap-1.5">
                    <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" aria-hidden />
                    {claim.overrideReason}
                  </span>
                </Field>
              ) : null}
            </dl>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supporting documents</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {claim.documents.length === 0 ? (
            <EmptyState
              title="No documents recorded"
              description="The policy in force did not require any, or none were entered."
            />
          ) : (
            <TableWrapper>
              <Table>
                <THead>
                  <TR>
                    <TH>Document</TH>
                    <TH>Reference</TH>
                    <TH>Note</TH>
                  </TR>
                </THead>
                <TBody>
                  {claim.documents.map((doc) => (
                    <TR key={doc.id}>
                      <TD className="whitespace-nowrap font-medium">
                        {MEDICAL_CLAIM_DOCUMENT_LABELS[doc.type]}
                      </TD>
                      <TD className="font-mono text-[12.5px]">{doc.reference}</TD>
                      <TD className="text-muted-foreground">{doc.note ?? '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrapper>
          )}
        </CardContent>
      </Card>

      <MedicalClaimDecisionDialog
        claim={claim}
        open={deciding}
        onClose={() => setDeciding(false)}
        companyContributionPercent={claim.companyContributionPercent}
      />
      <MedicalClaimRejectDialog
        claim={claim}
        open={rejecting}
        onClose={() => setRejecting(false)}
      />
      <MedicalClaimPayDialog claim={claim} open={paying} onClose={() => setPaying(false)} />
    </div>
  );
}
