import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Check, HandCoins, X } from 'lucide-react';
import {
  LOAN_INSTALLMENT_STATUS_LABELS,
  LOAN_STATUS_DESCRIPTIONS,
  LOAN_STATUS_LABELS,
  PERMISSIONS,
  type LoanDetail,
} from '@hrms/shared';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TBody, TD, TH, THead, TR, Table, TableWrapper } from '@/components/ui/table';
import { useConfirm } from '@/components/feedback/confirm-dialog';
import { usePermissions } from '@/features/auth/session-context';
import {
  LOAN_INSTALLMENT_TONE,
  LOAN_STATUS_TONE,
  isoMonth,
  money,
} from '@/features/employment/employment-shared';
import { formatDateTime } from '@/lib/utils';

/**
 * One loan in full: the terms, what is left, and every installment.
 *
 * The repayment table is the payment history and the schedule at once, because
 * they are the same rows read at different times. Splitting them into a
 * "schedule" and a "history" would mean maintaining two views of one truth,
 * and they would eventually disagree.
 */
export function LoanDetailPanel({ loanId }: { loanId: string }) {
  const { has } = usePermissions();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const canManage = has(PERMISSIONS.LOAN_MANAGE);

  const query = useQuery({
    queryKey: ['loans', loanId],
    queryFn: () => api.get<LoanDetail>(`/loans/${loanId}`),
    enabled: loanId !== '',
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const approve = useMutation({
    mutationFn: (activate: boolean) => api.post(`/loans/${loanId}/approve`, { activate }),
    onSuccess: async (_data, activate) => {
      await invalidate();
      toast.success(activate ? 'Loan approved and released' : 'Loan approved', {
        description: activate
          ? 'Payroll will collect the installment due in each period.'
          : 'Release it when the money is handed over; nothing is deducted until then.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: (reason: string) => api.post(`/loans/${loanId}/reject`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Application declined');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const activate = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/activate`),
    onSuccess: async () => {
      await invalidate();
      toast.success('Loan released', { description: 'Repayment starts from the first deduction month.' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const cancel = useMutation({
    mutationFn: (reason: string | null) => api.post(`/loans/${loanId}/cancel`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Loan cancelled', {
        description: 'Installments already collected are unchanged; nothing further is deducted.',
      });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const waive = useMutation({
    mutationFn: (installmentId: string) =>
      api.post(`/loans/${loanId}/installments/${installmentId}/waive`, {}),
    onSuccess: async () => {
      await invalidate();
      toast.success('Installment waived');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (query.isLoading) return <Skeleton className="h-64" />;

  const loan = query.data;
  if (!loan) return null;

  const collecting = loan.installments.find((row) => row.status === 'PENDING_PAYROLL') ?? null;

  const repaidPercent =
    loan.principalAmount > 0
      ? Math.min(100, Math.round((loan.paidAmount / loan.principalAmount) * 100))
      : 0;

  const handleReject = async () => {
    const reason = window.prompt('Why is the application being declined?');
    if (reason && reason.trim().length >= 3) reject.mutate(reason.trim());
  };

  const handleCancel = async () => {
    const ok = await confirm({
      title: `Cancel this loan?`,
      description:
        'Future deductions stop. Installments already collected are kept exactly as they are.',
      confirmLabel: 'Cancel loan',
      tone: 'destructive',
    });
    if (ok) cancel.mutate(null);
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="size-4" aria-hidden />
            {loan.employeeName}
            <Badge variant={LOAN_STATUS_TONE[loan.status]}>{LOAN_STATUS_LABELS[loan.status]}</Badge>
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {loan.canApprove ? (
              <>
                <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate(true)}>
                  <Check className="size-4" aria-hidden />
                  Approve and release
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate(false)}
                >
                  Approve only
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  loading={reject.isPending}
                  onClick={() => void handleReject()}
                >
                  <X className="size-4" aria-hidden />
                  Decline
                </Button>
              </>
            ) : null}
            {canManage && loan.status === 'APPROVED' ? (
              <Button size="sm" loading={activate.isPending} onClick={() => activate.mutate()}>
                Release
              </Button>
            ) : null}
            {loan.canCancel ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                loading={cancel.isPending}
                onClick={() => void handleCancel()}
              >
                <Ban className="size-4" aria-hidden />
                {loan.status === 'PENDING' ? 'Withdraw' : 'Cancel'}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-[12.5px] text-muted-foreground">
            {LOAN_STATUS_DESCRIPTIONS[loan.status]}
          </p>

          {collecting ? (
            <p className="rounded-md bg-accent/50 px-3 py-2 text-[12.5px]">
              Installment {collecting.sequence} of {loan.installmentCount} (
              {money(collecting.amount, loan.currency)}) is in an unfinalized payroll run for{' '}
              {isoMonth(collecting.dueMonth)}. It counts as repaid once that run is finalized.
            </p>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Loan amount</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.principalAmount, loan.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Repaid</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.paidAmount, loan.currency)}
              </dd>
              <dd className="text-[11px] text-muted-foreground">
                {loan.paidInstallments} of {loan.installmentCount} installments ·{' '}
                {loan.installmentCount - loan.paidInstallments} left
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Remaining</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.remainingAmount, loan.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Monthly deduction
              </dt>
              <dd className="text-lg font-semibold tabular-nums">
                {money(loan.monthlyDeduction, loan.currency)}
              </dd>
              <dd className="text-[11px] text-muted-foreground">
                {loan.nextDueMonth ? `Next due ${isoMonth(loan.nextDueMonth)}` : 'Nothing outstanding'}
              </dd>
            </div>
          </dl>

          <div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={repaidPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Repayment progress"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${repaidPercent}%` }} />
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">{repaidPercent}% repaid</p>
          </div>

          <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                First deduction
              </dt>
              <dd className="text-sm font-medium">{isoMonth(loan.startMonth)}</dd>
            </div>
            {loan.activatedAt ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Released</dt>
                <dd className="text-sm">{formatDateTime(loan.activatedAt)}</dd>
              </div>
            ) : null}
            {loan.reference ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Reference</dt>
                <dd className="font-mono text-sm">{loan.reference}</dd>
              </div>
            ) : null}
            {loan.purpose ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Purpose</dt>
                <dd className="text-sm">{loan.purpose}</dd>
              </div>
            ) : null}
            {loan.approvedAt ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Approved</dt>
                <dd className="text-sm">{formatDateTime(loan.approvedAt)}</dd>
              </div>
            ) : null}
            {loan.rejectionReason ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Declined</dt>
                <dd className="text-sm">{loan.rejectionReason}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Repayment schedule and history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <TableWrapper>
            <Table>
              <THead>
                <TR>
                  <TH>#</TH>
                  <TH>Due</TH>
                  <TH>Amount</TH>
                  <TH>Status</TH>
                  <TH>Collected</TH>
                  <TH>Note</TH>
                  {canManage ? <TH className="text-right">Actions</TH> : null}
                </TR>
              </THead>
              <TBody>
                {loan.installments.map((row) => (
                  <TR key={row.id}>
                    <TD className="tabular-nums text-muted-foreground">{row.sequence}</TD>
                    <TD className="whitespace-nowrap font-medium">{isoMonth(row.dueMonth)}</TD>
                    <TD className="tabular-nums">{money(row.amount, loan.currency)}</TD>
                    <TD>
                      <Badge variant={LOAN_INSTALLMENT_TONE[row.status]}>
                        {LOAN_INSTALLMENT_STATUS_LABELS[row.status]}
                      </Badge>
                    </TD>
                    <TD className="whitespace-nowrap text-muted-foreground">
                      {row.paidAt ? formatDateTime(row.paidAt) : '—'}
                    </TD>
                    <TD className="max-w-[16rem] truncate text-muted-foreground" title={row.note ?? ''}>
                      {row.note ?? '—'}
                    </TD>
                    {canManage ? (
                      <TD className="text-right">
                        {row.status === 'SCHEDULED' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={waive.isPending}
                            onClick={() => waive.mutate(row.id)}
                          >
                            Waive
                          </Button>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        </CardContent>
      </Card>
    </div>
  );
}
